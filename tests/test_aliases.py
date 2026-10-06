import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session

from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.models import Base, Device, DeviceAlias

from .conftest import KEY

API = "/api/v1"


def create_owner(client, resource, *, aliases=None, suffix="1", building_id=None):
    body = {"name": f"Object {suffix}"}
    if aliases is not None:
        body["aliases"] = aliases
    if resource == "rooms":
        if building_id is None:
            building_id = client.post(API + "/buildings", json={"name": "House"}).json()["id"]
        body["building_id"] = building_id
    elif resource == "devices":
        body.update(device_id=f"tuya-{suffix}", local_key=KEY)
    response = client.post(API + "/" + resource, json=body)
    assert response.status_code == 201, response.text
    assert KEY not in response.text
    return response.json()


@pytest.mark.parametrize("resource", ["buildings", "rooms", "devices"])
def test_alias_crud_lookup_normalization_and_filter(client, resource):
    item = create_owner(client, resource, aliases=[" Primary.Name ", "other_alias"])
    assert item["aliases"] == [item["name"], "other_alias", "primary.name"]
    path = API + "/" + resource
    assert client.get(path + "/Primary.Name").json()["id"] == item["id"]
    assert client.get(path + f"/{item['id']}/aliases").json() == item["aliases"]
    assert client.get(path + "?alias=PRIMARY.NAME").json()[0]["id"] == item["id"]
    assert client.get(path + "?alias=missing").json() == []
    response = client.post(path + "/primary.name/aliases", json={"alias": " Added-Alias "})
    assert response.status_code == 201, response.text
    assert response.json()["aliases"] == [
        item["name"],
        "added-alias",
        "other_alias",
        "primary.name",
    ]
    assert KEY not in response.text
    assert client.delete(path + "/added-alias/aliases/ADDED-ALIAS").status_code == 204
    assert client.get(path + "/added-alias").status_code == 404
    assert client.delete(path + "/primary.name/aliases/missing").status_code == 404
    response = client.patch(
        path + "/primary.name", json={"name": "Updated", "aliases": ["renamed"]}
    )
    assert response.status_code == 200 and response.json()["aliases"] == ["Updated", "renamed"]
    assert client.get(path + "/primary.name").status_code == 404
    assert client.get(path + "/renamed").json()["name"] == "Updated"
    assert client.delete(path + "/renamed").status_code == 204
    # FK cascade/deleted orphan frees alias for another object of the same type.
    replacement = create_owner(client, resource, aliases=["renamed"], suffix="2")
    assert client.get(path + "/renamed").json()["id"] == replacement["id"]


@pytest.mark.parametrize("resource", ["buildings", "rooms", "devices"])
def test_conflicting_alias_is_atomic(client, resource):
    first = create_owner(client, resource, aliases=["taken"], suffix="1")
    second = create_owner(client, resource, aliases=["second"], suffix="2")
    path = API + "/" + resource
    response = client.patch(
        path + f"/{second['id']}", json={"name": "Must roll back", "aliases": ["free", "TAKEN"]}
    )
    assert response.status_code == 409, response.text
    assert client.get(path + "/second").json()["name"] == second["name"]
    assert client.get(path + "/free").status_code == 404
    assert client.post(path + "/second/aliases", json={"alias": "taken"}).status_code == 409
    assert client.post(path + "/taken/aliases", json={"alias": "TAKEN"}).status_code == 409
    assert client.get(path + "/taken").json()["id"] == first["id"]
    body = {"name": "Duplicate alias", "aliases": ["taken"]}
    if resource == "rooms":
        body["building_id"] = first["building_id"]
    elif resource == "devices":
        body.update(device_id="new-tuya-id", local_key=KEY)
    response = client.post(path, json=body)
    assert response.status_code == 409 and KEY not in response.text
    assert len(client.get(path).json()) == 2


@pytest.mark.parametrize("resource", ["buildings", "rooms", "devices"])
@pytest.mark.parametrize(
    "aliases",
    [
        ["123"],
        ["bad/alias"],
        ["alias with spaces"],
        ["x" * 65],
        ["same", " SAME "],
        ["кириллица"],
        None,
    ],
)
def test_invalid_aliases_do_not_modify_object(client, resource, aliases):
    item = create_owner(client, resource, aliases=["valid"])
    response = client.patch(API + f"/{resource}/{item['id']}", json={"aliases": aliases})
    assert response.status_code == 422, response.text
    assert client.get(API + f"/{resource}/{item['id']}").json()["aliases"] == [
        item["name"],
        "valid",
    ]


def test_aliases_are_scoped_by_entity_type(client):
    objects = {
        resource: create_owner(client, resource, aliases=["shared"])
        for resource in ("buildings", "rooms", "devices")
    }
    for resource, item in objects.items():
        assert client.get(API + f"/{resource}/shared").json()["id"] == item["id"]


@pytest.mark.parametrize("resource", ["buildings", "rooms", "devices"])
@pytest.mark.parametrize("reference", ["9223372036854775808", "9" * 100])
def test_out_of_range_numeric_id_is_validation_error(client, resource, reference):
    assert client.get(API + f"/{resource}/{reference}").status_code == 422


def test_alias_hierarchy_and_delete_guards(client, gateway, child):
    building = client.post(API + "/buildings", json={"name": "House", "aliases": ["home"]}).json()
    room = client.post(
        API + "/rooms",
        json={"name": "Kitchen", "building_id": building["id"], "aliases": ["kitchen"]},
    ).json()
    assert (
        client.patch(
            API + f"/devices/{gateway['id']}", json={"room_id": room["id"], "aliases": ["hub"]}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            API + f"/devices/{child['id']}", json={"room_id": room["id"], "aliases": ["relay"]}
        ).status_code
        == 200
    )
    assert client.get(API + "/buildings/home/rooms").json()[0]["aliases"] == ["Kitchen"]
    assert {d["id"] for d in client.get(API + "/rooms/kitchen/devices").json()} == {
        gateway["id"],
        child["id"],
    }
    tree = client.get(API + "/buildings/home/hierarchy").json()
    assert tree["aliases"] == ["House", "home"] and tree["rooms"][0]["aliases"] == ["Kitchen"]
    assert KEY not in str(tree)
    assert client.get(API + "/devices/hub/children").json()[0]["aliases"] == [
        child["name"],
        "relay",
    ]
    for path in ("buildings/home", "rooms/kitchen", "devices/hub"):
        assert client.delete(API + "/" + path).status_code == 409
    assert client.delete(API + "/devices/relay").status_code == 204
    assert client.delete(API + "/devices/hub").status_code == 204
    assert client.delete(API + "/rooms/kitchen").status_code == 204
    assert client.delete(API + "/buildings/home").status_code == 204


@pytest.mark.parametrize("target", ["direct", "child"])
def test_alias_control_uses_real_device_id_and_gateway(
    client, direct, child, gateway, factory, target
):
    item = direct if target == "direct" else child
    assert (
        client.patch(
            API + f"/devices/{item['id']}", json={"aliases": ["control-target"]}
        ).status_code
        == 200
    )
    for method, suffix, body in (
        ("GET", "status", None),
        ("POST", "commands/status", None),
        ("POST", "commands/on", None),
        ("POST", "commands/off", None),
        ("POST", "commands/set_dps", {"dps": {"1": True}}),
        ("PUT", "capabilities/switch", {"value": True}),
    ):
        factory.instances.clear()
        response = client.request(
            method,
            API + "/devices/control-target/" + suffix,
            **({"json": body} if body is not None else {}),
        )
        assert response.status_code == 200, response.text
        assert response.json()["device_id"] == item["id"]
        assert factory.instances[-1].id == item["device_id"]
        if target == "child":
            assert factory.instances[-1].kwargs["parent"] is factory.instances[0]
            assert factory.instances[0].id == gateway["device_id"]
            assert factory.instances[-1].kwargs["cid"] == child["cid"]
        assert KEY not in response.text


def test_import_aliases_preserves_missing_and_rolls_back_conflicts(client):
    request = {
        "devices": [{"id": "d1", "aliases": [" First "]}, {"id": "d2", "aliases": ["second"]}]
    }
    assert (
        client.post(API + "/imports/tinytuya", json={**request, "dry_run": True}).status_code == 200
    )
    assert client.get(API + "/devices/first").status_code == 404
    assert client.post(API + "/imports/tinytuya", json=request).status_code == 200
    assert (
        client.post(
            API + "/imports/tinytuya", json={"devices": [{"id": "d1", "name": "Updated"}]}
        ).status_code
        == 200
    )
    assert client.get(API + "/devices/first").json()["name"] == "Updated"
    response = client.post(
        API + "/imports/tinytuya",
        json={"devices": [{"id": "d1", "aliases": ["third"]}, {"id": "d2", "aliases": ["third"]}]},
    )
    assert response.status_code == 409
    assert client.get(API + "/devices/first").status_code == 200
    assert client.get(API + "/devices/second").status_code == 200
    assert client.get(API + "/devices/third").status_code == 404
    assert (
        client.post(
            API + "/imports/tinytuya", json={"devices": [{"id": "d1", "aliases": []}]}
        ).status_code
        == 200
    )
    assert client.get(API + "/devices/first").status_code == 404


def test_aliases_clear_preserve_and_capacity(client, direct):
    path = API + f"/devices/{direct['id']}"
    aliases = [f"alias-{index:02}" for index in range(32)]
    assert client.patch(path, json={"aliases": aliases}).status_code == 200
    assert client.patch(path, json={"description": "Keep aliases"}).json()["aliases"] == [
        direct["name"],
        *aliases,
    ]
    assert client.post(path + "/aliases", json={"alias": "extra"}).status_code == 422
    assert client.patch(path, json={"aliases": [*aliases, "extra"]}).status_code == 422
    assert client.patch(path, json={"aliases": []}).json()["aliases"] == [direct["name"]]
    assert client.get(API + "/devices/alias-00").status_code == 404


def test_alias_routes_require_authentication(tmp_path):
    with TestClient(
        create_app(Settings(database_path=str(tmp_path / "auth.db"), api_token="token"))
    ) as client:
        for resource in ("buildings", "rooms", "devices"):
            for method, suffix in (
                ("GET", "aliases"),
                ("POST", "aliases"),
                ("DELETE", "aliases/alias"),
            ):
                response = client.request(
                    method,
                    API + f"/{resource}/unknown/{suffix}",
                    **({"json": {"alias": "test"}} if method == "POST" else {}),
                )
                assert response.status_code == 401


def test_upgrade_existing_database_preserves_inventory_and_keys(tmp_path):
    path = tmp_path / "old-version.db"
    engine = create_engine("sqlite:///" + str(path))
    # v0.1.0 schema consists of the same four inventory tables, without alias tables.
    tables = [table for table in Base.metadata.sorted_tables if not table.name.endswith("_aliases")]
    Base.metadata.create_all(engine, tables=tables)
    with engine.begin() as connection:
        connection.execute(
            Device.__table__.insert().values(
                name="Existing outlet", device_id="old-device", local_key=KEY, enabled=True
            )
        )
    assert "device_aliases" not in inspect(engine).get_table_names()
    engine.dispose()
    settings = Settings(database_path=str(path))
    for restart in (False, True):
        with TestClient(create_app(settings)) as client:
            item = client.get(API + "/devices").json()[0]
            assert item["device_id"] == "old-device" and item["has_local_key"] is True
            if not restart:
                assert item["aliases"] == [item["name"]]
                assert (
                    client.patch(
                        API + f"/devices/{item['id']}", json={"aliases": ["old-outlet"]}
                    ).status_code
                    == 200
                )
            else:
                assert client.get(API + "/devices/old-outlet").json()["id"] == item["id"]
            with Session(client.app.state.engine) as session:
                assert session.scalar(select(Device)).local_key == KEY
                assert session.scalar(select(DeviceAlias)).alias == "old-outlet"
            assert {"building_aliases", "room_aliases", "device_aliases"}.issubset(
                inspect(client.app.state.engine).get_table_names()
            )
