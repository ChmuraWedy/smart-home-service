import pytest

from .test_aliases import API, create_owner


@pytest.mark.parametrize("resource", ["buildings", "rooms", "devices"])
def test_name_is_automatic_alias_and_can_be_round_tripped(client, resource):
    item = create_owner(client, resource, aliases=["stable"])
    path = API + "/" + resource
    name = "Свет / Кухня"
    response = client.patch(path + f"/{item['id']}", json={"name": name})
    assert response.status_code == 200
    aliases = response.json()["aliases"]
    assert aliases == [name, "stable"]
    assert client.patch(path + "/stable", json={"aliases": aliases}).status_code == 200
    for query in [name, " СВЕТ / КУХНЯ ", "STABLE"]:
        found = client.get(API + f"/lookup/{resource}/alias", params={"alias": query})
        assert found.status_code == 200, found.text
        assert found.json()["id"] == item["id"]
        assert client.get(path, params={"alias": query}).json()[0]["id"] == item["id"]
    assert client.patch(path + "/stable", json={"aliases": []}).json()["aliases"] == [name]
    assert (
        client.get(API + f"/lookup/{resource}/alias", params={"alias": "stable"}).status_code == 404
    )
    assert client.patch(path + f"/{item['id']}", json={"name": "Новая лампа"}).status_code == 200
    assert client.get(API + f"/lookup/{resource}/alias", params={"alias": name}).status_code == 404
    assert (
        client.get(API + f"/lookup/{resource}/alias", params={"alias": "новая лампа"}).status_code
        == 200
    )


def test_alias_lookup_conflicts_require_scope_and_never_leak_keys(client):
    home = client.post(API + "/buildings", json={"name": "Дом"}).json()
    rooms = [
        client.post(API + "/rooms", json={"building_id": home["id"], "name": name}).json()
        for name in ["Кухня", "Спальня"]
    ]
    devices = [
        client.post(
            API + "/devices",
            json={
                "name": "Лампа",
                "device_id": f"light-{i}",
                "room_id": room["id"],
                "local_key": "0123456789abcdef",
            },
        ).json()
        for i, room in enumerate(rooms)
    ]
    path = API + "/lookup/devices/alias"
    response = client.get(path, params={"alias": "ЛАМПА"})
    assert response.status_code == 409
    assert {x["id"] for x in response.json()["detail"]["matches"]} == {d["id"] for d in devices}
    assert "0123456789abcdef" not in response.text
    assert "local_key" not in response.text
    assert (
        client.get(path, params={"alias": "Лампа", "room_id": rooms[1]["id"]}).json()["id"]
        == devices[1]["id"]
    )
    assert (
        client.get(
            API + "/lookup/buildings/alias", params={"alias": "Дом", "room_id": 1}
        ).status_code
        == 422
    )


def test_numeric_human_name_uses_query_not_id(client):
    item = client.post(
        API + "/devices", json={"name": "123", "device_id": "numeric-name", "aliases": ["123"]}
    ).json()
    assert item["aliases"] == ["123"]
    assert (
        client.get(API + "/lookup/devices/alias", params={"alias": "123"}).json()["id"]
        == item["id"]
    )
    assert client.get(API + "/devices/123").status_code == 404


def test_automatic_name_does_not_use_custom_alias_capacity(client, direct):
    aliases = [f"alias-{i:02}" for i in range(32)]
    path = API + f"/devices/{direct['id']}"
    read = client.patch(path, json={"aliases": [direct["name"], *aliases]})
    assert read.status_code == 200 and len(read.json()["aliases"]) == 33
    assert client.patch(path, json={"aliases": read.json()["aliases"]}).status_code == 200
    assert client.delete(path + "/aliases/Outlet").status_code == 409
