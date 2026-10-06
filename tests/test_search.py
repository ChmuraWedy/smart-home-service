from urllib.parse import quote
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app

from .conftest import KEY

API = "/api/v1"
RESOURCES = ("buildings", "rooms", "devices", "device-types")


def create_item(client, resource, name, **fields):
    body = {"name": name, **fields}
    if resource == "rooms" and "building_id" not in body:
        body["building_id"] = client.post(API + "/buildings", json={"name": "House"}).json()["id"]
    elif resource == "devices":
        body.setdefault("device_id", "tuya-" + uuid4().hex)
        body.setdefault("local_key", KEY)
    elif resource == "device-types":
        body.setdefault("slug", "type-" + uuid4().hex)
    response = client.post(API + "/" + resource, json=body)
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize("resource", RESOURCES)
def test_unicode_name_search_exact_partial_and_pagination(client, resource):
    first = create_item(client, resource, "ЛАМПА кухня")
    second = create_item(client, resource, "Лампа спальня")
    create_item(client, resource, "Термометр")
    path = API + "/" + resource
    assert [item["id"] for item in client.get(path, params={"q": " лампа "}).json()] == [
        first["id"],
        second["id"],
    ]
    response = client.get(path, params={"name": " лампа КУХНЯ "})
    assert response.status_code == 200 and response.json()[0]["id"] == first["id"]
    assert KEY not in response.text
    assert client.get(path, params={"name": "Лампа"}).json() == []
    assert (
        client.get(path, params={"q": "СПАЛЬНЯ", "offset": 0, "limit": 1}).json()[0]["id"]
        == second["id"]
    )
    assert (
        client.get(path, params={"q": "лампа", "offset": 1, "limit": 1}).json()[0]["id"]
        == second["id"]
    )
    assert client.get(path, params={"q": "спальня", "name": "лампа кухня"}).json() == []


@pytest.mark.parametrize("resource", RESOURCES)
def test_exact_name_lookup_no_match_and_ambiguity(client, resource):
    first = create_item(client, resource, "Розетка")
    create_item(client, resource, "Розетка у окна")
    path = API + "/lookup/" + resource
    response = client.get(path, params={"name": "РОЗЕТКА"})
    assert response.status_code == 200 and response.json()["id"] == first["id"]
    assert KEY not in response.text
    assert client.get(path, params={"name": "Не существует"}).status_code == 404
    second = create_item(client, resource, "розетка")
    response = client.get(path, params={"name": "Розетка"})
    assert response.status_code == 409, response.text
    matches = response.json()["detail"]["matches"]
    assert {item["id"] for item in matches} == {first["id"], second["id"]}
    assert all("local_key" not in item for item in matches) and KEY not in response.text


@pytest.mark.parametrize("resource", ["buildings", "rooms", "devices"])
def test_name_reference_read_patch_delete_and_rename(client, resource):
    item = create_item(client, resource, "Свет кухня")
    path = API + "/" + resource + "/name:" + quote("СВЕТ КУХНЯ", safe="")
    assert client.get(path).json()["id"] == item["id"]
    response = client.patch(path, json={"name": "Вечерний свет"})
    assert response.status_code == 200, response.text
    assert client.get(path).status_code == 404
    renamed = API + "/" + resource + "/name:" + quote("вечерний свет", safe="")
    assert client.get(renamed).json()["name"] == "Вечерний свет"
    assert client.delete(renamed).status_code == 204


@pytest.mark.parametrize("resource", ["buildings", "rooms", "devices"])
def test_ambiguous_name_does_not_modify_any_object(client, factory, resource):
    items = [create_item(client, resource, " Common "), create_item(client, resource, "COMMON")]
    path = API + "/" + resource + "/name:common"
    assert client.get(path).status_code == 409
    assert client.patch(path, json={"name": "Wrong target"}).status_code == 409
    assert client.delete(path).status_code == 409
    if resource == "devices":
        assert client.post(path + "/commands/on").status_code == 409
        assert factory.instances == [] and factory.commands == []
    for item in items:
        assert client.get(API + f"/{resource}/{item['id']}").json()["name"] == item["name"]


def test_lookup_room_and_device_location_scope(client):
    buildings = [create_item(client, "buildings", name) for name in ("Дом", "Офис")]
    rooms = [
        create_item(client, "rooms", "Кухня", building_id=building["id"]) for building in buildings
    ]
    devices = [create_item(client, "devices", "Розетка", room_id=room["id"]) for room in rooms]
    assert client.get(API + "/lookup/rooms", params={"name": "кухня"}).status_code == 409
    for building, room, device in zip(buildings, rooms, devices, strict=True):
        response = client.get(
            API + "/lookup/rooms", params={"name": "кухня", "building_id": building["id"]}
        )
        assert response.status_code == 200 and response.json()["id"] == room["id"]
        response = client.get(
            API + "/lookup/devices",
            params={"name": "РОЗЕТКА", "room_id": room["id"], "building_id": building["id"]},
        )
        assert response.status_code == 200 and response.json()["id"] == device["id"]
        response = client.get(API + "/devices", params={"q": "РОЗ", "room_id": room["id"]})
        assert [item["id"] for item in response.json()] == [device["id"]]
    assert (
        client.get(
            API + "/lookup/devices",
            params={
                "name": "Розетка",
                "room_id": rooms[0]["id"],
                "building_id": buildings[1]["id"],
            },
        ).status_code
        == 404
    )
    assert (
        client.get(
            API + "/lookup/buildings", params={"name": "Дом", "room_id": rooms[0]["id"]}
        ).status_code
        == 422
    )


@pytest.mark.parametrize("target", ["direct", "child"])
def test_control_by_name_preserves_wifi_gateway_and_cid(
    client, direct, child, gateway, factory, target
):
    item = direct if target == "direct" else child
    assert (
        client.patch(API + f"/devices/{item['id']}", json={"name": "Свет кухня"}).status_code == 200
    )
    path = API + "/devices/name:" + quote("СВЕТ КУХНЯ", safe="")
    for method, suffix, body in (
        ("GET", "status", None),
        ("POST", "commands/on", None),
        ("POST", "commands/off", None),
        ("POST", "commands/set_dps", {"dps": {"1": True}}),
    ):
        factory.instances.clear()
        response = client.request(
            method, path + "/" + suffix, **({"json": body} if body is not None else {})
        )
        assert response.status_code == 200, response.text
        assert response.json()["device_id"] == item["id"]
        assert factory.instances[-1].id == item["device_id"]
        if target == "child":
            assert factory.instances[-1].kwargs["parent"] is factory.instances[0]
            assert factory.instances[0].id == gateway["device_id"]
            assert factory.instances[-1].kwargs["cid"] == item["cid"]
        assert KEY not in response.text


@pytest.mark.parametrize("term", ["%", "_", "' OR 1=1 --", "\\"])
def test_partial_search_treats_sql_wildcards_and_quotes_literally(client, term):
    item = create_item(client, "devices", "Literal " + term + " name")
    create_item(client, "devices", "Unrelated")
    response = client.get(API + "/devices", params={"q": term})
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == [item["id"]]


def test_unicode_composition_slashes_numeric_names_and_alias_collision(client):
    composed = create_item(client, "devices", "Café / Kitchen")
    assert (
        client.get(API + "/lookup/devices", params={"name": "CAFE\u0301 / KITCHEN"}).json()["id"]
        == composed["id"]
    )
    numeric = create_item(client, "devices", "123")
    assert client.get(API + "/devices/name:123").json()["id"] == numeric["id"]
    named = create_item(client, "devices", "light")
    create_item(client, "devices", "Other", aliases=["light"])
    assert client.get(API + "/devices/light").status_code == 409
    assert client.get(API + "/lookup/devices/alias", params={"alias": "light"}).status_code == 409
    assert client.get(API + "/devices/name:light").json()["id"] == named["id"]


def test_search_and_name_lookup_require_authentication(tmp_path):
    with TestClient(
        create_app(Settings(database_path=str(tmp_path / "auth.db"), api_token="token"))
    ) as client:
        for resource in RESOURCES:
            assert client.get(API + "/" + resource, params={"q": "name"}).status_code == 401
            assert (
                client.get(API + "/lookup/" + resource, params={"name": "name"}).status_code == 401
            )
        assert client.post(API + "/devices/name:Test/commands/on").status_code == 401


@pytest.mark.parametrize("parameter", ["q", "name"])
@pytest.mark.parametrize("value", ["", "   ", "x" * 121])
def test_search_query_validation(client, parameter, value):
    assert client.get(API + "/devices", params={parameter: value}).status_code == 422


def test_name_hierarchy_and_guard_checks(client):
    building = create_item(client, "buildings", "Дом")
    room = create_item(client, "rooms", "Кухня", building_id=building["id"])
    device = create_item(client, "devices", "Розетка", room_id=room["id"])
    prefix = API + "/buildings/name:" + quote("дом", safe="")
    assert client.get(prefix + "/hierarchy").json()["rooms"][0]["devices"][0]["id"] == device["id"]
    assert client.get(prefix + "/rooms").json()[0]["id"] == room["id"]
    room_path = API + "/rooms/name:" + quote("кухня", safe="")
    assert client.get(room_path + "/devices").json()[0]["id"] == device["id"]
    assert client.delete(prefix).status_code == 409
    assert client.delete(room_path).status_code == 409


def test_many_ambiguous_matches_are_bounded(client):
    for _ in range(22):
        create_item(client, "devices", "Repeated")
    response = client.get(API + "/lookup/devices", params={"name": "repeated"})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert len(detail["matches"]) == 20 and detail["more_matches"] is True
