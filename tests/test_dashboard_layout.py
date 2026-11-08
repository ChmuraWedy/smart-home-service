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
