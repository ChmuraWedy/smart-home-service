"""Business setup is atomic, repeatable and based on exact LAN/account identity."""

import copy
from dataclasses import replace

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from smarthome import gateway_setup
from smarthome.cloud_mappings import scope_for
from smarthome.models import CloudDeviceAlias, CloudHome, CloudPlacement, CloudRoom, Device
from smarthome.network import NetworkMonitor
from tests.test_capture_tuya import datagram
from tests.test_gateway_keys import KEY, OTHER, Bridge, install_proof

API = "/api/v1/gateways"
INTERFACE = {
    "name": "en1",
    "address": "192.168.40.10",
    "network": "192.168.40.0/24",
    "broadcast": "192.168.40.255",
}
BODY = {
    "device_id": "gateway-real",
    "provider": "sharing",
    "interface_address": INTERFACE["address"],
    "discovery_seconds": 3,
}
ROW = {"device_id": "gateway-real", "ip": "192.168.40.30", "version": "3.5", "changes": []}


class Monitor:
    def __init__(self):
        self.rows = [copy.deepcopy(ROW)]
        self.started = []
        self.removed = []
        self.requested = []
        self.ports = [7000]
        self.failed = []
        self.error = None

    def start_scan(self, interface):
        self.started.append(interface)
        return {"scan_id": "private-scan"}

    def read_scan(self, token):
        return {
            "devices": copy.deepcopy(self.rows),
            "ports": self.ports,
            "failed_ports": self.failed,
        }

    def request_announcements(self, token):
        self.requested.append(token)
        if self.error:
            raise self.error

    def remove_scan(self, token):
        self.removed.append(token)

    def close(self):
        pass


@pytest.fixture
def bridge(client):
    item = Bridge()
    client.app.state.cloud = item
    return item


@pytest.fixture
def setup(client, bridge, monkeypatch):
    bridge.gateway.name = "Реальный шлюз"
    bridge.gateway.product_id = "product-real"
    bridge.device = bridge.writable_device
    monitor = Monitor()
    client.app.state.network = monitor
    monkeypatch.setattr(gateway_setup, "network_interfaces", lambda: [copy.deepcopy(INTERFACE)])
    clock = [0.0]
    monkeypatch.setattr(gateway_setup, "monotonic", lambda: clock[0])
    monkeypatch.setattr(
        gateway_setup, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds)
    )
    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", lambda device: True)
    return monitor


def find(client, **updates):
    return client.post(API + "/find", json={**BODY, **updates})


def save(client, finding, **updates):
    return client.post(
        API + "/save", json={"finding_id": finding["finding_id"], "confirmed": True, **updates}
    )


def run(client, **updates):
    before = inventory(client)
    result = find(client, **updates)
    assert inventory(client) == before, "Finding must never change inventory"
    if result.status_code != 200:
        return result
    return save(client, result.json())


def inventory(client):
    return client.get("/api/v1/devices").json()


def test_exact_identity_create_preserves_scoped_aliases_and_cached_room(client, setup, bridge):
    building = client.post("/api/v1/buildings", json={"name": "Дом"}).json()
    room = client.post(
        "/api/v1/rooms", json={"name": "Кабинет", "building_id": building["id"]}
    ).json()
    scope = scope_for(bridge, "sharing")
    with Session(client.app.state.engine) as session:
        session.add_all(
            [
                CloudHome(scope=scope, home_id="home", building_id=building["id"], name="Дом"),
                CloudRoom(
                    scope=scope,
                    home_id="home",
                    room_id="room",
                    local_room_id=room["id"],
                    name="Кабинет",
                    imported_name="Кабинет",
                ),
                CloudPlacement(
                    scope=scope, device_id="gateway-real", home_id="home", room_id="room"
                ),
                CloudDeviceAlias(scope=scope, device_id="gateway-real", alias="мой шлюз"),
                CloudDeviceAlias(scope="other-account", device_id="gateway-real", alias="foreign"),
            ]
        )
        session.commit()
    setup.rows.insert(0, {**ROW, "device_id": "other-real-id", "ip": "192.168.40.31"})
    response = run(client)
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    assert result["action"] == "created" and result["verified"] is True
    assert result["key_source"] == "child" and result["interface_address"] == INTERFACE["address"]
    item = result["device"]
    assert item["name"] == "Реальный шлюз" and "мой шлюз" in item["aliases"]
    assert "foreign" not in item["aliases"] and item["room_id"] == room["id"]
    assert item["building_id"] == building["id"] and item["ip"] == ROW["ip"]
    assert item["version"] == "3.5" and item["is_gateway"] and item["has_local_key"]
    assert item["parent_id"] is None and item["capabilities"] == {} and item["last_dps"] is None
    assert KEY not in response.text and "private-scan" not in response.text
    assert setup.started == [INTERFACE] and setup.removed == setup.requested == ["private-scan"]
    with Session(client.app.state.engine) as session:
        assert session.get(Device, item["id"]).local_key == KEY
    assert len(inventory(client)) == 1  # No placeholder child records.


def test_protocol_proof_uses_existing_read_only_controller(client, setup, factory, monkeypatch):
    monkeypatch.undo()
    # Reinstall only infrastructure fakes, leaving the actual cryptographic proof method active.
    monkeypatch.setattr(gateway_setup, "network_interfaces", lambda: [INTERFACE])
    monkeypatch.setattr(gateway_setup, "find_address", lambda *args: (ROW["ip"], "3.5"))
    factory.result = {"Error": "Invalid JSON", "Err": "900", "Payload": "data unvalid " + KEY}
    client.app.state.controller.device_factory = install_proof(factory)
    response = run(client)
    assert response.status_code == 201, response.text
    assert response.json()["device"]["version"] == "3.4" and KEY not in response.text
    assert factory.commands == [("gateway-real", "status", None)] * 3
    assert all(target.closed for target in factory.instances)


def test_developer_provider_and_gateway_own_key_use_selected_account(
    client, setup, bridge, monkeypatch
):
    bridge.credentials = {"access_id": "developer-project"}
    bridge.gateway.local_key = OTHER
    client.app.state.developer_cloud = bridge
    seen = []

    def verify(device):
        seen.append(device.local_key)
        return device.local_key == OTHER

    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", verify)
    response = run(client, provider="developer")
    assert response.status_code == 201 and response.json()["key_source"] == "device"
    assert seen == [OTHER, OTHER] and OTHER not in response.text and KEY not in response.text


def test_unknown_account_member_is_rejected_before_listening(client, setup, bridge, monkeypatch):
    def missing(identifier):
        raise HTTPException(404, "Device is not part of the authorized account")

    monkeypatch.setattr(bridge, "device", missing)
    assert run(client).status_code == 404 and setup.started == []


def test_malformed_cloud_name_is_not_replaced_with_invented_name(client, setup, bridge):
    bridge.gateway.name = None
    response = run(client)
    assert response.status_code == 502 and inventory(client) == []
    assert setup.removed == ["private-scan"]


def test_retry_updates_only_connection_and_keeps_children_and_manual_config(client, setup, bridge):
    first = run(client).json()["device"]
    child = client.post(
        "/api/v1/devices",
        json={
            "name": "Датчик",
            "device_id": "sensor-real",
            "transport": "zigbee",
            "parent_id": first["id"],
            "cid": "actual-node",
        },
    ).json()
    client.patch(
        f"/api/v1/devices/{first['id']}",
        json={
            "name": "Мой шлюз",
            "aliases": ["brama"],
            "description": "Keep this",
            "capabilities": {"temperature": {"dp": "1", "type": "number", "writable": False}},
        },
    )
    before = client.get(f"/api/v1/devices/{first['id']}").json()
    setup.rows[0]["ip"] = "192.168.40.32"
    bridge.children[0].local_key = OTHER
    response = run(client)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["action"] == "updated" and result["device"]["id"] == first["id"]
    after = result["device"]
    for field in ("name", "aliases", "description", "capabilities", "building_id", "room_id"):
        assert after[field] == before[field]
    assert after["ip"] == "192.168.40.32" and len(inventory(client)) == 2
    assert client.get(f"/api/v1/devices/{child['id']}").json()["parent_id"] == first["id"]
    again = run(client)
    assert again.status_code == 200 and again.json()["action"] == "unchanged"
    assert again.json()["device"]["updated_at"] == after["updated_at"]
    with Session(client.app.state.engine) as session:
        assert session.get(Device, first["id"]).local_key == OTHER


@pytest.mark.parametrize(
    "rows,code",
    [
        ([], 404),
        ([{**ROW, "device_id": "same-name-different-id"}], 404),
        ([{**ROW, "ip": "192.168.20.30"}], 409),
        ([{**ROW, "ip": INTERFACE["address"]}], 409),
        ([{**ROW, "ip": "192.168.40.255"}], 409),
        ([{**ROW, "ip": "192.168.40.0"}], 409),
        ([ROW, {**ROW, "ip": "192.168.40.31"}], 409),
        ([{**ROW, "changes": [{"previous_ip": "192.168.40.31"}]}], 409),
        ([{**ROW, "version": "3.1"}], 422),
    ],
)
def test_discovery_failures_stop_observation_and_never_probe_or_save(
    client, setup, monkeypatch, rows, code
):
    setup.rows = rows

    def forbidden(device):
        raise AssertionError("Should not probe")

    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", forbidden)
    assert run(client).status_code == code
    assert setup.removed == ["private-scan"] and inventory(client) == []
    assert not client.app.state.observations.gateway_probe_lock.locked()


@pytest.mark.parametrize(
    "ports,failed,error,code",
    [
        ([], [], None, 503),
        ([], [7000], None, 503),
        ([7000], [], HTTPException(429, "throttled"), 429),
    ],
)
def test_unavailable_listener_and_throttle_cleanup(client, setup, ports, failed, error, code):
    setup.ports, setup.failed, setup.error = ports, failed, error
    assert run(client).status_code == code
    assert setup.removed == ["private-scan"] and inventory(client) == []


@pytest.mark.parametrize("change", ["account", "key", "parent", "category", "interface"])
def test_metadata_or_interface_change_during_probe_is_atomic(
    client, setup, bridge, monkeypatch, change
):
    def probe(device):
        if change == "account":
            bridge.auth["token_info"]["uid"] = "other-account"
        elif change == "key":
            bridge.children[0].local_key = OTHER
        elif change == "parent":
            bridge.children[0].gateway_id = "different-parent"
        elif change == "category":
            bridge.gateway.category = "dj"
        else:
            monkeypatch.setattr(gateway_setup, "network_interfaces", lambda: [])
        return True

    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", probe)
    assert run(client).status_code in (409, 422)
    assert inventory(client) == [] and setup.removed == ["private-scan"]


def test_failed_key_proof_preserves_existing_connection(client, setup, monkeypatch):
    first = run(client).json()["device"]
    setup.rows[0]["ip"] = "192.168.40.32"
    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", lambda device: False)
    assert run(client).status_code == 409
    assert client.get(f"/api/v1/devices/{first['id']}").json() == first


@pytest.mark.parametrize("existing", [False, True])
def test_concurrent_inventory_change_is_not_overwritten(client, setup, monkeypatch, existing):
    first = run(client).json()["device"] if existing else None

    def probe(device):
        if first:
            client.patch(f"/api/v1/devices/{first['id']}", json={"name": "Changed while probing"})
        else:
            client.post(
                "/api/v1/devices",
                json={"name": "Created concurrently", "device_id": "gateway-real"},
            )
        return True

    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", probe)
    assert find(client).status_code == 409
    assert inventory(client)[0]["name"] in ("Changed while probing", "Created concurrently")


def test_preconditions_no_scan_and_auth_validation(client, setup, bridge, monkeypatch):
    bridge.gateway.category = "dj"
    assert run(client).status_code == 422
    bridge.gateway.category = "wg2"
    bridge.children = []
    assert run(client).status_code == 409
    assert run(client, interface_address="192.168.20.10").status_code == 409
    for fields in (
        {"provider": "local"},
        {"local_key": KEY},
        {"ip": ROW["ip"]},
        {"discovery_seconds": 100},
        {"discovery_seconds": True},
        {"interface_address": "::1"},
    ):
        response = run(client, **fields)
        assert response.status_code == 422 and KEY not in response.text
    with client.app.state.observations.gateway_probe_lock:
        assert run(client).status_code == 409
    client.app.state.settings = replace(client.app.state.settings, api_token="required")
    assert find(client).status_code == 401
    assert client.post(API + "/save", json={}).status_code == 401
    assert setup.started == []


@pytest.mark.parametrize("fields", [{"is_gateway": False}, {"is_gateway": True, "enabled": False}])
def test_existing_non_gateway_or_disabled_record_is_not_repurposed(client, setup, fields):
    client.post("/api/v1/devices", json={"name": "Keep", "device_id": "gateway-real", **fields})
    assert run(client).status_code == 409 and setup.started == []


def test_alias_conflict_rolls_back_new_device(client, setup, bridge):
    scope = scope_for(bridge, "sharing")
    with Session(client.app.state.engine) as session:
        session.add(CloudDeviceAlias(scope=scope, device_id="gateway-real", alias="occupied"))
        session.commit()
    client.post(
        "/api/v1/devices", json={"name": "Other", "device_id": "other", "aliases": ["occupied"]}
    )
    response = run(client)
    assert response.status_code == 409 and KEY not in response.text
    assert len(inventory(client)) == 1 and inventory(client)[0]["device_id"] == "other"


def test_real_monitor_filters_other_network_and_ignores_payload_ip(client, setup, monkeypatch):
    monkeypatch.setattr(NetworkMonitor, "_listen", lambda self: None)
    monitor = NetworkMonitor()
    monitor.ports = [7000]
    client.app.state.network = monitor

    def announce(token):
        packet = datagram(
            {"gwId": "gateway-real", "version": "3.5", "ip": "8.8.8.8", "local_key": KEY}
        )
        monitor.ingest(packet, "192.168.20.30", 7000)
        monitor.ingest(packet, ROW["ip"], 7000)

    monkeypatch.setattr(monitor, "request_announcements", announce)
    response = run(client)
    assert response.status_code == 201, response.text
    assert response.json()["device"]["ip"] == ROW["ip"] and KEY not in response.text
    assert monitor.scans == {} and monitor.watches == {}


@pytest.mark.parametrize("existing", [False, True])
def test_find_only_returns_reviewable_proposal_without_creating_or_updating(
    client, setup, existing
):
    first = run(client).json()["device"] if existing else None
    before = inventory(client)
    setup.rows[0]["ip"] = "192.168.40.32"
    response = find(client)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["device"]["existing_id"] == (first["id"] if first else None)
    assert result["action"] == ("updated" if existing else "created")
    assert result["device"]["changed_fields"] == (
        ["ip"] if existing else ["ip", "version", "local_key"]
    )
    assert result["device"]["ip"] == "192.168.40.32"
    assert result["verified"] is True and 0 < result["expires_in"] <= gateway_setup.FINDING_TTL
    assert response.headers["cache-control"] == "no-store"
    assert KEY not in response.text and "private-scan" not in response.text
    assert inventory(client) == before
    assert len(client.app.state.gateway_findings.entries) == 1
    assert not client.app.state.observations.entries
    # A finding cannot bypass confirmation through the older commissioning flow.
    assert (
        client.post(
            f"/api/v1/commissioning/{result['finding_id']}/register",
            json={
                "name": "Bypass",
                "reviewed": True,
            },
        ).status_code
        == 404
    )
    assert inventory(client) == before


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {"confirmed": False},
        {"confirmed": 1},
        {"confirmed": "true"},
        {"confirmed": True, "ip": "192.168.40.99"},
        {"confirmed": True, "local_key": OTHER},
    ],
)
def test_save_requires_explicit_boolean_confirmation_and_rejects_client_overrides(
    client, setup, monkeypatch, fields
):
    found = find(client).json()

    def forbidden(device):
        raise AssertionError("Unconfirmed save must not contact the gateway")

    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", forbidden)
    response = client.post(API + "/save", json={"finding_id": found["finding_id"], **fields})
    assert response.status_code == 422 and OTHER not in response.text
    assert inventory(client) == []
    assert found["finding_id"] in client.app.state.gateway_findings.entries


def test_save_consumes_finding_and_old_autosave_endpoint_is_removed(client, setup):
    found = find(client).json()
    response = save(client, found)
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    assert KEY not in response.text
    assert save(client, found).status_code == 404 and len(inventory(client)) == 1
    assert client.app.state.gateway_findings.entries == {}
    before = inventory(client)
    assert client.post(API + "/setup", json=BODY).status_code == 404
    assert inventory(client) == before


@pytest.mark.parametrize("during_save", [False, True])
def test_expired_findings_cannot_be_saved(client, setup, monkeypatch, during_save):
    store = client.app.state.gateway_findings
    now = [0]
    store.clock = lambda: now[0]
    found = find(client).json()
    if during_save:

        def verify(device):
            now[0] = gateway_setup.FINDING_TTL + 1
            return True

        monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", verify)
    else:
        now[0] = gateway_setup.FINDING_TTL + 1
    assert save(client, found).status_code == 404 and inventory(client) == []


@pytest.mark.parametrize(
    "change", ["account", "key", "parent", "category", "interface", "name", "aliases", "room"]
)
def test_changes_between_find_and_save_require_a_new_preview(
    client, setup, bridge, monkeypatch, change
):
    found = find(client).json()
    if change == "account":
        bridge.auth["token_info"]["uid"] = "another-account"
    elif change == "key":
        bridge.children[0].local_key = OTHER
    elif change == "parent":
        bridge.children[0].gateway_id = "another-parent"
    elif change == "category":
        bridge.gateway.category = "dj"
    elif change == "interface":
        monkeypatch.setattr(gateway_setup, "network_interfaces", lambda: [])
    elif change == "name":
        bridge.gateway.name = "New cloud name"
    elif change == "aliases":
        with Session(client.app.state.engine) as session:
            session.add(
                CloudDeviceAlias(
                    scope=scope_for(bridge, "sharing"), device_id="gateway-real", alias="new alias"
                )
            )
            session.commit()
    else:
        monkeypatch.setattr(
            gateway_setup,
            "cached",
            lambda *args: {
                "placements": [
                    {
                        "device_id": "gateway-real",
                        "building_id": 500,
                        "room_id": 501,
                    }
                ]
            },
        )
    response = save(client, found)
    assert response.status_code in (409, 422) and KEY not in response.text
    assert inventory(client) == []


def test_save_rechecks_gateway_and_preserves_existing_record_on_failed_proof(
    client, setup, monkeypatch
):
    first = run(client).json()["device"]
    setup.rows[0]["ip"] = "192.168.40.32"
    found = find(client).json()
    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", lambda device: False)
    assert save(client, found).status_code == 409
    assert client.get(f"/api/v1/devices/{first['id']}").json() == first


def test_manual_inventory_edit_between_find_and_save_is_not_overwritten(client, setup):
    first = run(client).json()["device"]
    setup.rows[0]["ip"] = "192.168.40.32"
    found = find(client).json()
    edited = client.patch(f"/api/v1/devices/{first['id']}", json={"name": "Manual edit"}).json()
    assert save(client, found).status_code == 409
    assert client.get(f"/api/v1/devices/{first['id']}").json() == edited


def test_pending_findings_have_a_bounded_capacity_and_expire(client, setup):
    from smarthome.commissioning import MAX_SESSIONS

    store = client.app.state.gateway_findings
    now = [0]
    store.clock = lambda: now[0]
    for _ in range(MAX_SESSIONS):
        assert find(client).status_code == 200
    assert find(client).status_code == 429 and inventory(client) == []
    now[0] = gateway_setup.FINDING_TTL + 1
    assert find(client).status_code == 200 and len(store.entries) == 1
