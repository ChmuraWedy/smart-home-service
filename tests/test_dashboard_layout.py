from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app

BROWSER = "1" * 32
OTHER_BROWSER = "2" * 32
PATH = f"/api/v1/dashboard-layouts/{BROWSER}"
VIEW = {"building": "all", "room": "3", "columns": 3, "page": 1}


def test_layout_persists_and_is_isolated(tmp_path):
    settings = Settings(
        database_path=str(tmp_path / "layout.db"), api_token="token", display_poll_interval=0
    )
    layout = {"slots": [None, "device-b", "group-1", None, None, "device-a"]}
    headers = {"X-API-Key": "token"}
    with TestClient(create_app(settings)) as client:
        assert client.get(PATH, params=VIEW).status_code == 401
        assert client.put(PATH, params=VIEW, json=layout).status_code == 401
        assert client.get(PATH, params=VIEW, headers=headers).json() == {"slots": []}
        assert client.put(PATH, params=VIEW, headers=headers, json=layout).json() == layout

    with TestClient(create_app(settings)) as client:
        assert client.get(PATH, params=VIEW, headers=headers).json() == layout
        assert client.get(PATH.replace(BROWSER, OTHER_BROWSER), params=VIEW, headers=headers).json() == {"slots": []}
        for field, value in [("building", "1"), ("room", "none"), ("columns", 2), ("page", 2)]:
            assert client.get(PATH, params={**VIEW, field: value}, headers=headers).json() == {"slots": []}
        updated = {"slots": ["device-b", None, "group-1"]}
        assert client.put(PATH, params=VIEW, headers=headers, json=updated).json() == updated
        assert client.get(PATH, params=VIEW, headers=headers).json() == updated


def test_layout_rejects_invalid_browser_scope_and_slots(client):
    assert client.get(PATH.replace(BROWSER, "invalid"), params=VIEW).status_code == 422
    assert client.get(PATH, params={**VIEW, "columns": 0}).status_code == 422
    assert client.get(PATH, params={**VIEW, "room": "invalid"}).status_code == 422
    for slots in [["device-a", None, "device-a"], ["untyped-card"], [None] * 97]:
        assert client.put(PATH, params=VIEW, json={"slots": slots}).status_code == 422
    assert client.get(PATH, params=VIEW).json() == {"slots": []}


def test_hidden_devices_are_optional_for_older_clients_and_cannot_include_groups(client):
    initial = {"slots": ["device-a", "combined-1", "group-1"], "hidden_devices": ["device-a"]}
    assert client.put(PATH, params=VIEW, json=initial).json() == initial
    assert client.get(PATH, params=VIEW).json() == initial
    legacy = {"slots": ["combined-1", "group-1", "device-a"]}
    assert client.put(PATH, params=VIEW, json=legacy).json() == {**legacy, "hidden_devices": ["device-a"]}
    for hidden_devices in (["combined-1"], ["group-1"], ["device-a", "device-a"]):
        assert client.put(PATH, params=VIEW, json={**legacy, "hidden_devices": hidden_devices}).status_code == 422
    assert client.put(PATH, params=VIEW, json={**legacy, "hidden_devices": []}).json() == legacy
    assert client.get(PATH, params=VIEW).json() == legacy


def test_room_navigation_reuses_browser_scope_and_leaves_card_layouts_intact(tmp_path):
    settings = Settings(
        database_path=str(tmp_path / "rooms.db"), api_token="token", display_poll_interval=0
    )
    path = f"{PATH}/room-navigation"
    headers = {"X-API-Key": "token"}
    cards = {"slots": ["device-a"], "hidden_devices": ["device-b"]}
    with TestClient(create_app(settings)) as client:
        building = client.post("/api/v1/buildings", headers=headers, json={"name": "Home"}).json()
        room_ids = [
            client.post(
                "/api/v1/rooms", headers=headers, json={"name": name, "building_id": building["id"]}
            ).json()["id"]
            for name in ("Hall", "Kitchen")
        ]
        layout = {"rooms": [{"id": room_ids[1], "hidden": True}, {"id": room_ids[0], "hidden": False}]}
        assert client.get(path).status_code == 401
        assert client.put(path, json=layout).status_code == 401
        assert client.get(path, headers=headers).json() == {"rooms": []}
        assert client.put(PATH, params=VIEW, headers=headers, json=cards).json() == cards
        assert client.put(path, headers=headers, json=layout).json() == layout
        assert client.get(PATH, params=VIEW, headers=headers).json() == cards

    with TestClient(create_app(settings)) as client:
        assert client.get(path, headers=headers).json() == layout
        assert client.get(path.replace(BROWSER, OTHER_BROWSER), headers=headers).json() == {"rooms": []}
        assert client.delete(f"/api/v1/rooms/{room_ids[1]}", headers=headers).status_code == 204
        assert client.put(path, headers=headers, json=layout).json() == {"rooms": layout["rooms"][1:]}
        replacement = client.post(
            "/api/v1/rooms", headers=headers, json={"name": "Study", "building_id": building["id"]}
        ).json()
        assert replacement["id"] == room_ids[1]
        assert client.get(path, headers=headers).json() == {"rooms": layout["rooms"][1:]}


def test_room_navigation_rejects_invalid_ids_and_duplicate_rooms(client):
    path = f"{PATH}/room-navigation"
    assert client.get(path.replace(BROWSER, "invalid")).status_code == 422
    for rooms in ([{"id": 1}, {"id": 1, "hidden": True}], [{"id": 0}], [{"id": True}], [{"id": 1, "hidden": "true"}]):
        assert client.put(path, json={"rooms": rooms}).status_code == 422
    assert client.get(path).json() == {"rooms": []}
