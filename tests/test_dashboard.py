from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from smarthome.main import create_app
from smarthome.models import DeviceObservation
from smarthome.profiles import profile

API = "/api/v1"


@pytest.fixture
def demo_room(client):
    home = client.post(API + "/buildings", json={"name": "Дом"}).json()
    room = client.post(API + "/rooms", json={"name": "Комната", "building_id": home["id"]}).json()
    devices = []
    for i, (name, kind) in enumerate(
        [
            ("Лампа 1", "bulb-v2"),
            ("Лампа 2", "bulb-v2"),
            ("Лампа 3", "bulb-v2"),
            ("Выключатель", "relay"),
            ("Температура / влажность", "temperature-humidity"),
            ("Движение", "motion"),
        ]
    ):
        result = client.post(
            API + "/devices",
            json={
                "name": name,
                "device_id": f"demo-{i}",
                "room_id": room["id"],
                "ip": f"192.168.1.{40 + i}",
                "version": "3.5",
                "local_key": "0123456789abcdef",
                "capabilities": profile(kind)["capabilities"],
            },
        )
        assert result.status_code == 201
        devices.append(result.json())
    group = client.post(
        API + "/groups",
        json={"name": "Свет", "room_id": room["id"], "device_ids": [d["id"] for d in devices[:3]]},
    ).json()
    return room, devices, group


def selection(room, devices, group):
    return {
        "name": "Панель комнаты",
        "room_id": room["id"],
        "widgets": [
            {"kind": "group", "id": group["id"]},
            *[{"kind": "device", "id": d["id"]} for d in devices[3:]],
        ],
    }


def test_user_room_example_persists_and_opens_individual_lights(client, demo_room, factory):
    room, devices, group = demo_room
    path = API + "/displays/wall-panel"
    saved = client.put(path, json=selection(room, devices, group))
    assert saved.status_code == 200 and saved.json()["widgets"][0]["kind"] == "group"
    assert client.get(path).json() == saved.json()
    for device in devices:
        if device == devices[4]:
            factory.result = {"dps": {"1": 225, "2": 56}}
        elif device == devices[5]:
            factory.result = {"dps": {"1": "pir"}}
        elif device == devices[3]:
            factory.result = {"dps": {"1": False}}
        else:
            factory.result = {"dps": {"20": True, "21": "colour", "24": "007803e801f4"}}
        assert client.get(API + f"/devices/{device['id']}/status").status_code == 200
    dashboard = client.get(path + "/dashboard").json()
    light_group, switch, sensor, motion = dashboard["widgets"]
    assert light_group["state"] == "on" and len(light_group["members"]) == 3
    assert light_group["members"][0]["values"]["color"]["value"] == {"h": 120, "s": 1000, "v": 500}
    assert switch["values"]["switch"]["value"] is False
    assert (
        sensor["values"]["temperature"]["value"] == 22.5
        and sensor["values"]["humidity"]["value"] == 56
    )
    assert motion["values"]["motion"]["value"] is True
    assert "0123456789abcdef" not in str(dashboard) and "local_key" not in str(dashboard)
    assert "write_dps" not in str(dashboard) and "dp" not in sensor["capabilities"]["temperature"]
    factory.result = {"dps": {"20": False}}
    assert client.post(API + f"/devices/{devices[0]['id']}/commands/off").status_code == 200
    assert client.get(path + "/dashboard").json()["widgets"][0]["state"] == "mixed"
    assert client.delete(path).status_code == 204
    assert client.get(path).status_code == 404


def test_group_ack_without_state_does_not_claim_on(client, demo_room, factory):
    room, devices, group = demo_room
    factory.result = {}
    result = client.post(API + f"/groups/{group['id']}/commands/on")
    assert result.status_code == 200 and result.json()["all_acknowledged"] is True
    assert len(factory.commands) == 3
    assert client.get(API + f"/groups/{group['id']}/state").json()["state"] == "unknown"


def test_group_partial_failure_reports_each_member(client, demo_room):
    _, devices, group = demo_room

    class Controller:
        def execute(self, device, parent, **kw):
            if device.id == devices[1]["id"]:
                raise HTTPException(504, "secret from unsafe upstream")
            return {"20": True}

    client.app.state.controller = Controller()
    result = client.post(API + f"/groups/{group['id']}/commands/on").json()
    assert result["all_acknowledged"] is False
    assert [r["acknowledged"] for r in result["results"]] == [True, False, True]
    assert result["results"][1]["error_status"] == 504 and "unsafe upstream" not in str(result)


def test_group_preflight_validates_all_capabilities_before_writes(client, demo_room, factory):
    _, devices, group = demo_room
    client.patch(API + f"/devices/{devices[1]['id']}", json={"capabilities": {}})
    assert client.post(API + f"/groups/{group['id']}/commands/on").status_code == 409
    assert factory.commands == []


def test_group_crud_location_and_unique_members(client, demo_room):
    room, devices, group = demo_room
    path = API + f"/groups/{group['id']}"
    assert (
        client.get(API + "/groups", params={"room_id": room["id"]}).json()[0]["id"] == group["id"]
    )
    for body in [
        {"device_ids": []},
        {"device_ids": [devices[0]["id"]] * 2},
        {"device_ids": [devices[4]["id"]]},
    ]:
        assert client.patch(path, json=body).status_code == 422
    response = client.patch(
        path, json={"name": "Лампы", "device_ids": [devices[2]["id"], devices[0]["id"]]}
    )
    assert response.status_code == 200 and response.json()["device_ids"] == [
        devices[2]["id"],
        devices[0]["id"],
    ]
    assert client.delete(path).status_code == 204
    assert client.delete(API + f"/devices/{devices[0]['id']}").status_code == 204


def test_selected_groups_and_devices_cannot_move_or_disappear(client, demo_room):
    room, devices, group = demo_room
    path = API + "/displays/wall-panel"
    client.put(path, json=selection(room, devices, group))
    other = client.post(
        API + "/rooms", json={"name": "Другая", "building_id": room["building_id"]}
    ).json()
    assert (
        client.patch(
            API + f"/devices/{devices[0]['id']}", json={"room_id": other["id"]}
        ).status_code
        == 409
    )
    assert (
        client.patch(
            API + f"/devices/{devices[3]['id']}", json={"room_id": other["id"]}
        ).status_code
        == 409
    )
    assert client.delete(API + f"/groups/{group['id']}").status_code == 409
    assert client.delete(API + f"/devices/{devices[3]['id']}").status_code == 409
    assert client.delete(API + f"/rooms/{room['id']}").status_code == 409
    invalid = {**selection(room, devices, group), "room_id": other["id"]}
    assert client.put(path, json=invalid).status_code == 422
    assert client.get(path).json()["room_id"] == room["id"]


def test_display_save_empty_replace_and_round_trip(client, demo_room):
    room, devices, group = demo_room
    path = API + "/displays/wall-panel"
    body = selection(room, devices, group)
    client.put(path, json=body)
    body["widgets"] = [
        {"kind": "device", "id": devices[0]["id"], "capabilities": ["switch", "color"]}
    ]
    assert client.put(path, json=body).status_code == 200
    assert client.get(path + "/dashboard").json()["widgets"][0]["capabilities"].keys() == {
        "switch",
        "color",
    }
    body["widgets"] = []
    assert client.put(path, json=body).status_code == 200
    assert client.get(path + "/dashboard").json()["widgets"] == []


def test_stale_motion_is_not_displayed_as_current_inactive(client, demo_room, factory):
    room, devices, group = demo_room
    path = API + "/displays/wall-panel"
    client.put(path, json=selection(room, devices, group))
    factory.result = {"dps": {"1": "none"}}
    client.get(API + f"/devices/{devices[5]['id']}/status")
    with Session(client.app.state.engine) as session:
        row = session.get(DeviceObservation, (devices[5]["id"], "1"))
        row.observed_at -= timedelta(days=1)
        session.commit()
    widget = client.get(path + "/dashboard").json()["widgets"][-1]
    assert (
        widget["values"]["motion"]["value"] is False and widget["values"]["motion"]["stale"] is True
    )
    assert widget["available"] is False


def test_poller_collects_only_selected_devices_and_deduplicates(client, demo_room, factory):
    room, devices, group = demo_room
    body = selection(room, devices, group)
    body["widgets"] = [body["widgets"][0], {"kind": "device", "id": devices[0]["id"]}]
    client.put(API + "/displays/panel", json=body)
    factory.result = {"dps": {"20": True}}
    client.app.state.poller.refresh({"panel"})
    assert len(factory.commands) == 3
    assert {r[0] for r in factory.commands} == {d["device_id"] for d in devices[:3]}
    assert client.get(API + "/displays/panel/dashboard").json()["widgets"][0]["state"] == "on"


def test_dashboard_survives_application_restart(client, demo_room):
    from fastapi.testclient import TestClient

    room, devices, group = demo_room
    body = selection(room, devices, group)
    saved = client.put(API + "/displays/panel", json=body).json()
    with TestClient(create_app(client.app.state.settings)) as restarted:
        assert restarted.get(API + "/displays/panel").json() == saved
        assert (
            len(restarted.get(API + "/displays/panel/dashboard").json()["widgets"][0]["members"])
            == 3
        )


@pytest.mark.parametrize(
    "body",
    [
        {"name": "Panel", "room_id": 1, "widgets": [{"kind": "device", "id": 999}]},
        {
            "name": "Panel",
            "room_id": 1,
            "widgets": [{"kind": "group", "id": 1, "capabilities": ["switch"]}],
        },
    ],
)
def test_invalid_selection_is_rejected(client, demo_room, body):
    assert client.put(API + "/displays/panel", json=body).status_code in (404, 422)
    assert client.get(API + "/displays/panel").status_code == 404


def test_display_limits_and_unknown_capabilities_are_atomic(client, demo_room):
    room, devices, group = demo_room
    path = API + "/displays/panel"
    saved = client.put(path, json=selection(room, devices, group)).json()
    for widgets in [
        [{"kind": "device", "id": devices[0]["id"]}] * 2,
        [{"kind": "device", "id": devices[0]["id"], "capabilities": ["missing"]}],
    ]:
        result = client.put(
            path, json={"name": "Invalid", "room_id": room["id"], "widgets": widgets}
        )
        assert result.status_code == 422
        assert client.get(path).json() == saved
    extra = []
    for i in range(13):
        extra.append(
            client.post(
                API + "/devices",
                json={
                    "name": str(i),
                    "device_id": f"extra-{i}",
                    "room_id": room["id"],
                    "capabilities": profile("relay")["capabilities"],
                },
            ).json()["id"]
        )
    huge = client.post(
        API + "/groups", json={"name": "Большая группа", "room_id": room["id"], "device_ids": extra}
    )
    assert huge.status_code == 201
    assert (
        client.put(
            path,
            json={
                "name": "Too large",
                "room_id": room["id"],
                "widgets": [{"kind": "group", "id": huge.json()["id"]}],
            },
        ).status_code
        == 422
    )
    assert client.get(path).json() == saved


def test_options_paginate_devices_and_enforce_room(client, demo_room):
    room, devices, group = demo_room
    result = client.get(
        API + "/displays/new-panel/options", params={"room_id": room["id"], "limit": 2}
    ).json()
    assert len(result["devices"]) == 2 and result["more_devices"] is True
    assert result["groups"][0]["id"] == group["id"]
    second = client.get(
        API + "/displays/new-panel/options", params={"room_id": room["id"], "limit": 2, "offset": 2}
    ).json()
    assert second["devices"][0]["id"] == devices[2]["id"]
    assert (
        client.get(API + "/displays/new-panel/options", params={"room_id": 999}).status_code == 404
    )


def test_display_routes_require_authentication(tmp_path):
    from fastapi.testclient import TestClient

    from smarthome.config import Settings

    with TestClient(
        create_app(Settings(database_path=str(tmp_path / "auth.db"), api_token="token"))
    ) as guarded:
        for method, path, body in [
            ("GET", "/displays", None),
            ("PUT", "/displays/panel", {"name": "Panel", "room_id": 1}),
            ("GET", "/displays/panel/dashboard", None),
            ("POST", "/displays/panel/refresh", None),
            ("POST", "/groups/1/commands/on", None),
        ]:
            response = guarded.request(method, API + path, **({"json": body} if body else {}))
            assert response.status_code == 401
