from dataclasses import replace

import pytest
from fastapi import HTTPException

from smarthome.network import NetworkMonitor, discovery
from tests.test_capture_tuya import datagram


@pytest.mark.parametrize("kind", ["plain", "ecb", "gcm"])
def test_only_allowlisted_discovery_metadata_is_retained(kind, monkeypatch):
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: None)
    monitor = NetworkMonitor()
    watch = monitor.start("device", "device", "direct", "192.168.1.10")
    packet = datagram(
        {"gwId": "device", "ip": "192.168.1.99", "version": "3.5", "token": "secret"}, kind
    )
    monitor.ingest(packet, "192.168.1.20")
    monitor.ingest(packet, "192.168.1.20")
    monitor.ingest(datagram({"gwId": "other"}), "192.168.1.21")
    monitor.ingest(packet, "192.168.1.30")
    result = monitor.read(watch["watch_id"])
    assert result["observed_ip"] == "192.168.1.30"  # Sender address, not claimed payload IP.
    assert result["packets"] == 3 and len(result["changes"]) == 2
    assert result["changes"][-1]["previous_ip"] == "192.168.1.20"
    assert result["configured_ip"] == "192.168.1.10"
    assert "secret" not in str(result) and "token" not in str(result)
    monitor.close()


@pytest.mark.parametrize(
    "packet, address",
    [
        (b"bad", "192.168.1.20"),
        (datagram(["invalid"]), "192.168.1.20"),
        (datagram({"gwId": "device"}), "8.8.8.8"),
        (datagram({"gwId": "device"}), "127.0.0.1"),
        (datagram({"gwId": 42}), "192.168.1.20"),
    ],
)
def test_unusable_discovery_is_ignored(packet, address):
    assert discovery(packet, address) is None


def test_lease_expires_and_renewal_cannot_extend_hard_limit(monkeypatch):
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: None)
    clock = [1000]
    monkeypatch.setattr("smarthome.network.time.monotonic", lambda: clock[0])
    monitor = NetworkMonitor()
    watch = monitor.start("device", "device", "direct", None)["watch_id"]
    clock[0] += 16
    with pytest.raises(HTTPException) as error:
        monitor.read(watch)
    assert error.value.status_code == 404
    watch = monitor.start("device", "device", "direct", None)["watch_id"]
    for _ in range(89):
        clock[0] += 10
        monitor.read(watch)
    clock[0] += 11
    with pytest.raises(HTTPException):
        monitor.read(watch)
    monitor.close()


def test_local_route_tracks_actual_parent_and_never_changes_inventory(
    client, child, gateway, monkeypatch
):
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: None)
    response = client.post(f"/api/v1/network/devices/{child['device_id']}/watch?provider=local")
    assert response.status_code == 200, response.text
    watch = response.json()
    assert watch["route"] == "gateway" and watch["target_id"] == gateway["device_id"]
    client.app.state.network.ingest(datagram({"gwId": gateway["device_id"]}), "192.168.1.50")
    path = f"/api/v1/network/watches/{watch['watch_id']}"
    assert client.get(path).json()["observed_ip"] == "192.168.1.50"
    assert client.get(f"/api/v1/devices/{gateway['id']}").json()["ip"] == gateway["ip"]
    assert client.delete(path).status_code == 204
    assert client.get(path).status_code == 404
    assert client.post("/api/v1/network/devices/missing/watch?provider=local").status_code == 404
    client.app.state.settings = replace(client.app.state.settings, api_token="required")
    assert (
        client.post(
            f"/api/v1/network/devices/{child['device_id']}/watch?provider=local"
        ).status_code
        == 401
    )
    assert client.get(path).status_code == 401
    assert client.delete(path).status_code == 401


def test_cloud_gateway_is_not_guessed_from_names_or_udp_packets(client, gateway, monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: None)
    cloud_device = SimpleNamespace(sub=True)
    bridge = SimpleNamespace(device=lambda identifier: cloud_device)
    monkeypatch.setattr("smarthome.network.cloud_bridge", lambda *args: bridge)
    path = "/api/v1/network/devices/cloud-child/watch?provider=sharing"
    assert client.post(path).status_code == 409
    assert not client.app.state.network.watches
    cloud_device.gateway_id = gateway["device_id"]
    result = client.post(path).json()
    assert result["target_id"] == gateway["device_id"] and result["route"] == "gateway"
    cloud_device.sub = False
    result = client.post(path).json()
    assert result["target_id"] == "cloud-child" and result["route"] == "direct"


def test_listener_opens_only_discovery_ports_and_releases_sockets(monkeypatch):
    import threading

    from smarthome.network import PORTS

    listeners = []
    bound = threading.Event()
    released = threading.Event()

    class Listener:
        def __init__(self, *args):
            self.port = None
            self.closed = False
            listeners.append(self)

        def setsockopt(self, *args):
            pass

        def bind(self, address):
            self.port = address[1]
            if self.port == 7000:
                raise OSError("occupied")
            if self.port == 6667:
                bound.set()

        def close(self):
            self.closed = True
            if all(listener.closed for listener in listeners):
                released.set()

    def idle_select(*args):
        threading.Event().wait(0.01)
        return [], [], []

    monkeypatch.setattr("smarthome.network.socket.socket", Listener)
    monkeypatch.setattr("smarthome.network.select.select", idle_select)
    monitor = NetworkMonitor()
    watch = monitor.start("device", "device", "direct", None)
    try:
        assert bound.wait(1)
        status = monitor.read(watch["watch_id"])
        assert status["ports"] == [6666, 6667] and status["failed_ports"] == [7000]
        assert tuple(listener.port for listener in listeners) == PORTS
        monitor.remove(watch["watch_id"])
        assert released.wait(1)
        assert all(listener.closed for listener in listeners)
        # No socket exposes send/sendto: discovery never probes devices.
    finally:
        monitor.close()
    assert not monitor.thread.is_alive()


def test_global_announcements_are_available_before_cards_open_and_reads_are_passive(
    client, child, gateway, factory, monkeypatch
):
    starts = []
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: starts.append(True))
    monitor = client.app.state.network
    monitor.start_global()
    monitor.thread.join(timeout=1)
    monitor.ingest(
        datagram({"gwId": gateway["device_id"], "version": "3.5", "token": "secret"}),
        "192.168.1.50",
    )
    path = f"/api/v1/network/devices/{child['device_id']}/observation?provider=local"
    response = client.get(path)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    snapshot = response.json()
    assert snapshot["target_id"] == gateway["device_id"] and snapshot["route"] == "gateway"
    assert snapshot["observed_ip"] == "192.168.1.50" and snapshot["packets"] == 1
    assert snapshot["enabled"] and "secret" not in response.text
    monitor.ingest(datagram({"gwId": gateway["device_id"]}), "192.168.1.51")
    snapshot = client.get(path).json()
    assert snapshot["changes"][-1]["previous_ip"] == "192.168.1.50"
    snapshot["changes"].clear()
    assert client.get(path).json()["changes"]
    assert not monitor.watches and not monitor.scans and starts == [True]
    assert not factory.commands
    assert client.get(f"/api/v1/devices/{gateway['id']}").json()["ip"] == gateway["ip"]
    client.app.state.settings = replace(client.app.state.settings, api_token="required")
    assert client.get(path).status_code == 401


def test_global_cache_is_bounded_recent_and_keeps_only_announcement_metadata(monkeypatch):
    from smarthome.network_discovery import MAX_DEVICES

    monitor = NetworkMonitor()
    for i in range(MAX_DEVICES):
        monitor.ingest(
            datagram(
                {"gwId": f"device-{i}", "local_key": "never-retain", "status": {"switch": True}}
            ),
            "192.168.1.20",
        )
    monitor.ingest(datagram({"gwId": "device-0"}), "192.168.1.21")
    monitor.ingest(datagram({"gwId": "new-device"}), "192.168.1.22")
    assert len(monitor.observations) == MAX_DEVICES
    assert "tuya:device-0" in monitor.observations and "tuya:device-1" not in monitor.observations
    assert "never-retain" not in str(monitor.observations) and "switch" not in str(
        monitor.observations
    )
    for i in range(30):
        monitor.ingest(datagram({"gwId": "new-device"}), f"192.168.1.{30 + i}")
    row = monitor.observation("new-device", "new-device", "direct", None)
    assert len(row["changes"]) == 20
    monitor.close()


def test_application_starts_global_receiver_and_closes_it(tmp_path, monkeypatch):
    import threading

    from fastapi.testclient import TestClient

    from smarthome.config import Settings
    from smarthome.main import create_app

    started = threading.Event()
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: started.set())
    monkeypatch.delenv("SMART_HOME_NETWORK_MONITOR_ENABLED", raising=False)
    settings = Settings(database_path=str(tmp_path / "global.db"), display_poll_interval=0)
    assert settings.network_monitor_enabled
    with TestClient(create_app(settings)) as client:
        monitor = client.app.state.network
        assert started.wait(timeout=1) and monitor.global_enabled
    assert monitor.closed and not monitor.global_enabled


def test_global_receiver_retries_a_busy_port_without_reopening_healthy_sockets(monkeypatch):
    import threading

    clock, channels = [0], []

    class Channel:
        def __init__(self, *args):
            self.port, self.closed = None, False
            channels.append(self)

        def setsockopt(self, *args):
            pass

        def bind(self, address):
            self.port = address[1]
            if self.port == 7000 and clock[0] < 30:
                raise OSError("busy")

        def close(self):
            self.closed = True

    def idle(*args):
        threading.Event().wait(0.005)
        return [], [], []

    def wait_for(condition):
        for _ in range(200):
            if condition():
                return
            threading.Event().wait(0.005)
        pytest.fail("Receiver did not reach expected state")

    monkeypatch.setattr("smarthome.network.time.monotonic", lambda: clock[0])
    monkeypatch.setattr("smarthome.network.socket.socket", Channel)
    monkeypatch.setattr("smarthome.network.select.select", idle)
    monitor = NetworkMonitor()
    try:
        monitor.start_global()
        wait_for(lambda: monitor.failed_ports == [7000])
        assert monitor.ports == [6666, 6667]
        clock[0] = 31
        wait_for(lambda: monitor.ports == [6666, 6667, 7000])
        assert not monitor.failed_ports
        assert [channel.port for channel in channels] == [6666, 6667, 7000, 7000]
    finally:
        monitor.close()
    assert all(channel.closed for channel in channels)
