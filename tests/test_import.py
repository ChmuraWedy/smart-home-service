from .conftest import KEY

API = "/api/v1"


def sample():
    # Child first: importer must resolve parents independently of file ordering.
    return [
        {"id": "zigbee", "name": "Relay", "parent": "gw", "cid": "abc", "sub": True},
        {"id": "gw", "name": "Gateway", "key": KEY, "product_id": "product", "version": "3.5"},
    ]


def test_import_two_pass_snapshot_upsert_and_dry_run(client):
    request = {
        "devices": sample(),
        "snapshot": {
            "timestamp": 1,
            "devices": [{"id": "gw", "ip": "192.168.1.60", "ver": "3.4", "key": ""}],
        },
    }
    response = client.post(API + "/imports/tinytuya", json={**request, "dry_run": True})
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 2 and response.json()["warnings"] == []
    assert client.get(API + "/devices").json() == []
    response = client.post(API + "/imports/tinytuya", json=request)
    assert response.status_code == 200 and KEY not in response.text
    items = {item["device_id"]: item for item in client.get(API + "/devices").json()}
    assert items["gw"]["is_gateway"] is True and items["gw"]["version"] == "3.4"
    assert items["gw"]["has_local_key"] is True and items["gw"]["ip"] == "192.168.1.60"
    assert items["zigbee"]["parent_id"] == items["gw"]["id"] and items["zigbee"]["cid"] == "abc"
    assert items["zigbee"]["transport"] == "zigbee"
    assert client.post(API + "/imports/tinytuya", json=request).json()["updated"] == 2
    assert len(client.get(API + "/devices").json()) == 2
    # A snapshot-only update must preserve existing child topology.
    response = client.post(
        API + "/imports/tinytuya",
        json={"devices": {"devices": [{"id": "zigbee", "name": "Updated relay"}]}},
    )
    assert response.status_code == 200 and response.json()["created"] == 0


def test_import_unknown_parent_map_and_atomic_failure(client):
    devices = sample()
    devices[0]["parent"] = ""
    response = client.post(API + "/imports/tinytuya", json={"devices": devices})
    assert response.status_code == 422 and client.get(API + "/devices").json() == []
    response = client.post(
        API + "/imports/tinytuya", json={"devices": devices, "parent_map": {"zigbee": "gw"}}
    )
    assert response.status_code == 200
    # First row updates a stored key, second row fails: neither change may survive.
    response = client.post(
        API + "/imports/tinytuya",
        json={
            "devices": [{"id": "gw", "key": "fedcba9876543210"}, {"id": "bad", "key": "LEAK-ME"}]
        },
    )
    assert response.status_code == 422 and "LEAK-ME" not in response.text
    assert len(client.get(API + "/devices").json()) == 2
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from smarthome.models import Device

    with Session(client.app.state.engine) as session:
        assert session.scalar(select(Device).where(Device.device_id == "gw")).local_key == KEY


def test_import_missing_cid_nested_parent_duplicate_id(client):
    cases = [
        [{"id": "child", "parent": "gw"}, {"id": "gw"}],
        [{"id": "self", "parent": "self", "cid": "x"}],
        [{"id": "c", "parent": "g", "cid": "x"}, {"id": "g", "parent": "c", "cid": "y"}],
        [{"id": "dup"}, {"id": "dup"}],
        [{"id": "bad", "ver": "9.9", "key": KEY}],
        [{"id": "a", "parent": "missing", "cid": "x"}],
        [{"id": "unknown-child", "parent": ""}],
        [{"name": "No ID", "key": KEY}],
    ]
    for devices in cases:
        response = client.post(API + "/imports/tinytuya", json={"devices": devices})
        assert response.status_code == 422, response.text
        assert KEY not in response.text
        assert client.get(API + "/devices").json() == []


def test_import_location_existing_parent_and_empty_snapshot_fields(client, gateway):
    b = client.post(API + "/buildings", json={"name": "Home"}).json()["id"]
    r = client.post(API + "/rooms", json={"name": "Kitchen", "building_id": b}).json()["id"]
    response = client.post(
        API + "/imports/tinytuya",
        json={
            "devices": [
                {"id": "new-child", "parent": gateway["device_id"], "node_id": "1234", "sub": True}
            ],
            "room_id": r,
        },
    )
    assert response.status_code == 200, response.text
    item = client.get(API + "/devices?transport=zigbee").json()[0]
    assert item["building_id"] == b and item["room_id"] == r and item["node_id"] == "1234"
    response = client.post(
        API + "/imports/tinytuya",
        json={"devices": [{"id": gateway["device_id"], "key": "", "ip": "", "ver": ""}]},
    )
    assert response.status_code == 200
    stored = client.get(API + f"/devices/{gateway['id']}").json()
    assert stored["has_local_key"] and stored["ip"] == gateway["ip"] and stored["version"] == "3.5"


def test_import_conflict_rolls_back(client, gateway):
    response = client.post(
        API + "/imports/tinytuya",
        json={
            "devices": [
                {"id": "c1", "parent": gateway["device_id"], "cid": "same"},
                {"id": "c2", "parent": gateway["device_id"], "cid": "same"},
            ]
        },
    )
    assert response.status_code == 409
    assert len(client.get(API + "/devices").json()) == 1
