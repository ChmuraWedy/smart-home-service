import copy
import threading
import time
from types import SimpleNamespace

import pytest

from tests.test_cloud import API, KEY, SECRET, cloud_client, login  # noqa: F401


class TopologyAPI:
    def __init__(self):
        self.calls = []
        self.homes = [{"ownerId": 101, "name": "Дом"}, {"ownerId": 202, "name": "Дача"}]
        self.devices = {"101": [{"id": "lamp"}, {"id": "sensor"}], "202": [{"id": "outlet"}]}
        self.rooms = {
            "lamp": {"id": 1, "name": "Кухня"},
            "sensor": {"id": 2, "name": "Кухня"},
            "outlet": None,
        }
        self.fail = False
        self.block = None

    def get(self, path, params=None):
        self.calls.append((path, params))
        if self.block:
            self.block[0].set()
            assert self.block[1].wait(3)
        if self.fail:
            return {"success": False, "msg": SECRET, "local_key": KEY}
        if path.endswith("/users/homes"):
            result = self.homes
        elif path.endswith("/home/devices"):
            result = self.devices[params["homeId"]]
        elif path.endswith("/room"):
            result = self.rooms[path.split("/")[-2]]
        else:
            raise AssertionError("Unexpected topology request")
        return {"success": True, "result": copy.deepcopy(result)}


@pytest.fixture
def topology_client(cloud_client):  # noqa: F811 - pytest fixture imported from test_cloud
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    with bridge.lock:
        api = TopologyAPI()
        bridge._manager().customer_api = api
    return cloud_client, api


def sync(client):
    started = client.post(API + "/topology/sync")
    assert started.status_code == 202, started.text
    # Join the actual bounded worker: GET remains a cached read, never a network query.
    client.app.state.topology.thread.join(timeout=3)
    result = client.get(API + "/topology")
    assert result.status_code == 200, result.text
    assert result.json()["job"]["status"] == "done", result.text
    return result.json()


def test_sync_creates_idempotent_hierarchy_without_registering_cloud_devices(topology_client):
    client, api = topology_client
    assert client.get(API + "/topology").json()["placements"] == [] and api.calls == []
    result = sync(client)
    assert len(result["homes"]) == 2 and len(result["placements"]) == 3
    assert {(room["home_id"], room["room_id"], room["name"]) for room in result["rooms"]} == {
        ("101", "1", "Кухня"),
        ("101", "2", "Кухня"),
    }
    assert result["empty_rooms_available"] is False
    assert len(api.calls) == 6  # Homes + two home inventories + three room reads, no specs/status.
    rooms = client.get("/api/v1/rooms").json()
    assert len(rooms) == 2 and len({r["name"] for r in rooms}) == 2
    assert client.get("/api/v1/devices").json() == []
    original = result["placements"]
    assert sync(client)["placements"] == original
    assert client.get("/api/v1/rooms").json() == rooms
    assert len(client.get("/api/v1/buildings").json()) == 2
    count = len(api.calls)
    response = client.get(API + "/topology")
    assert len(api.calls) == count and response.headers["cache-control"] == "no-store"
    assert KEY not in response.text and SECRET not in response.text


@pytest.mark.parametrize("unassigned", [None, "", {}])
def test_unassigned_room_variants_keep_building_without_fabricating_a_room(
    topology_client, unassigned
):
    client, api = topology_client
    api.rooms["outlet"] = unassigned
    placement = next(p for p in sync(client)["placements"] if p["device_id"] == "outlet")
    assert placement["building_id"] is not None and placement["room_id"] is None


def test_renames_follow_external_ids_and_preserve_manual_names_and_aliases(topology_client):
    client, api = topology_client
    result = sync(client)
    building_id = result["homes"][0]["building_id"]
    room_id = next(p for p in result["placements"] if p["device_id"] == "lamp")["room_id"]
    client.patch(f"/api/v1/buildings/{building_id}", json={"aliases": ["my_home"]})
    client.patch(f"/api/v1/rooms/{room_id}", json={"aliases": ["kitchen"]})
    api.homes[0]["name"] = "Квартира"
    api.rooms["lamp"]["name"] = "Столовая"
    api.rooms["sensor"]["name"] = "Прихожая"
    sync(client)
    home = client.get(f"/api/v1/buildings/{building_id}").json()
    room = client.get(f"/api/v1/rooms/{room_id}").json()
    assert home["name"] == "Квартира" and home["aliases"] == ["Квартира", "my_home"]
    assert room["name"] == "Столовая" and "kitchen" in room["aliases"]
    assert any(r["name"] == "Прихожая" for r in client.get("/api/v1/rooms").json())
    client.patch(f"/api/v1/rooms/{room_id}", json={"name": "Моя комната"})
    api.rooms["lamp"]["name"] = "Новое облачное имя"
    sync(client)
    assert client.get(f"/api/v1/rooms/{room_id}").json()["name"] == "Моя комната"


def test_automatic_moves_follow_cloud_until_owner_changes_placement(topology_client):
    client, api = topology_client
    item = client.post("/api/v1/devices", json={"name": "Lamp", "device_id": "lamp"}).json()
    first = sync(client)
    before = client.get(f"/api/v1/devices/{item['id']}").json()
    assert before["room_id"] is not None
    api.rooms["lamp"] = {"id": 3, "name": "Спальня"}
    sync(client)
    after = client.get(f"/api/v1/devices/{item['id']}").json()
    assert after["room_id"] != before["room_id"]
    assert after["capabilities"] == {} and not after["has_local_key"]
    manual = next(p for p in first["placements"] if p["device_id"] == "sensor")["room_id"]
    client.patch(f"/api/v1/devices/{item['id']}", json={"room_id": manual})
    assert sync(client)["warnings"] == 1
    assert client.get(f"/api/v1/devices/{item['id']}").json()["room_id"] == manual
    # Explicitly clearing a previously managed placement is also a manual override.
    client.patch(f"/api/v1/devices/{item['id']}", json={"building_id": None, "room_id": None})
    sync(client)
    # A preserved override stays preserved even when it is empty.
    assert client.get(f"/api/v1/devices/{item['id']}").json()["room_id"] is None


def test_group_constraints_are_preserved_and_reported(topology_client):
    client, api = topology_client
    item = client.post(
        "/api/v1/devices",
        json={
            "name": "Lamp",
            "device_id": "lamp",
            "capabilities": {"switch": {"dp": "1", "type": "boolean"}},
        },
    ).json()
    sync(client)
    item = client.get(f"/api/v1/devices/{item['id']}").json()
    group = client.post(
        "/api/v1/groups",
        json={"name": "Группа", "room_id": item["room_id"], "device_ids": [item["id"]]},
    )
    assert group.status_code == 201, group.text
    api.rooms["lamp"] = {"id": 3, "name": "Спальня"}
    assert sync(client)["warnings"] == 1
    assert client.get(f"/api/v1/devices/{item['id']}").json()["room_id"] == item["room_id"]


@pytest.mark.parametrize("malformed", ["failure", "homes", "room", "duplicates", "unsafe_id"])
def test_failed_sync_keeps_previous_snapshot_atomic_and_hides_secrets(topology_client, malformed):
    client, api = topology_client
    original = sync(client)
    if malformed == "failure":
        api.fail = True
    elif malformed == "homes":
        api.homes = {"secret": SECRET}
    elif malformed == "room":
        api.rooms["sensor"] = {"secret": KEY}
    elif malformed == "duplicates":
        api.devices["202"].append({"id": "lamp"})
    else:
        api.devices["202"].append({"id": "../secrets?x"})
    assert client.post(API + "/topology/sync").status_code == 202
    client.app.state.topology.thread.join(timeout=3)
    response = client.get(API + "/topology")
    result = response.json()
    assert result["job"]["status"] == "failed"
    assert (
        result["placements"] == original["placements"]
        and result["synced_at"] == original["synced_at"]
    )
    assert KEY not in response.text and SECRET not in response.text


def test_gateway_child_relationship_and_credentials_survive_incompatible_cloud_move(
    topology_client,
):
    client, api = topology_client
    gateway = client.post(
        "/api/v1/devices",
        json={
            "name": "Gateway",
            "device_id": "lamp",
            "is_gateway": True,
            "local_key": KEY,
            "ip": "192.168.1.20",
            "version": "3.5",
        },
    ).json()
    child = client.post(
        "/api/v1/devices",
        json={
            "name": "Child",
            "device_id": "sensor",
            "transport": "zigbee",
            "parent_id": gateway["id"],
            "cid": "node-1",
        },
    ).json()
    sync(client)
    original = client.get(f"/api/v1/devices/{gateway['id']}").json()
    api.devices["101"] = [{"id": "sensor"}]
    api.devices["202"].append({"id": "lamp"})
    api.rooms["lamp"] = None
    assert sync(client)["warnings"] == 1
    current = client.get(f"/api/v1/devices/{gateway['id']}").json()
    assert current["building_id"] == original["building_id"]
    assert current["has_local_key"] and current["ip"] == original["ip"]
    child = client.get(f"/api/v1/devices/{child['id']}").json()
    assert child["parent_id"] == gateway["id"] and child["cid"] == "node-1"


def test_removals_do_not_delete_local_objects_and_rooms_without_devices_remain(topology_client):
    client, api = topology_client
    sync(client)
    api.devices["101"] = []
    result = sync(client)
    assert len(result["placements"]) == 1
    assert len(client.get("/api/v1/rooms").json()) == 2
    api.homes = []
    result = sync(client)
    assert result["homes"] == [] and result["placements"] == []
    assert len(client.get("/api/v1/buildings").json()) == 2


def test_device_discovery_uses_existing_rooms_and_explicit_sync_restores_deleted_rooms(topology_client):
    client, api = topology_client
    api.rooms["lamp"] = {"id": 1, "name": "Office"}
    initial = {row["device_id"]: row for row in sync(client)["placements"]}
    assert client.delete(f"/api/v1/rooms/{initial['lamp']['room_id']}").status_code == 204

    bridge = client.app.state.cloud
    with bridge.lock:
        device = bridge.devices()[0]
        manager = bridge._manager()
        manager.device_map = {
            key: SimpleNamespace(**{**vars(device), "id": key})
            for key in ("new-known", "new-deleted", "new-unknown")
        }
        room_ids = {"new-known": "2", "new-deleted": "1", "new-unknown": "99"}
        manager.query_room_by_device = lambda device_id: SimpleNamespace(id=room_ids[device_id])

    listed = {row["id"]: row for row in client.get(API + "/devices").json()}
    assert listed["new-known"]["synced_room"]["room_id"] == initial["sensor"]["room_id"]
    assert listed["new-deleted"]["synced_room"]["room_id"] is None
    assert "synced_room" not in listed["new-unknown"]
    assert all(room["name"] != "Office" for room in client.get("/api/v1/rooms").json())
    placements = {row["device_id"]: row for row in client.get(API + "/topology").json()["placements"]}
    assert placements["lamp"]["room_id"] is None

    api.devices["101"].append({"id": "new-deleted"})
    api.rooms["new-deleted"] = api.rooms["lamp"]
    placements = {row["device_id"]: row for row in sync(client)["placements"]}
    assert placements["lamp"]["room_id"] is not None
    assert placements["new-deleted"]["room_id"] == placements["lamp"]["room_id"]
    assert any(room["name"] == "Office" for room in client.get("/api/v1/rooms").json())


def test_explicit_sync_imports_empty_rooms_from_the_developer_room_catalog(topology_client):
    client, _api = topology_client

    def list_rooms(method, path):
        assert method == "GET"
        if path == "/v1.0/homes/101/rooms":
            return {"home_id": 101, "rooms": [
                {"room_id": 1, "name": "Kitchen"},
                {"room_id": 2, "name": "Hall"},
                {"room_id": 42, "name": "Empty room"},
            ]}
        assert path == "/v1.0/homes/202/rooms"
        return {"home_id": 202, "rooms": []}

    client.app.state.developer_cloud.client = SimpleNamespace(request=list_rooms)
    result = sync(client)
    assert result["empty_rooms_available"] is True
    room = next(room for room in client.get("/api/v1/rooms").json() if room["name"] == "Empty room")
    assert all(row["room_id"] != room["id"] for row in result["placements"])
    assert client.delete(f"/api/v1/rooms/{room['id']}").status_code == 204
    sync(client)
    assert any(room["name"] == "Empty room" for room in client.get("/api/v1/rooms").json())


def test_cached_topology_survives_worker_restart_but_is_account_scoped(topology_client):
    from smarthome.topology import TopologySync

    client, api = topology_client
    original = sync(client)
    client.app.state.topology = TopologySync()
    assert client.get(API + "/topology").json()["placements"] == original["placements"]
    bridge = client.app.state.cloud
    bridge.auth["token_info"]["uid"] = "different-account"
    assert client.get(API + "/topology").json()["placements"] == []
    assert client.get(API + "/topology").json()["job"]["status"] == "idle"
    bridge.logout()
    assert client.get(API + "/topology").status_code == 409
    assert client.post(API + "/topology/sync").status_code == 409


def test_sync_returns_immediately_and_account_change_prevents_late_commit(topology_client):
    client, api = topology_client
    entered, release = threading.Event(), threading.Event()
    api.block = (entered, release)
    started = time.monotonic()
    assert client.post(API + "/topology/sync").status_code == 202
    assert time.monotonic() - started < 1
    assert entered.wait(1)
    # Emulate logout/relogin after a cloud request was dispatched.
    bridge = client.app.state.cloud
    bridge.auth = copy.deepcopy(bridge.auth)
    release.set()
    client.app.state.topology.thread.join(timeout=3)
    assert client.get(API + "/topology").json()["placements"] == []
    assert client.get(API + "/topology").json()["job"]["status"] == "failed"


def test_topology_requires_service_authentication(topology_client):
    client, api = topology_client
    client.headers.pop("X-API-Key")
    assert client.get(API + "/topology").status_code == 401
    assert client.post(API + "/topology/sync").status_code == 401 and not api.calls
