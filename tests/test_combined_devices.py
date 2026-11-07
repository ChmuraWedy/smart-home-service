from threading import RLock
from types import SimpleNamespace

from fastapi import HTTPException
from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app

PATH = "/api/v1/combined-devices"


class CloudFixture:
    def __init__(self):
        self.auth = {"token_info": {"uid": "fixture-account"}}
        self.lock = RLock()
        self.commands = []

    def close(self):
        pass

    def require_enabled(self):
        pass

    def device(self, identifier):
        if identifier == "missing":
            raise HTTPException(404, "Unknown device")
        return SimpleNamespace(
            id=identifier,
            online=identifier != "cloud-offline",
            function={
                "switch_led": SimpleNamespace(type="Boolean", values="{}"),
                "brightness": SimpleNamespace(type="Integer", values="{}"),
                "motion_switch": SimpleNamespace(type="Boolean", values="{}"),
            },
        )

    writable_device = device

    def send_commands(self, identifier, commands):
        self.commands.append((identifier, commands))
        if identifier == "cloud-timeout":
            raise HTTPException(504, "Timeout")
        return {"acknowledged": True, "state_confirmed": False}


def member(identifier, route="sharing"):
    return {"device_id": identifier, "route": route}


def create(client, *members):
    response = client.post(PATH, json={"name": "Kitchen lights", "members": members})
    assert response.status_code == 201, response.text
    return response.json()


def test_combines_cloud_and_lan_devices_and_reports_partial_power_outcomes(
    client, direct, factory, monkeypatch
):
    bridge = CloudFixture()
    monkeypatch.setattr(client.app.state, "cloud", bridge)
    combination = create(
        client,
        member(direct["device_id"], "local"),
        member("cloud-offline"),
        member("cloud-timeout"),
        member("cloud-bulb"),
    )
    assert factory.commands == []
    assert bridge.commands == []
    assert client.get(PATH).json() == [combination]
    assert all(item["accessible"] for item in combination["members"])
    assert all("scope" not in item for item in combination["members"])
    response = client.post(f'{PATH}/{combination["id"]}/power/off')
    assert response.status_code == 200, response.text
    assert response.json() == {
        "results": [
            {"device_id": direct["device_id"], "outcome": "accepted"},
            {"device_id": "cloud-offline", "outcome": "unavailable"},
            {"device_id": "cloud-timeout", "outcome": "unknown"},
            {"device_id": "cloud-bulb", "outcome": "accepted"},
        ],
    }
    assert factory.commands == [(direct["device_id"], "set_dps", {"1": False})]
    assert bridge.commands == [
        ("cloud-timeout", [{"code": "switch_led", "value": False}]),
        ("cloud-bulb", [{"code": "switch_led", "value": False}]),
    ]

    bridge.auth = {"token_info": {"uid": "different-account"}}
    saved = client.get(PATH).json()[0]
    assert [row["accessible"] for row in saved["members"]] == [True, False, False, False]
    next_results = client.post(f'{PATH}/{combination["id"]}/power/on').json()["results"]
    assert [row["outcome"] for row in next_results] == ["accepted", "unavailable", "unavailable", "unavailable"]
    assert len(bridge.commands) == 2


def test_membership_edit_survives_server_restart_and_delete_restores_inventory(tmp_path):
    db = str(tmp_path / "combined.sqlite")
    settings = Settings(database_path=db, display_poll_interval=0)
    bridge = CloudFixture()
    with TestClient(create_app(settings)) as client:
        original = client.app.state.cloud
        client.app.state.cloud = bridge
        try:
            combination = create(client, member("cloud-1"), member("cloud-2"))
            url = f'{PATH}/{combination["id"]}'
            invalid = client.put(url, json={
                "name": "Updated", "members": [member("cloud-1"), member("cloud-1", "local")],
            })
            assert invalid.status_code == 422
            missing = client.put(url, json={
                "name": "Updated", "members": [member("cloud-1"), member("missing")],
            })
            assert missing.status_code == 404
            assert client.get(PATH).json() == [combination]
            updated = client.put(url, json={
                "name": "Updated", "members": [member("cloud-2"), member("cloud-3")],
            })
            assert updated.status_code == 200
        finally:
            client.app.state.cloud = original

    with TestClient(create_app(settings)) as client:
        persisted = client.get(PATH).json()[0]
        assert persisted["name"] == "Updated"
        assert [entry["device_id"] for entry in persisted["members"]] == ["cloud-2", "cloud-3"]
        assert [entry["accessible"] for entry in persisted["members"]] == [False, False]
        assert client.delete(url).status_code == 204
        assert client.get(PATH).json() == []
    assert bridge.commands == []
