import json
import sqlite3
from threading import RLock
from types import SimpleNamespace

import pytest
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
        if identifier.startswith("relay"):
            return SimpleNamespace(id=identifier, online=True, function={
                "switch_1": SimpleNamespace(type="Boolean"),
                "switch_2": SimpleNamespace(type="Boolean"),
                "switch_3": SimpleNamespace(type="Integer"),
            })
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


def test_power_button_visibility_upgrades_existing_combinations_and_persists(tmp_path):
    db = tmp_path / "combined.sqlite"
    members = [member("cloud-1"), member("cloud-2")]
    with sqlite3.connect(db) as connection:
        connection.execute(
            "CREATE TABLE combined_devices (id INTEGER PRIMARY KEY, name VARCHAR(120) NOT NULL, "
            "room_id INTEGER, members JSON NOT NULL)"
        )
        connection.execute(
            "INSERT INTO combined_devices VALUES (1, 'Existing lights', NULL, ?)",
            (json.dumps([{**entry, "scope": "saved-account"} for entry in members]),),
        )
    settings = Settings(database_path=str(db), display_poll_interval=0)
    with TestClient(create_app(settings)) as client:
        assert client.get(PATH).json()[0]["show_all_power"] is True
        url = f"{PATH}/1"
        hidden = client.put(url, json={"name": "Existing lights", "members": members, "show_all_power": False})
        assert hidden.status_code == 200, hidden.text
        assert hidden.json()["show_all_power"] is False
        legacy_update = client.put(url, json={"name": "Renamed lights", "members": members})
        assert legacy_update.status_code == 200, legacy_update.text
        assert legacy_update.json()["show_all_power"] is False

    with TestClient(create_app(settings)) as client:
        saved = client.get(PATH).json()[0]
        assert saved["name"] == "Renamed lights"
        assert saved["show_all_power"] is False
        restored = client.put(url, json={"name": saved["name"], "members": members, "show_all_power": True})
        assert restored.status_code == 200, restored.text
        assert restored.json()["show_all_power"] is True
    with sqlite3.connect(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (1,)


def wired(target, source="relay", channel="switch_1", route="sharing"):
    return {**member(target, route), "power_source": {"device_id": source, "channel": channel}}


def test_wiring_persists_without_sending_commands_and_can_be_changed(client, direct, factory, monkeypatch):
    bridge = CloudFixture()
    monkeypatch.setattr(client.app.state, "cloud", bridge)
    members = [
        member("relay"),
        wired(direct["device_id"], route="local"),
        wired("bulb-2", channel="switch_2"),
        wired("bulb-3", channel="switch_2"),
    ]
    saved = create(client, *members)
    assert saved["members"] == [{**entry, "accessible": True} for entry in members]
    assert client.get(PATH).json() == [saved]
    url = f'{PATH}/{saved["id"]}'

    # An older client sends only the membership and control routes.
    original_fields = [member(entry["device_id"], entry["route"]) for entry in members]
    response = client.put(url, json={"name": "Renamed", "members": original_fields})
    assert response.status_code == 200
    assert response.json()["members"] == saved["members"]

    original_fields[2]["power_source"] = None
    response = client.put(url, json={"name": "Renamed", "members": original_fields})
    assert response.status_code == 200
    assert "power_source" not in response.json()["members"][2]
    assert response.json()["members"][3]["power_source"] == members[3]["power_source"]

    response = client.put(url, json={"name": "Renamed", "members": original_fields[1:]})
    assert response.status_code == 200
    assert all("power_source" not in entry for entry in response.json()["members"])
    assert factory.commands == bridge.commands == []


def test_a_local_relay_can_supply_a_cloud_device(client, direct, factory, monkeypatch):
    bridge = CloudFixture()
    monkeypatch.setattr(client.app.state, "cloud", bridge)
    source = direct["device_id"]
    target = wired("cloud-bulb", source=source, channel="switch")
    saved = create(client, member(source, "local"), target)
    assert saved["members"][1] == {**target, "accessible": True}
    assert factory.commands == bridge.commands == []


@pytest.mark.parametrize("members, message", [
    ([member("relay"), wired("bulb", source="outside")], "must be part of the combination"),
    ([member("relay"), wired("bulb", channel="switch_4")], "does not expose that relay channel"),
    ([member("relay"), wired("bulb", channel="switch_3")], "does not expose that relay channel"),
    ([wired("relay"), member("bulb")], "cannot form a loop"),
    ([wired("relay", source="relay-2"), wired("relay-2")], "cannot form a loop"),
])
def test_rejects_invalid_wiring(client, monkeypatch, members, message):
    bridge = CloudFixture()
    monkeypatch.setattr(client.app.state, "cloud", bridge)
    response = client.post(PATH, json={"name": "Invalid wiring", "members": members})
    assert response.status_code == 422
    assert message in response.json()["detail"]
    assert client.get(PATH).json() == []
    assert bridge.commands == []
