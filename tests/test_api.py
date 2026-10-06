import json

import pytest
from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app

from .conftest import KEY

API = "/api/v1"


def test_auth(tmp_path):
    with TestClient(
        create_app(Settings(database_path=str(tmp_path / "auth.db"), api_token="test-token"))
    ) as client:
        assert client.get("/health").status_code == 200
        assert client.get(API + "/devices").status_code == 401
        assert client.post(API + "/imports/tinytuya", json={"devices": []}).status_code == 401
        assert client.get(API + "/devices", headers={"X-API-Key": "wrong"}).status_code == 401
        assert client.get(API + "/devices", headers={"X-API-Key": "test-token"}).status_code == 200
        assert (
            client.get("/openapi.json").json()["components"]["securitySchemes"]["APIKeyHeader"][
                "name"
            ]
            == "X-API-Key"
        )


def test_inventory_and_hierarchy(client, direct):
    building = client.post(API + "/buildings", json={"name": "House"}).json()
    room = client.post(
        API + "/rooms", json={"name": "Kitchen", "building_id": building["id"]}
    ).json()
    kind = client.post(API + "/device-types", json={"name": "Relay", "slug": "relay"}).json()
    result = client.patch(
        API + f"/devices/{direct['id']}", json={"room_id": room["id"], "device_type_id": kind["id"]}
    )
    assert result.status_code == 200, result.text
    assert result.json()["building_id"] == building["id"]
    tree = client.get(API + f"/buildings/{building['id']}/hierarchy").json()
    assert tree["rooms"][0]["devices"][0]["id"] == direct["id"]
    assert tree["unassigned_devices"] == []
    assert "local_key" not in json.dumps(tree).replace("has_local_key", "")
    assert KEY not in json.dumps(tree)
    assert client.get(API + f"/rooms/{room['id']}/devices").json()[0]["id"] == direct["id"]
    assert (
        client.get(API + f"/devices?building_id={building['id']}").json()[0]["id"] == direct["id"]
    )
    for entity, item in (("buildings", building), ("rooms", room), ("device-types", kind)):
        assert client.delete(API + f"/{entity}/{item['id']}").status_code == 409
    assert client.patch(API + f"/devices/{direct['id']}", json={"room_id": None}).status_code == 200
    assert (
        client.get(API + f"/buildings/{building['id']}/hierarchy").json()["unassigned_devices"][0][
            "id"
        ]
        == direct["id"]
    )
    assert client.delete(API + f"/devices/{direct['id']}").status_code == 204
    assert client.get(API + f"/devices/{direct['id']}").status_code == 404
    for entity, item in (("rooms", room), ("device-types", kind), ("buildings", building)):
        assert client.delete(API + f"/{entity}/{item['id']}").status_code == 204


def test_location_moves_and_gateway_guard(client, gateway, child):
    b1 = client.post(API + "/buildings", json={"name": "One"}).json()["id"]
    b2 = client.post(API + "/buildings", json={"name": "Two"}).json()["id"]
    r1 = client.post(API + "/rooms", json={"name": "Room", "building_id": b1}).json()["id"]
    r2 = client.post(API + "/rooms", json={"name": "Room", "building_id": b2}).json()["id"]
    assert (
        client.patch(API + f"/devices/{gateway['id']}", json={"building_id": b1}).status_code == 200
    )
    assert client.patch(API + f"/devices/{child['id']}", json={"room_id": r1}).status_code == 200
    assert client.patch(API + f"/devices/{child['id']}", json={"room_id": r2}).status_code == 422
    assert (
        client.patch(
            API + f"/devices/{child['id']}", json={"room_id": r1, "building_id": b2}
        ).status_code
        == 422
    )
    assert (
        client.patch(API + f"/devices/{gateway['id']}", json={"building_id": b2}).status_code == 409
    )
    assert client.patch(API + f"/rooms/{r1}", json={"building_id": b2}).status_code == 409
    assert (
        client.patch(API + f"/devices/{gateway['id']}", json={"is_gateway": False}).status_code
        == 409
    )
    assert client.delete(API + f"/devices/{gateway['id']}").status_code == 409
    assert client.get(API + f"/devices/{gateway['id']}/children").json()[0]["id"] == child["id"]


@pytest.mark.parametrize(
    "patch",
    [
        {"name": None},
        {"capabilities": None},
        {"enabled": None},
        {"local_key": "SECRET-short"},
        {"local_key": "é" * 8},
        {"version": "3.9"},
        {"ip": "bad-IP"},
        {"ip": "0.0.0.0"},
        {"ip": "::1"},
        {"cid": "x"},
        {"parent_id": 1},
    ],
)
def test_invalid_device_patch(client, direct, patch):
    result = client.patch(API + f"/devices/{direct['id']}", json=patch)
    assert result.status_code == 422
    assert "SECRET-short" not in result.text
    assert client.get(API + f"/devices/{direct['id']}").json()["name"] == "Outlet"


def test_keys_write_only_and_validation_redacted(client, direct):
    assert direct["has_local_key"] is True and "local_key" not in direct
    assert KEY not in client.get(API + "/devices").text
    assert KEY not in client.get(API + f"/devices/{direct['id']}").text
    result = client.post(
        API + "/devices", json={"name": None, "device_id": "bad", "local_key": KEY}
    )
    assert result.status_code == 422 and KEY not in result.text
    result = client.post(
        API + "/devices",
        content='{"local_key":"LEAK-ME",}',
        headers={"Content-Type": "application/json"},
    )
    assert result.status_code == 422 and "LEAK-ME" not in result.text
    assert (
        client.patch(API + f"/devices/{direct['id']}", json={"local_key": None}).json()[
            "has_local_key"
        ]
        is False
    )


def test_parent_validation(client, direct, gateway, child):
    for changes in (
        {"parent_id": direct["id"]},
        {"parent_id": child["id"]},
        {"parent_id": child["id"], "is_gateway": True},
        {"cid": None},
        {"node_id": "x", "cid": "y"},
    ):
        result = client.patch(API + f"/devices/{child['id']}", json=changes)
        assert result.status_code == 422
    result = client.post(
        API + "/devices",
        json={
            "name": "Duplicate cid",
            "device_id": "different",
            "transport": "zigbee",
            "parent_id": gateway["id"],
            "cid": child["cid"],
        },
    )
    assert result.status_code == 409
    duplicate = client.post(
        API + "/devices",
        json={"name": "Duplicate ID", "device_id": direct["device_id"], "local_key": KEY},
    )
    assert duplicate.status_code == 409 and KEY not in duplicate.text


def test_move_wifi_room_and_clear_location(client, direct):
    b1 = client.post(API + "/buildings", json={"name": "B1"}).json()["id"]
    b2 = client.post(API + "/buildings", json={"name": "B2"}).json()["id"]
    rooms = [
        client.post(API + "/rooms", json={"name": "R", "building_id": b}).json()["id"]
        for b in (b1, b2)
    ]
    assert (
        client.patch(API + f"/devices/{direct['id']}", json={"room_id": rooms[0]}).json()[
            "building_id"
        ]
        == b1
    )
    assert (
        client.patch(API + f"/devices/{direct['id']}", json={"room_id": rooms[1]}).json()[
            "building_id"
        ]
        == b2
    )
    assert (
        client.patch(
            API + f"/devices/{direct['id']}", json={"building_id": None, "room_id": None}
        ).status_code
        == 200
    )
    assert len(client.get(API + "/devices?unassigned=true").json()) == 1


def test_room_and_type_crud(client):
    b = client.post(API + "/buildings", json={"name": "B"}).json()["id"]
    assert (
        client.patch(API + f"/buildings/{b}", json={"address": "Street"}).json()["address"]
        == "Street"
    )
    r = client.post(API + "/rooms", json={"name": "R", "building_id": b}).json()["id"]
    assert client.get(API + f"/rooms/{r}").json()["name"] == "R"
    assert client.patch(API + f"/rooms/{r}", json={"name": "New"}).json()["name"] == "New"
    assert len(client.get(API + f"/buildings/{b}/rooms").json()) == 1
    assert len(client.get(API + f"/rooms?building_id={b}").json()) == 1
    t = client.post(API + "/device-types", json={"name": "T", "slug": "type"}).json()["id"]
    assert client.get(API + f"/device-types/{t}").status_code == 200
    assert (
        client.patch(API + f"/device-types/{t}", json={"name": "New T"}).json()["name"] == "New T"
    )
    assert len(client.get(API + "/device-types").json()) == 1
    assert client.patch(API + f"/rooms/{r}", json={"building_id": None}).status_code == 422


def test_database_persistence_and_permissions(tmp_path):
    path = tmp_path / "inventory.db"
    settings = Settings(database_path=str(path))
    with TestClient(create_app(settings)) as client:
        assert client.post(API + "/buildings", json={"name": "Persistent"}).status_code == 201
    with TestClient(create_app(settings)) as client:
        assert client.get(API + "/buildings").json()[0]["name"] == "Persistent"
    assert path.stat().st_mode & 0o777 == 0o600
