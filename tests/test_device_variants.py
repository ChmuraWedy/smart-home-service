from datetime import timedelta

import pytest
import tinytuya
from sqlalchemy.orm import Session

from smarthome.capabilities import decode, encode
from smarthome.models import DeviceObservation, utcnow
from smarthome.profiles import PROFILES, profile
from smarthome.schemas import Capability

API = "/api/v1"

CASES = [
    ("relay", {"switch": True}, {"1": True}),
    ("relay-3ch", {"switch_1": True, "switch_3": False}, {"1": True, "3": False}),
    ("plug-meter", {"switch": False}, {"1": False}),
    (
        "bulb-v2",
        {"switch": True, "color": {"h": 120, "s": 1000, "v": 500}},
        {"20": True, "21": "colour", "24": "007803e801f4"},
    ),
    ("bulb-v1", {"color": {"h": 0, "s": 1000, "v": 1000}}, {"2": "colour", "5": "ff00000000ffff"}),
    (
        "bulb-json",
        {"color": {"h": 180, "s": 1000, "v": 1000}},
        {"21": "colour", "24": '{"h":180,"s":1000,"v":1000}'},
    ),
    ("dimmer", {"switch": True, "brightness": 42.5}, {"1": True, "2": 425}),
    ("cover", {"control": "stop", "position": 80}, {"1": "stop", "2": 80}),
    ("fan", {"speed": "medium", "oscillation": True}, {"3": "2", "4": True}),
    ("thermostat", {"target_temperature": 22.5, "mode": "auto"}, {"2": 45, "4": 1}),
    ("humidifier", {"target_humidity": 55}, {"3": 55}),
    ("vacuum-basic", {"command": "dock"}, {"2": "chargego"}),
    ("button", {"press": True}, {"1": True}),
]


@pytest.mark.parametrize("transport", ["wifi", "zigbee"])
@pytest.mark.parametrize("identifier,values,expected", CASES)
def test_representative_device_commands_use_direct_or_parent_cid(
    client, direct, child, gateway, factory, transport, identifier, values, expected
):
    item = direct if transport == "wifi" else child
    path = API + f"/devices/{item['id']}"
    assert (
        client.patch(path, json={"capabilities": profile(identifier)["capabilities"]}).status_code
        == 200
    )
    factory.instances.clear()
    response = client.post(path + "/commands/capabilities", json={"values": values})
    assert response.status_code == 200, response.text
    assert factory.commands[-1] == (item["device_id"], "set_dps", expected)
    if transport == "zigbee":
        root, target = factory.instances
        assert root.id == gateway["device_id"] and root.local_key == "0123456789abcdef"
        assert target.kwargs["parent"] is root and target.kwargs["cid"] == child["cid"]
    else:
        assert len(factory.instances) == 1 and factory.instances[0].address == direct["ip"]


@pytest.mark.parametrize("identifier", list(PROFILES))
def test_profiles_are_valid_and_do_not_assume_device_detection(client, identifier):
    result = client.get(API + "/profiles/" + identifier)
    assert result.status_code == 200 and result.json()["requires_dp_verification"] is True
    for definition in result.json()["capabilities"].values():
        Capability.model_validate(definition)


def test_color_encodings_match_independent_tinytuya_vectors():
    value = {"h": 120, "s": 1000, "v": 1000}
    for encoding, native_format in [("tuya_hsv", "hsv16"), ("tuya_rgbhsv", "rgb8")]:
        spec = Capability(dp="24", type="object", encoding=encoding)
        expected = tinytuya.BulbDevice.rgb_to_hexvalue(0, 255, 0, native_format)
        assert encode(spec, value) == expected
        assert decode(spec, expected) == value


def test_light_mode_is_batched_and_conflicts_send_nothing(client, direct, factory):
    path = API + f"/devices/{direct['id']}"
    assert (
        client.patch(path, json={"capabilities": profile("bulb-v2")["capabilities"]}).status_code
        == 200
    )
    response = client.post(path + "/commands/brightness", json={"value": 50})
    assert response.status_code == 200 and factory.commands[-1][2] == {"21": "white", "22": 500}
    response = client.put(path + "/capabilities/color_temperature", json={"value": 4600})
    assert response.status_code == 200 and factory.commands[-1][2] == {"21": "white", "23": 500}
    before = len(factory.commands)
    response = client.post(
        path + "/commands/capabilities",
        json={"values": {"brightness": 50, "color": {"h": 120, "s": 1000, "v": 500}}},
    )
    assert response.status_code == 422 and len(factory.commands) == before


def test_step_range_and_readonly_prevent_device_writes(client, direct, factory):
    path = API + f"/devices/{direct['id']}"
    client.patch(path, json={"capabilities": profile("thermostat")["capabilities"]})
    for values in [
        {"target_temperature": 22.3},
        {"target_temperature": 40},
        {"temperature": 22},
        {"mode": "invalid"},
        {"target_temperature": True},
    ]:
        assert (
            client.post(path + "/commands/capabilities", json={"values": values}).status_code == 422
        )
    assert factory.commands == []


def test_inverted_cover_separate_feedback_and_scaling(client, direct, factory):
    path = API + f"/devices/{direct['id']}"
    client.patch(
        path,
        json={
            "capabilities": {
                "position": {
                    "dp": "3",
                    "read_dp": "2",
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 100,
                    "invert": True,
                }
            }
        },
    )
    client.put(path + "/capabilities/position", json={"value": 80})
    assert factory.commands[-1][2] == {"3": 20}
    factory.result = {"dps": {"2": 25}}
    state = client.get(path + "/state?refresh=true").json()
    assert state["values"]["position"]["value"] == 75


@pytest.mark.parametrize(
    "identifier,raw,values",
    [
        (
            "temperature-humidity",
            {"1": 235, "2": 48, "4": 87},
            {"temperature": 23.5, "humidity": 48, "battery": 87},
        ),
        (
            "presence-4in1",
            {"1": "none", "111": 215, "101": 51},
            {"motion": False, "temperature": 21.5, "humidity": 51},
        ),
        ("motion", {"1": "pir"}, {"motion": True}),
        (
            "plug-meter",
            {"1": False, "18": 1234, "19": 123, "20": 2300},
            {"switch": False, "current": 1.234, "power": 12.3, "voltage": 230.0},
        ),
    ],
)
def test_sensor_and_meter_states_normalize_without_writes(
    client, child, factory, identifier, raw, values
):
    path = API + f"/devices/{child['id']}"
    client.patch(path, json={"capabilities": profile(identifier)["capabilities"]})
    factory.result = {"data": {"cid": child["cid"], "dps": raw}}
    state = client.get(path + "/state?refresh=true").json()
    assert state["available"] is True
    for name, value in values.items():
        assert state["values"][name]["value"] == value
        assert state["values"][name]["known"] is True and state["values"][name]["stale"] is False
    assert all(c[1] == "status" for c in factory.commands)


def test_ack_and_other_dp_do_not_refresh_old_sensor_value(client, direct, factory):
    path = API + f"/devices/{direct['id']}"
    client.patch(path, json={"capabilities": profile("temperature-humidity")["capabilities"]})
    factory.result = {"dps": {"1": 215}}
    client.get(path + "/status")
    with Session(client.app.state.engine) as session:
        row = session.get(DeviceObservation, (direct["id"], "1"))
        row.observed_at = utcnow() - timedelta(minutes=5)
        session.commit()
    factory.result = {}
    client.post(path + "/commands/set_dps", json={"dps": {"9": "c"}})
    factory.result = {"dps": {"2": 55}}
    state = client.get(path + "/state?refresh=true").json()
    assert (
        state["values"]["temperature"]["value"] == 21.5
        and state["values"]["temperature"]["stale"] is True
    )
    assert state["values"]["humidity"]["stale"] is False
    assert state["values"]["battery"]["known"] is False


@pytest.mark.parametrize("raw", ["invalid", True, None, {"bad": "data"}])
def test_malformed_sensor_value_is_unknown_not_false(client, direct, factory, raw):
    path = API + f"/devices/{direct['id']}"
    client.patch(path, json={"capabilities": profile("temperature-humidity")["capabilities"]})
    factory.result = {"dps": {"1": raw}}
    state = client.get(path + "/state?refresh=true").json()
    assert state["available"] is False
    assert (
        state["values"]["temperature"]["known"] is False
        and state["values"]["temperature"]["value"] is None
    )
