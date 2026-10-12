"""Local keys belong to exact Wi-Fi roots; Zigbee requests target known gateways."""

import copy
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from smarthome import gateway_setup
from smarthome.models import Device
from tests.test_gateway_keys import KEY, OTHER, Bridge, install_proof
from tests.test_gateway_setup import BODY, INTERFACE, ROW, Monitor

API = "/api/v1/local-connections"


@pytest.fixture
def env(client, monkeypatch):
    bridge = Bridge()
    bridge.gateway.name = "Настоящий шлюз"
    bridge.gateway.product_id = "gateway-product"
    direct = SimpleNamespace(
        id="wifi-real",
        name="Настоящая лампа",
        sub=False,
        category="dj",
        product_id="lamp-product",
        local_key=OTHER,
    )

    def device(identifier):
        for item in bridge.devices():
            if item.id == identifier:
                return item
        raise HTTPException(404, "Not in selected account")

    bridge.device = device
    bridge.devices = lambda: [bridge.gateway, *bridge.children, direct]
    client.app.state.cloud = bridge
    monitor = Monitor()
    monitor.rows = [{**ROW, "device_id": direct.id, "ip": "192.168.40.60"}]
    client.app.state.network = monitor
    monkeypatch.setattr(gateway_setup, "network_interfaces", lambda: [copy.deepcopy(INTERFACE)])
    clock = [0.0]
    monkeypatch.setattr(gateway_setup, "monotonic", lambda: clock[0])
    monkeypatch.setattr(
        gateway_setup, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds)
    )
    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", lambda device: True)
    return SimpleNamespace(bridge=bridge, direct=direct, monitor=monitor)


def find(client, identifier="wifi-real", **updates):
    return client.post(API + "/find", json={**BODY, "device_id": identifier, **updates})


def save(client, finding, **updates):
    return client.post(
        API + "/save", json={"finding_id": finding["finding_id"], "confirmed": True, **updates}
    )


def inventory(client):
    return client.get("/api/v1/devices").json()


def test_wifi_find_is_read_only_and_confirmed_save_assigns_only_own_key(client, env, monkeypatch):
    seen = []

    def verify(device):
        seen.append((device.device_id, device.local_key, device.is_gateway))
        return True

    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", verify)
    response = find(client)
    assert response.status_code == 200, response.text
    found = response.json()
    assert found["route"] == "direct" and found["requested_device_id"] == env.direct.id
    assert found["connection_device_id"] == env.direct.id
    assert found["device"]["is_gateway"] is False and found["key_source"] == "device"
    assert found["device"]["name"] == env.direct.name and inventory(client) == []
    assert KEY not in response.text and OTHER not in response.text
    result = save(client, found)
    assert result.status_code == 201, result.text
    device = result.json()["device"]
    assert not device["is_gateway"] and device["transport"] == "wifi"
    assert device["has_local_key"] and device["parent_id"] is None and device["capabilities"] == {}
    assert seen == [(env.direct.id, OTHER, False)] * 2
    with Session(client.app.state.engine) as session:
        assert session.get(Device, device["id"]).local_key == OTHER
    assert save(client, found).status_code == 404 and len(inventory(client)) == 1


def test_direct_device_uses_actual_controller_read_only_proof(client, env, factory, monkeypatch):
    monkeypatch.undo()
    monkeypatch.setattr(gateway_setup, "network_interfaces", lambda: [INTERFACE])
    monkeypatch.setattr(gateway_setup, "find_address", lambda *args: ("192.168.40.60", "3.5"))
    env.direct.local_key = KEY
    factory.result = {"Error": "Invalid JSON", "Err": "900", "Payload": "data unvalid " + KEY}
    client.app.state.controller.device_factory = install_proof(factory)
    found = find(client)
    assert found.status_code == 200, found.text
    assert found.json()["device"]["version"] == "3.4" and inventory(client) == []
    assert save(client, found.json()).status_code == 201
    assert factory.commands == [(env.direct.id, "status", None)] * 3
    assert all(target.closed for target in factory.instances)


@pytest.mark.parametrize("key", [None, "", "bad", "é" * 16])
def test_no_cross_device_key_search_if_own_key_missing_or_invalid(client, env, key):
    env.direct.local_key = key
    assert find(client).status_code == 409
    assert env.monitor.started == [] and inventory(client) == []


def test_wifi_retry_preserves_existing_configuration_and_rotates_only_verified_key(client, env):
    first = save(client, find(client).json()).json()["device"]
    path = f"/api/v1/devices/{first['id']}"
    before = client.patch(
        path,
        json={
            "name": "Моя лампа",
            "aliases": ["światło"],
            "capabilities": {"switch": {"dp": "1", "type": "boolean"}},
        },
    ).json()
    env.direct.local_key = "abcdefghijklmnop"
    env.monitor.rows[0]["ip"] = "192.168.40.61"
    found = find(client).json()
    assert found["action"] == "updated" and found["device"]["changed_fields"] == ["ip", "local_key"]
    assert client.get(path).json() == before
    after = save(client, found).json()["device"]
    for name in ("id", "name", "aliases", "capabilities", "room_id", "is_gateway"):
        assert after[name] == before[name]
    with Session(client.app.state.engine) as session:
        assert session.get(Device, after["id"]).local_key == "abcdefghijklmnop"
    again = save(client, find(client).json())
    assert again.json()["action"] == "unchanged" and len(inventory(client)) == 1


@pytest.mark.parametrize("change", ["key", "account", "role", "child", "record"])
def test_changed_context_after_find_never_assigns_stale_key(client, env, change):
    found = find(client).json()
    if change == "key":
        env.direct.local_key = KEY
    elif change == "account":
        env.bridge.auth["token_info"]["uid"] = "other"
    elif change == "role":
        env.direct.category = "wg2"
    elif change == "child":
        env.direct.sub = True
    else:
        client.post("/api/v1/devices", json={"name": "Manual", "device_id": env.direct.id})
    before = inventory(client)
    assert save(client, found).status_code == 409
    assert inventory(client) == before


@pytest.mark.parametrize("fields", [{"confirmed": False}, {"confirmed": 1}, {"local_key": KEY}])
def test_confirmation_and_secret_override_guards_apply_to_other_devices(client, env, fields):
    found = find(client).json()
    result = save(client, found, **fields)
    assert result.status_code == 422 and KEY not in result.text and inventory(client) == []


def test_zigbee_without_known_parent_never_searches_shared_keys_to_guess_one(client, env):
    child = env.bridge.children[0]
    assert find(client, child.id).status_code == 409
    assert env.monitor.started == [] and inventory(client) == []


def test_explicit_cloud_parent_assigns_key_to_gateway_and_does_not_create_child(client, env):
    child = env.bridge.children[0]
    child.gateway_id = env.bridge.gateway.id
    env.monitor.rows = [copy.deepcopy(ROW)]
    response = find(client, child.id)
    assert response.status_code == 200, response.text
    found = response.json()
    assert found["route"] == "gateway" and found["requested_device_id"] == child.id
    assert found["connection_device_id"] == env.bridge.gateway.id
    assert found["device"]["is_gateway"] is True and found["key_source"] == "child"
    assert inventory(client) == []
    result = save(client, found)
    assert result.status_code == 201, result.text
    assert result.json()["device"]["device_id"] == env.bridge.gateway.id
    assert len(inventory(client)) == 1 and inventory(client)[0]["is_gateway"]


def test_existing_local_parent_is_used_without_assigning_own_key_or_changing_child(client, env):
    parent = client.post(
        "/api/v1/devices",
        json={
            "name": "Gateway",
            "device_id": env.bridge.gateway.id,
            "is_gateway": True,
            "ip": ROW["ip"],
            "version": "3.5",
        },
    ).json()
    child = client.post(
        "/api/v1/devices",
        json={
            "name": "Sensor",
            "device_id": env.bridge.children[0].id,
            "transport": "zigbee",
            "parent_id": parent["id"],
            "cid": "actual-node",
        },
    ).json()
    env.monitor.rows = [copy.deepcopy(ROW)]
    found = find(client, child["device_id"]).json()
    assert found["connection_device_id"] == parent["device_id"]
    assert save(client, found).status_code == 200
    assert client.get(f"/api/v1/devices/{child['id']}").json() == child
    assert inventory(client)[0]["has_local_key"]
    assert not client.get(f"/api/v1/devices/{child['id']}").json()["has_local_key"]


@pytest.mark.parametrize("change", ["missing", "self", "other", "removed"])
def test_zigbee_parent_changes_between_find_and_save_are_rejected(client, env, change):
    child = env.bridge.children[0]
    child.gateway_id = env.bridge.gateway.id
    env.monitor.rows = [copy.deepcopy(ROW)]
    found = find(client, child.id).json()
    if change == "missing":
        child.gateway_id = None
    elif change == "self":
        child.gateway_id = child.id
    elif change == "other":
        child.gateway_id = "unrelated-gateway"
    else:
        env.bridge.children = []
    assert save(client, found).status_code in (404, 409)
    assert inventory(client) == []


def test_conflicting_cloud_and_local_parents_are_not_silently_overwritten(client, env):
    other = client.post(
        "/api/v1/devices", json={"name": "Other", "device_id": "other-gateway", "is_gateway": True}
    ).json()
    child = env.bridge.children[0]
    child.gateway_id = env.bridge.gateway.id
    client.post(
        "/api/v1/devices",
        json={
            "name": "Sensor",
            "device_id": child.id,
            "transport": "zigbee",
            "parent_id": other["id"],
            "cid": "node-real",
        },
    )
    before = inventory(client)
    assert find(client, child.id).status_code == 409
    assert inventory(client) == before and env.monitor.started == []


def test_developer_account_and_unknown_member_guards(client, env):
    env.bridge.credentials = {"access_id": "project-real"}
    client.app.state.developer_cloud = env.bridge
    found = find(client, provider="developer")
    assert found.status_code == 200 and inventory(client) == []
    assert save(client, found.json()).status_code == 201
    assert find(client, "foreign-device").status_code == 404


def test_new_connection_endpoints_require_authentication(client, env):
    client.app.state.settings = replace(client.app.state.settings, api_token="required")
    assert find(client).status_code == 401
    assert client.post(API + "/save", json={}).status_code == 401
    assert env.monitor.started == []
