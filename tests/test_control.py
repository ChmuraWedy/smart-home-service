import json
import threading

import pytest
import tinytuya
from fastapi import HTTPException

from smarthome.config import Settings
from smarthome.models import Device
from smarthome.tuya import TuyaController

from .conftest import KEY, Factory

API = "/api/v1"


def test_wifi_direct_and_status_cache(client, direct, factory):
    result = client.get(API + f"/devices/{direct['id']}/status")
    assert result.status_code == 200, result.text
    assert result.json()["dps"] == {"1": True}
    instance = factory.instances[0]
    assert instance.id == direct["device_id"] and instance.local_key == KEY
    assert instance.kwargs["version"] == 3.5 and "parent" not in instance.kwargs
    assert instance.closed and instance.retry is False
    stored = client.get(API + f"/devices/{direct['id']}").json()
    assert stored["last_dps"] == {"1": True} and stored["last_seen_at"].endswith("Z")


@pytest.mark.parametrize(
    "action,dps", [("on", {"1": True}), ("off", {"1": False}), ("set_dps", {"7": 800, "1": True})]
)
def test_zigbee_routes_via_parent_cid(client, child, gateway, factory, action, dps):
    body = {"dps": dps} if action == "set_dps" else {}
    result = client.post(API + f"/devices/{child['id']}/commands/{action}", json=body)
    assert result.status_code == 200, result.text
    root, target = factory.instances
    assert root.id == gateway["device_id"] and root.address == gateway["ip"]
    assert root.local_key == KEY and root.kwargs["version"] == 3.5
    assert target.id == child["device_id"]
    assert target.kwargs["parent"] is root and target.kwargs["cid"] == child["cid"]
    assert target.address is None and target.local_key == ""
    assert factory.commands == [(child["device_id"], "set_dps", dps)]
    assert root.closed


def test_nested_gateway_status_normalization(client, child, factory):
    factory.result = {"data": {"cid": child["cid"], "dps": {"1": False}}, "t": 123}
    result = client.post(API + f"/devices/{child['id']}/commands/status")
    assert result.status_code == 200 and result.json()["dps"] == {"1": False}
    assert "cid" not in result.json() and "data" not in result.json()
    factory.result = {"data": {"cid": "wrong", "dps": {"1": True}}}
    assert client.get(API + f"/devices/{child['id']}/status").status_code == 502


@pytest.mark.parametrize(
    "result,expected",
    [
        (None, 504),
        ({"Error": "bad " + KEY, "Err": "914", "Payload": KEY}, 502),
        (TimeoutError(KEY), 504),
        (ValueError(KEY), 502),
        ({}, 502),
        ({"dps": {}}, 502),
        ("garbage", 502),
        ({"dps": [1]}, 502),
    ],
)
def test_errors_do_not_report_success_or_leak_keys(client, child, factory, result, expected):
    factory.result = result
    response = client.get(API + f"/devices/{child['id']}/status")
    assert response.status_code == expected and KEY not in response.text
    assert factory.instances[0].closed
    assert client.get(API + f"/devices/{child['id']}").json()["last_seen_at"] is None


def test_empty_control_ack_is_not_fabricated_state(client, direct, factory):
    factory.result = {}
    result = client.post(API + f"/devices/{direct['id']}/commands/on")
    assert result.status_code == 200
    assert result.json()["acknowledged"] is True and result.json()["dps"] == {}
    assert client.get(API + f"/devices/{direct['id']}").json()["last_dps"] is None


def test_capability_mapping_validation_override_color(client, direct, factory):
    kind = client.post(
        API + "/device-types",
        json={
            "name": "Bulb",
            "slug": "bulb",
            "capabilities": {
                "switch": {"dp": "20", "type": "boolean"},
                "brightness": {"dp": "22", "type": "integer", "minimum": 10, "maximum": 1000},
                "color": {"dp": "24", "type": "object", "encoding": "tuya_hsv"},
                "temperature": {"dp": "23", "type": "integer", "minimum": 0, "maximum": 1000},
                "power": {"dp": "18", "type": "number", "writable": False},
                "mode": {"dp": "21", "type": "string", "enum": ["white", "colour"]},
            },
        },
    ).json()
    assert (
        client.patch(
            API + f"/devices/{direct['id']}", json={"device_type_id": kind["id"]}
        ).status_code
        == 200
    )
    # Device mapping wins for switch, other entries come from the type.
    assert client.post(API + f"/devices/{direct['id']}/commands/on").status_code == 200
    assert factory.commands[-1][2] == {"1": True}
    for capability, value, dp in (
        ("brightness", 500, {"22": 500}),
        ("temperature", 300, {"23": 300}),
        ("color", {"h": 120, "s": 1000, "v": 500}, {"24": "007803e801f4"}),
    ):
        result = client.post(
            API + f"/devices/{direct['id']}/commands/{capability}", json={"value": value}
        )
        assert result.status_code == 200, result.text
        assert factory.commands[-1][2] == dp
    for capability, value in (
        ("brightness", 1001),
        ("brightness", True),
        ("brightness", 0),
        ("power", 5),
        ("mode", "invalid"),
        ("color", {"h": 999, "s": 1, "v": 1}),
    ):
        before = len(factory.commands)
        result = client.put(
            API + f"/devices/{direct['id']}/capabilities/{capability}", json={"value": value}
        )
        assert result.status_code == 422 and len(factory.commands) == before
    result = client.put(
        API + f"/devices/{direct['id']}/capabilities/mode", json={"value": "colour"}
    )
    assert result.status_code == 200 and factory.commands[-1][2] == {"21": "colour"}


def test_unmapped_switch_needs_explicit_dp(client, gateway, factory):
    assert client.post(API + f"/devices/{gateway['id']}/commands/on").status_code == 409
    assert (
        client.post(API + f"/devices/{gateway['id']}/commands/on", json={"dp": "7"}).status_code
        == 200
    )
    assert factory.commands[-1][2] == {"7": True}
    for dps in ({}, {"abc": True}, {"0": True}):
        assert (
            client.post(
                API + f"/devices/{gateway['id']}/commands/set_dps", json={"dps": dps}
            ).status_code
            == 422
        )


def test_disabled_and_incomplete_device_do_not_connect(client, child, gateway, factory):
    assert (
        client.patch(API + f"/devices/{gateway['id']}", json={"enabled": False}).status_code == 200
    )
    assert client.get(API + f"/devices/{child['id']}/status").status_code == 409
    assert factory.instances == []
    assert (
        client.patch(
            API + f"/devices/{gateway['id']}", json={"enabled": True, "ip": None}
        ).status_code
        == 200
    )
    assert client.get(API + f"/devices/{child['id']}/status").status_code == 409
    assert factory.instances == []


@pytest.mark.parametrize("version", ["3.3", "3.4", "3.5"])
def test_real_tinytuya_child_protocol_frame_without_network(version):
    root = Device(
        id=1,
        device_id="real-gateway",
        ip="192.0.2.10",
        local_key=KEY,
        version=version,
        enabled=True,
        transport="wifi",
        is_gateway=True,
    )
    child = Device(
        id=2,
        device_id="real-child",
        parent_id=1,
        cid="001122334455",
        enabled=True,
        transport="zigbee",
    )
    controller = TuyaController(Settings(database_path=":memory:"))
    with controller.connection(child, root) as target:
        assert isinstance(target, tinytuya.Device)
        assert target.parent.id == root.device_id
        assert target.cid == child.cid and target.version == float(version)
        assert target.parent.local_key == KEY.encode()
        assert target.local_key == b""  # encryption is delegated to parent, not copied to child
        payload = json.loads(target.generate_payload(tinytuya.CONTROL, {"1": True}).payload)
        data = payload.get("data", payload)
        assert data["cid"] == child.cid and data["dps"] == {"1": True}
    assert target.parent.socket is None


def test_gateway_lock_prevents_parallel_child_commands():
    root = Device(
        id=1,
        device_id="gateway",
        ip="192.0.2.10",
        local_key=KEY,
        version="3.5",
        enabled=True,
        transport="wifi",
        is_gateway=True,
    )
    children = [
        Device(
            id=i,
            device_id=f"child-{i}",
            parent_id=1,
            cid=f"cid-{i}",
            enabled=True,
            transport="zigbee",
        )
        for i in (2, 3)
    ]
    factory = Factory()
    controller = TuyaController(Settings(database_path=":memory:", lock_timeout=0.05), factory)
    outcome = []

    def second_command():
        try:
            controller.execute(children[1], root)
        except HTTPException as exc:
            outcome.append(exc.status_code)

    with controller.connection(children[0], root):
        thread = threading.Thread(target=second_command)
        thread.start()
        thread.join(timeout=1)
        assert not thread.is_alive()
        assert outcome == [503]
        assert len(factory.instances) == 2
    assert controller.execute(children[1], root) == {"1": True}
