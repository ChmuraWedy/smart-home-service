import json
import socket
import struct
import threading
from dataclasses import replace

import pytest
from fastapi import HTTPException

from smarthome.network import LEASE_SECONDS, MAX_SECONDS, NetworkMonitor
from smarthome.network_discovery import (
    MAX_DEVICES,
    MAX_EVENTS,
    dns_name,
    mdns,
    parse_neighbors,
    ssdp,
)
from tests.test_capture_tuya import datagram

API = "/api/v1/network/scans"


@pytest.fixture
def monitor(monkeypatch):
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: None)
    item = NetworkMonitor()
    yield item
    item.close()


def name(value):
    return (
        b"".join(bytes([len(label.encode())]) + label.encode() for label in value.split("."))
        + b"\0"
    )


def record(owner, kind, payload):
    return name(owner) + struct.pack("!HHIH", kind, 1, 120, len(payload)) + payload


def mdns_packet(address="192.168.1.20"):
    records = [
        record("_hap._tcp.local", 12, name("My home._hap._tcp.local")),
        record("My home._hap._tcp.local", 16, b"password=private-token"),
        record("sensor.local", 1, socket.inet_aton(address)),
    ]
    return struct.pack("!6H", 0, 0x8400, 0, len(records), 0, 0) + b"".join(records)


def test_standalone_page_never_queries_cloud_or_inventory_and_is_authenticated(client, monkeypatch):
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: None)

    def forbidden(*args, **kwargs):
        raise AssertionError("Network page must not use a cloud account")

    monkeypatch.setattr("smarthome.network.cloud_bridge", forbidden)
    monkeypatch.setattr(
        "smarthome.network.network_interfaces",
        lambda: [
            {
                "name": "en1",
                "address": "192.168.1.10",
                "network": "192.168.1.0/24",
                "broadcast": "192.168.1.255",
            }
        ],
    )
    response = client.post(API, json={"interface_address": "192.168.1.10"})
    assert response.status_code == 201 and response.headers["cache-control"] == "no-store"
    scan_id = response.json()["scan_id"]
    path = f"{API}/{scan_id}"
    client.app.state.network.ingest(
        datagram(
            {"gwId": "gw-real", "version": "3.5", "local_key": "secret", "ip": "192.168.1.99"}
        ),
        "192.168.1.20",
    )
    result = client.get(path)
    assert result.json()["devices"][0]["ip"] == "192.168.1.20"
    assert "secret" not in result.text and "provider" not in result.text
    assert client.get("/api/v1/devices").json() == []
    client.app.state.settings = replace(client.app.state.settings, api_token="required")
    for method, url in (
        ("post", API),
        ("get", path),
        ("post", path + "/discover"),
        ("delete", path),
    ):
        assert getattr(client, method)(url).status_code == 401
    assert client.delete(path, headers={"X-API-Key": "required"}).status_code == 204
    assert client.get(path, headers={"X-API-Key": "required"}).status_code == 404


def test_parser_retains_service_types_and_matching_source_hostname_not_txt_or_claimed_ip():
    result = mdns(mdns_packet(), "192.168.1.20")
    assert result == {"services": ["_hap._tcp.local"], "hostname": "sensor.local"}
    assert "private-token" not in json.dumps(result) and "My home" not in json.dumps(result)
    assert mdns(mdns_packet(), "192.168.1.30")["hostname"] is None
    packet = b"NOTIFY * HTTP/1.1\r\nNT: urn:schemas-upnp-org:device:MediaRenderer:1\r\nLOCATION: http://secret/?token=private-token\r\n\r\n"
    assert ssdp(packet) == {
        "services": ["urn:schemas-upnp-org:device:mediarenderer:1"],
        "hostname": None,
    }
    assert ssdp(packet.replace(b"NOTIFY * HTTP/1.1", b"M-SEARCH * HTTP/1.1")) is None


@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"bad",
        b"x" * 20000,
        struct.pack("!6H", 0, 0x8000, 0, 300, 0, 0),
        struct.pack("!6H", 0, 0x8000, 0, 1, 0, 0) + b"\xc0\x0c",
    ],
)
def test_malformed_dns_is_bounded_and_ignored(payload):
    assert mdns(payload, "192.168.1.20") is None


def test_dns_compressed_name_and_pointer_cycle():
    packet = name("_http._tcp.local") + b"\xc0\x00"
    assert dns_name(packet, len(packet) - 2) == ("_http._tcp.local", len(packet))
    with pytest.raises(ValueError):
        dns_name(b"\xc0\x00", 0)


def test_merge_observed_protocols_keep_actual_ids_and_track_address_changes(monitor):
    scan_id = monitor.start_scan()["scan_id"]
    monitor.ingest_neighbors([{"ip": "192.168.1.20", "mac": "a4:c1:38:11:22:33"}], True)
    monitor.ingest(mdns_packet(), "192.168.1.20", 5353)
    monitor.ingest(datagram({"gwId": "gateway", "version": "3.5"}), "192.168.1.20", 7000)
    row = monitor.read_scan(scan_id)["devices"][0]
    assert row["protocols"] == ["arp", "mdns", "tuya"]
    assert row["device_id"] == "gateway" and row["mac"] == "a4:c1:38:11:22:33"
    assert row["hostname"] == "sensor.local" and row["packets"] == 2
    monitor.ingest(datagram({"gwId": "gateway", "version": "3.5"}), "192.168.1.30", 7000)
    result = monitor.read_scan(scan_id)
    row = result["devices"][0]
    assert row["changes"][0]["previous_ip"] == "192.168.1.20"
    assert row["mac"] is None and row["hostname"] is None and row["services"] == []
    assert result["packets"] == result["recognized_packets"] == 3
    assert "identity" not in row and "children" not in result
    row["changes"].clear()
    assert monitor.read_scan(scan_id)["devices"][0]["changes"]  # Immutable snapshot.


def test_neighbor_cache_never_claims_packets_or_identity(monitor):
    scan_id = monitor.start_scan()["scan_id"]
    monitor.ingest_neighbors([{"ip": "192.168.1.1", "mac": "a4:c1:38:11:22:33"}], True)
    result = monitor.read_scan(scan_id)
    row = result["devices"][0]
    assert row["packets"] == result["packets"] == 0
    assert row["last_seen"] is None and row["device_id"] is None
    assert row["protocols"] == ["arp"]


def test_neighbors_normalize_mac_ignore_multicast_public_and_incomplete_rows():
    text = "? (192.168.1.1) at a4:c1:38:1:2:3 on en0\n? (192.168.1.2) at (incomplete) on en0\n? (8.8.8.8) at a4:c1:38:1:2:4 on en0\n? (192.168.1.3) at ff:ff:ff:ff:ff:ff on en0"
    assert parse_neighbors(text) == [{"ip": "192.168.1.1", "mac": "a4:c1:38:01:02:03"}]
    linux = "IP address HW type Flags HW address Mask Device\n192.168.1.1 0x1 0x2 a4:c1:38:01:02:03 * eth0\n192.168.1.2 0x1 0x0 00:00:00:00:00:00 * eth0"
    assert parse_neighbors(linux, linux=True) == parse_neighbors(text)


def test_session_lifecycle_capacity_and_packet_limits(monitor, monkeypatch):
    now = [1000]
    monkeypatch.setattr("smarthome.network.time.monotonic", lambda: now[0])
    scan_id = monitor.start_scan()["scan_id"]
    for i in range(MAX_DEVICES + 10):
        monitor.ingest(datagram({"gwId": "device-" + str(i)}), "192.168.1.20")
    result = monitor.read_scan(scan_id)
    assert len(result["devices"]) == MAX_DEVICES and result["truncated"]
    assert len(result["events"]) == MAX_EVENTS
    monitor.ingest(b"secret", "8.8.8.8")
    monitor.ingest(b"x" * 20000, "192.168.1.20")
    assert monitor.read_scan(scan_id)["packets"] == result["packets"]
    for _ in range(3):
        monitor.start_scan()
    with pytest.raises(HTTPException) as error:
        monitor.start_scan()
    assert error.value.status_code == 503
    now[0] += LEASE_SECONDS + 1
    with pytest.raises(HTTPException):
        monitor.read_scan(scan_id)
    scan_id = monitor.start_scan()["scan_id"]
    for _ in range(89):
        now[0] += 10
        monitor.read_scan(scan_id)
    now[0] += 11
    with pytest.raises(HTTPException):
        monitor.read_scan(scan_id)
    assert MAX_SECONDS == 900


def test_discovery_is_explicit_throttled_and_requires_a_live_session(monitor, monkeypatch):
    requests = []
    monkeypatch.setattr(
        "smarthome.network.request_tuya_announcements", lambda: requests.append(True) or True
    )
    scan_id = monitor.start_scan()["scan_id"]
    assert requests == []
    with pytest.raises(HTTPException):
        monitor.request_announcements(scan_id)
    monitor.ports = [7000]
    assert monitor.request_announcements(scan_id)["discovery_requests"] == 1
    with pytest.raises(HTTPException) as error:
        monitor.request_announcements(scan_id)
    assert error.value.status_code == 429 and requests == [True]
    monitor.remove_scan(scan_id)
    with pytest.raises(HTTPException):
        monitor.request_announcements(scan_id)
    assert requests == [True]


def test_global_and_card_observations_share_sockets_and_release_extra_ports(monkeypatch):
    sockets = []

    class Listener:
        def __init__(self, *args):
            self.port, self.closed = None, False
            sockets.append(self)

        def setsockopt(self, *args):
            pass

        def bind(self, address):
            self.port = address[1]

        def close(self):
            self.closed = True

    def idle(*args):
        threading.Event().wait(0.01)
        return [], [], []

    monkeypatch.setattr("smarthome.network.socket.socket", Listener)
    monkeypatch.setattr("smarthome.network.select.select", idle)
    monkeypatch.setattr("smarthome.network.neighbors", lambda: ([], True))
    monitor = NetworkMonitor()

    def wait_for(condition):
        for _ in range(200):
            if condition():
                return
            threading.Event().wait(0.01)
        pytest.fail("Listener did not reach expected state")

    try:
        card = monitor.start("device", "device", "direct", None)
        scan = monitor.start_scan()
        wait_for(lambda: len(monitor.ports) == 5)
        assert len(sockets) == 5
        monitor.remove_scan(scan["scan_id"])
        wait_for(lambda: monitor.ports == [6666, 6667, 7000])
        assert all(channel.closed for channel in sockets if channel.port in (1900, 5353))
        monitor.remove(card["watch_id"])
        wait_for(lambda: not monitor.ports)
        assert all(channel.closed for channel in sockets)
    finally:
        monitor.close()


def test_current_ip_neighbors_survive_a_tuya_address_change(monitor):
    scan_id = monitor.start_scan()["scan_id"]
    monitor.ingest(datagram({"gwId": "same-device"}), "192.168.1.10")
    monitor.ingest_neighbors([{"ip": "192.168.1.20", "mac": "00:11:22:33:44:55"}], True)
    monitor.ingest(mdns_packet(), "192.168.1.20", 5353)
    monitor.ingest(datagram({"gwId": "same-device"}), "192.168.1.20")
    result = monitor.read_scan(scan_id)["devices"]
    assert len(result) == 1
    assert result[0]["mac"] == "00:11:22:33:44:55"
    assert result[0]["hostname"] == "sensor.local"
    assert result[0]["changes"][0]["previous_ip"] == "192.168.1.10"


def test_linux_permanent_complete_neighbors_and_malformed_flags():
    assert parse_neighbors("192.168.1.1 0x1 0x6 00:11:22:33:44:55 * eth0", linux=True)
    assert not parse_neighbors("192.168.1.1 0x1 nope 00:11:22:33:44:55 * eth0", linux=True)


def test_discovery_helper_sends_standard_request_only_on_private_interfaces(monkeypatch):
    import tinytuya
    from tinytuya import scanner

    from smarthome.network_discovery import request_tuya_announcements

    sockets, sent = [], []
    failure = [False]

    class Channel:
        def __init__(self, *args):
            self.bound = None
            self.closed = False
            sockets.append(self)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.closed = True

        def settimeout(self, seconds):
            pass

        def setsockopt(self, *args):
            pass

        def bind(self, address):
            self.bound = address

        def sendto(self, payload, destination):
            if failure[0]:
                raise OSError()
            sent.append((payload, destination))

    monkeypatch.setattr(
        scanner,
        "get_ip_to_broadcast",
        lambda: {
            "192.168.1.255": "192.168.1.10",
            "8.8.8.255": "8.8.8.8",
            "8.8.8.254": "192.168.2.10",
        },
    )
    monkeypatch.setattr("smarthome.network_discovery.socket.socket", Channel)
    assert request_tuya_announcements()
    assert len(sockets) == 1 and sockets[0].bound == ("192.168.1.10", 0)
    assert all(channel.closed for channel in sockets)
    assert sent[0][1] == ("192.168.1.255", 7000)
    message = tinytuya.unpack_message(sent[0][0], hmac_key=tinytuya.udpkey, no_retcode=True)
    assert message.cmd == tinytuya.REQ_DEVINFO
    assert json.loads(message.payload) == {"from": "app", "ip": "192.168.1.10"}
    failure[0] = True
    assert not request_tuya_announcements()
    assert all(channel.closed for channel in sockets)


def test_selected_network_excludes_other_interfaces_packets_and_neighbors(monitor, monkeypatch):
    interface = {
        "name": "en1",
        "address": "192.168.40.147",
        "network": "192.168.40.0/24",
        "broadcast": "192.168.40.255",
    }
    scan_id = monitor.start_scan(interface)["scan_id"]
    monitor.ingest(datagram({"gwId": "wrong-network"}), "192.168.20.10")
    monitor.ingest(datagram({"gwId": "right-network"}), "192.168.40.10")
    monitor.ingest_neighbors(
        [
            {"ip": "192.168.20.10", "mac": "00:11:22:33:44:55"},
            {"ip": "192.168.40.10", "mac": "00:11:22:33:44:66"},
        ],
        True,
    )
    result = monitor.read_scan(scan_id)
    assert result["interface"] == interface
    assert result["packets"] == 1
    assert len(result["devices"]) == 1
    assert result["devices"][0]["device_id"] == "right-network"
    assert result["devices"][0]["mac"] == "00:11:22:33:44:66"
    sent = []
    monkeypatch.setattr(
        "smarthome.network.request_tuya_announcements", lambda target: sent.append(target) or True
    )
    monitor.ports = [7000]
    monitor.request_announcements(scan_id)
    assert sent == [interface]


def test_actual_interface_prefixes_are_read_without_guessing():
    from smarthome.network_discovery import parse_interfaces

    mac = "en0: flags=\n\tinet 192.168.20.20 netmask 0xffffff00 broadcast 192.168.20.255\nen1: flags=\n\tinet 192.168.40.147 netmask 0xffffff80 broadcast 192.168.40.255\nlo0: flags=\n\tinet 127.0.0.1 netmask 0xff000000"
    rows = parse_interfaces(mac, "Darwin")
    assert [row["network"] for row in rows] == ["192.168.20.0/24", "192.168.40.128/25"]
    linux = json.dumps(
        [
            {
                "ifname": "eth0",
                "addr_info": [{"family": "inet", "local": "10.20.3.4", "prefixlen": 16}],
            }
        ]
    )
    assert parse_interfaces(linux, "Linux")[0]["broadcast"] == "10.20.255.255"
    windows = json.dumps(
        {"InterfaceAlias": "Ethernet", "IPAddress": "172.20.3.4", "PrefixLength": 20}
    )
    assert parse_interfaces(windows, "Windows")[0]["network"] == "172.20.0.0/20"
    assert not parse_interfaces("malformed", "Linux")


def test_scan_requires_an_available_network_and_interface_inventory_is_authenticated(
    client, monkeypatch
):
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: None)
    monkeypatch.setattr("smarthome.network.network_interfaces", lambda: [])
    assert client.post(API, json={}).status_code == 422
    assert client.post(API, json={"interface_address": "192.168.40.147"}).status_code == 409
    assert not client.app.state.network.scans
    client.app.state.settings = replace(client.app.state.settings, api_token="required")
    assert client.get("/api/v1/network/interfaces").status_code == 401
    response = client.get("/api/v1/network/interfaces", headers={"X-API-Key": "required"})
    assert response.status_code == 200 and response.json() == []
    assert response.headers["cache-control"] == "no-store"
