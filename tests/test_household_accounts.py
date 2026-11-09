import hashlib

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.models import AccountDashboardLayout, HouseholdDeviceKey, HouseholdMember
from smarthome.tuya import TuyaController

from .conftest import KEY

API = "/api/v1"
OWNER_KEY = "existing-owner-service-key"
OWNER = {"X-API-Key": OWNER_KEY}
BROWSER_ID = "1" * 32
VIEW = {"building": "all", "room": "3", "columns": 3, "page": 1}
PRIVATE = API + "/dashboard-layouts/me"
LEGACY = API + "/dashboard-layouts/" + BROWSER_ID


def create_member(client, name):
    response = client.post(API + "/accounts", headers=OWNER, json={"name": name})
    assert response.status_code == 201, response.text
    assert response.headers["Cache-Control"] == "no-store"
    row = response.json()
    return row, {"X-API-Key": row["access_key"]}


@pytest.fixture
def secured_app(tmp_path, factory):
    settings = Settings(
        database_path=str(tmp_path / "house.db"), api_token=OWNER_KEY, display_poll_interval=0,
        setup_code="unused-initial-owner-setup-code-123", redroid_token_file=str(tmp_path / "redroid.json"),
    )
    return create_app(settings, TuyaController(settings, factory))


def test_credentials_are_individual_and_cannot_manage_accounts(secured_app):
    with TestClient(secured_app) as client:
        assert client.get(API + "/accounts").status_code == 401
        assert client.post(API + "/accounts", headers=OWNER, json={"name": "   "}).status_code == 422
        alex, headers = create_member(client, "  Alex  ")
        sam, _ = create_member(client, "Sam")
        assert alex["name"] == "Alex"
        assert alex["id"] != sam["id"] and alex["access_key"] != sam["access_key"]
        listed = client.get(API + "/accounts", headers=OWNER)
        assert listed.json() == [
            {"id": alex["id"], "name": "Alex", "login": alex["login"], "key_available": True},
            {"id": sam["id"], "name": "Sam", "login": sam["login"], "key_available": True},
        ]
        assert listed.headers["Cache-Control"] == "no-store"
        with Session(secured_app.state.engine) as session:
            member = session.get(HouseholdMember, alex["id"])
            assert member.key_digest == hashlib.sha256(alex["access_key"].encode()).hexdigest()
            key_row = session.get(HouseholdDeviceKey, alex["key_id"])
            assert alex["access_key"].encode() not in key_row.sealed_key
        path = API + "/accounts/" + alex["id"] + "/key"
        assert client.get(path, headers=headers).status_code == 403
        assert client.get(path).status_code == 401
        key = client.get(path, headers=OWNER)
        assert key.json() == {"access_key": alex["access_key"]}
        assert key.headers["Cache-Control"] == "no-store"
        status = client.get(API + "/cloud/status", headers=headers).json()
        assert status["account"] == {
            "id": alex["id"], "name": "Alex", "role": "member", "login": alex["login"],
            "key_id": alex["key_id"], "needs_name": False,
        }
        assert "redroid_available" not in status
        owner_status = client.get(API + "/cloud/status", headers=OWNER).json()
        assert owner_status["account"]["role"] == "owner"
        assert owner_status["redroid_available"] is True
        assert client.get(API + "/setup", headers=headers).json() == {"can_initialize": False}
        assert client.post(
            API + "/setup", headers=headers, json={"setup_code": secured_app.state.settings.setup_code},
        ).status_code == 403  # Non-secure origin.
        assert client.post(
            "https://testserver" + API + "/setup", headers=headers,
            json={"setup_code": secured_app.state.settings.setup_code},
        ).status_code == 409
        assert secured_app.state.settings.api_token == OWNER_KEY
        for method, path in [("GET", "/accounts"), ("POST", "/accounts"), ("DELETE", "/accounts/" + sam["id"])]:
            assert client.request(method, API + path, headers=headers).status_code == 403


def test_existing_hashed_keys_keep_working_without_becoming_recoverable(secured_app):
    token = "shm_" + "a" * 43
    member_id = "a" * 32
    with TestClient(secured_app) as client:
        with Session(secured_app.state.engine) as session:
            session.add(HouseholdMember(
                id=member_id, name="Existing member", login="legacy", key_digest=hashlib.sha256(token.encode()).hexdigest(),
            ))
            session.flush()
            session.add(HouseholdDeviceKey(
                id=member_id, member_id=member_id, name="", key_digest=hashlib.sha256(token.encode()).hexdigest(),
            ))
            session.commit()
        listed = client.get(API + "/accounts", headers=OWNER)
        assert listed.json() == [{"id": member_id, "name": "Existing member", "login": "legacy", "key_available": False}]
        assert client.get(API + "/accounts/" + member_id + "/key", headers=OWNER).status_code == 404
        assert client.get(API + "/cloud/status", headers={"X-API-Key": token}).status_code == 200
        new_member, _ = create_member(client, "New member")

    with TestClient(secured_app) as client:
        result = client.get(API + "/accounts/" + new_member["id"] + "/key", headers=OWNER)
        assert result.json() == {"access_key": new_member["access_key"]}


def test_root_and_members_manage_device_keys_without_sharing_other_users(secured_app):
    with TestClient(secured_app) as client:
        status = client.get(API + "/cloud/status", headers=OWNER).json()["account"]
        assert status["needs_name"] and status["login"] == "root"
        result = client.put(API + "/accounts/owner", headers=OWNER, json={"name": "  Dmitry  ", "login": "Dmitry"})
        assert result.json()["name"] == "Dmitry" and not result.json()["needs_name"]
        assert result.json()["login"] == "Dmitry"
        assert client.post(API + "/accounts", headers=OWNER, json={"name": "Another", "login": "dmitry"}).status_code == 409
        alex = client.post(API + "/accounts", headers=OWNER, json={
            "name": "Alex", "login": "alex", "device_name": "Laptop",
        }).json()
        assert client.post(API + "/accounts", headers=OWNER, json={"name": "Another", "login": "alex"}).status_code == 409
        assert client.post(API + "/accounts", headers=OWNER, json={"name": "Another", "login": "root"}).status_code == 409
        sam, sam_key = create_member(client, "Sam")
        laptop = {"X-API-Key": alex["access_key"]}
        login_path = API + "/accounts/login"
        assert client.post(login_path, headers=laptop, json={"login": "sam"}).status_code == 401
        assert client.post(login_path, headers=laptop, json={"login": " Alex "}).json()["id"] == alex["id"]
        assert client.put(API + "/accounts/owner", headers=laptop, json={"name": "Alex"}).status_code == 403
        assert client.put(API + "/accounts/owner", headers=OWNER, json={"name": "Dmitry", "login": "Alex"}).status_code == 409
        keys_path = API + "/accounts/" + alex["id"] + "/keys"
        assert client.get(keys_path, headers=sam_key).status_code == 403
        for headers in (OWNER, laptop):
            listing = client.get(keys_path, headers=headers)
            assert listing.json() == [{"id": alex["key_id"], "name": "Laptop", "key_available": True}]
            assert alex["access_key"] not in listing.text
        phone = client.post(keys_path, headers=laptop, json={"name": "Phone"})
        assert phone.status_code == 201 and "access_key" not in phone.json()
        phone_path = keys_path + "/" + phone.json()["id"]
        token = client.get(phone_path, headers=laptop).json()["access_key"]
        assert token != alex["access_key"]
        phone_key = {"X-API-Key": token}
        assert client.get(phone_path, headers=OWNER).json() == {"access_key": token}
        assert client.get(phone_path, headers=sam_key).status_code == 403
        assert client.get(API + "/accounts/" + sam["id"] + "/keys/" + phone.json()["id"], headers=OWNER).status_code == 404
        layout = {"slots": ["device-lamp"]}
        assert client.put(PRIVATE, params=VIEW, headers=laptop, json=layout).status_code == 200
        assert client.get(PRIVATE, params=VIEW, headers=phone_key).json() == layout
        assert client.delete(phone_path, headers=laptop).status_code == 204
        assert client.get(PRIVATE, params=VIEW, headers=phone_key).status_code == 401
        assert client.get(PRIVATE, params=VIEW, headers=laptop).json() == layout

        root_keys = API + "/accounts/owner/keys"
        root_device = client.post(root_keys, headers=OWNER, json={"name": "Owner phone"}).json()
        root_path = root_keys + "/" + root_device["id"]
        assert client.get(root_path, headers=laptop).status_code == 403
        device = {"X-API-Key": client.get(root_path, headers=OWNER).json()["access_key"]}
        root = client.post(login_path, headers=device, json={"login": "dmitry"}).json()
        assert root["login"] == "Dmitry" and root["name"] == "Dmitry" and root["role"] == "owner"
        assert client.post(login_path, headers=device, json={"login": "root"}).status_code == 200
        assert client.delete(root_path, headers=device).status_code == 204
        assert client.get(API + "/accounts", headers=device).status_code == 401
        assert client.get(API + "/accounts", headers=OWNER).status_code == 200


def test_layout_is_private_across_browsers_and_revocation_removes_it(secured_app):
    with TestClient(secured_app) as client:
        alex, alex_key = create_member(client, "Alex")
        _, sam_key = create_member(client, "Sam")
        old_layout = {"slots": ["device-old"], "hidden_devices": ["device-old"]}
        new_layout = {"slots": ["device-owner"]}
        alex_layout = {"slots": [None, "device-alex"], "hidden_devices": ["device-alex"]}
        sam_layout = {"slots": ["device-sam"]}
        legacy_view = {**VIEW, "browser_id": BROWSER_ID}
        assert client.put(LEGACY, params=VIEW, headers=OWNER, json=old_layout).json() == old_layout
        assert client.get(PRIVATE, params=legacy_view, headers=OWNER).json() == old_layout
        assert client.get(PRIVATE, params=legacy_view, headers=alex_key).json() == {"slots": []}
        assert client.get(LEGACY, params=VIEW, headers=alex_key).status_code == 403
        assert client.put(LEGACY, params=VIEW, headers=alex_key, json=sam_layout).status_code == 403
        for headers, layout in [(alex_key, alex_layout), (sam_key, sam_layout), (OWNER, new_layout)]:
            assert client.put(PRIVATE, params=VIEW, headers=headers, json=layout).json() == layout
        assert client.get(PRIVATE, params={**VIEW, "room": "4"}, headers=alex_key).json() == {"slots": []}
        assert client.get(LEGACY, params=VIEW, headers=OWNER).json() == old_layout

    with TestClient(secured_app) as new_browser:
        for headers, layout in [(alex_key, alex_layout), (sam_key, sam_layout), (OWNER, new_layout)]:
            result = new_browser.get(PRIVATE, params=VIEW, headers=headers)
            assert result.json() == layout
            assert result.headers["Cache-Control"] == "no-store"
        assert new_browser.delete(API + "/accounts/" + alex["id"], headers=OWNER).status_code == 204
        for method, path in [("GET", PRIVATE), ("PUT", PRIVATE), ("GET", API + "/devices")]:
            assert new_browser.request(method, path, params=VIEW, headers=alex_key, json=alex_layout).status_code == 401
        with Session(secured_app.state.engine) as session:
            assert session.scalar(select(AccountDashboardLayout).where(AccountDashboardLayout.account_id == alex["id"])) is None
        assert new_browser.get(PRIVATE, params=VIEW, headers=sam_key).json() == sam_layout


def test_room_navigation_and_hidden_cards_are_isolated_and_cleaned_up(secured_app):
    with TestClient(secured_app) as client:
        _, alex = create_member(client, "Alex")
        _, sam = create_member(client, "Sam")
        home = client.post(API + "/buildings", headers=OWNER, json={"name": "Home"}).json()
        room = client.post(API + "/rooms", headers=OWNER, json={
            "name": "Office", "building_id": home["id"],
        }).json()
        view = {**VIEW, "room": str(room["id"])}
        private_path = PRIVATE + "/room-navigation"
        legacy_path = LEGACY + "/room-navigation"
        preferences = {"rooms": [{"id": room["id"], "hidden": True}]}
        assert client.put(legacy_path, headers=OWNER, json=preferences).json() == preferences
        assert client.get(legacy_path, headers=alex).status_code == 403
        assert client.get(private_path, headers=alex).json() == {"rooms": []}
        result = client.put(private_path, headers=alex, json=preferences)
        assert result.json() == preferences and result.headers["Cache-Control"] == "no-store"
        assert client.get(private_path, headers=sam).json() == {"rooms": []}
        hidden = {"slots": ["device-light"], "hidden_devices": ["device-light"]}
        assert client.put(PRIVATE, headers=alex, params=view, json=hidden).json() == hidden

        path = API + "/rooms/" + str(room["id"])
        assert client.get(path + "/appearance", headers=alex).status_code == 200
        assert client.patch(path, headers=alex, json={"name": "New name"}).status_code == 403
        assert client.delete(path, headers=OWNER).status_code == 204
        assert client.get(private_path, headers=alex).json() == {"rooms": []}
        assert client.get(legacy_path, headers=OWNER).json() == {"rooms": []}
        assert client.get(PRIVATE, headers=alex, params=view).json() == {"slots": []}


def test_members_cannot_read_or_command_local_cameras(secured_app, factory):
    with TestClient(secured_app) as client:
        _, member = create_member(client, "Alex")
        device = client.post(API + "/devices", headers=OWNER, json={
            "name": "Camera", "device_id": "camera", "category": "sp", "ip": "192.168.1.41",
            "local_key": KEY, "version": "3.5", "capabilities": {"switch": {"dp": "1", "type": "boolean"}},
        }).json()
        path = API + f"/devices/{device['id']}"
        assert client.get(API + "/devices", headers=member).json() == []
        assert client.get(path, headers=member).status_code == 403
        assert client.get(path + "/state?refresh=true", headers=member).status_code == 403
        assert client.post(path + "/commands/capabilities", headers=member, json={
            "values": {"switch": True},
        }).status_code == 403
        assert not factory.commands
        assert client.get(path + "/state", headers=OWNER).status_code == 200


def test_member_controls_are_limited_to_typed_household_actions(secured_app, factory):
    with TestClient(secured_app) as client:
        _, member = create_member(client, "Alex")
        direct = client.post(API + "/devices", headers=OWNER, json={
            "name": "Outlet", "device_id": "outlet", "ip": "192.168.1.40", "local_key": KEY,
            "mac": "02:00:00:00:00:01", "version": "3.5",
            "capabilities": {"switch": {"dp": "1", "type": "boolean"}, "format": {"dp": "2", "type": "boolean"}},
        }).json()
        path = API + f"/devices/{direct['id']}"
        for method, endpoint, payload in [
            ("PATCH", path, {"name": "Changed"}),
            ("POST", path + "/commands/on", {"dp": "2"}),
            ("POST", path + "/commands/set_dps", {"dps": {"2": True}}),
            ("PUT", path + "/capabilities/format", {"value": True}),
            ("GET", API + "/network/interfaces", None),
            ("GET", API + "/cloud/login/known-session/qr.svg", None),
            ("PUT", API + "/cloud/developer/credentials", {}),
            ("POST", API + "/cloud/login/redroid/credentials", {}),
            ("POST", API + "/cloud/login/redroid/qr", {}),
            ("POST", API + "/cloud/login/redroid/known-session/confirm", {}),
            ("GET", API + "/combined-devices", None),
            ("POST", API + "/combined-devices/1/power/on", {}),
            ("POST", API + "/light-presets/outlet", {}),
            ("POST", API + "/cloud/devices/known-camera/stream", {}),
            ("POST", API + "/cloud/devices/known-camera/stream/relay", {}),
        ]:
            assert client.request(method, endpoint, headers=member, json=payload).status_code == 403
        assert client.post(path + "/commands/capabilities", headers=member, json={
            "values": {"switch": True, "format": True},
        }).status_code == 403
        assert not factory.commands
        row = client.get(path, headers=member).json()
        assert row["name"] == "Outlet" and row["ip"] is None and row["mac"] is None
        assert row["capabilities"]["switch"]["writable"] is True
        assert row["capabilities"]["format"]["writable"] is False
        allowed = client.post(path + "/commands/capabilities", headers=member, json={"values": {"switch": True}})
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()["dps"] == {}
        assert factory.commands == [("outlet", "set_dps", {"1": True})]
        assert client.get(path, headers=member).json()["last_dps"] is None
        assert client.get(path, headers=OWNER).json()["last_dps"] is not None


def test_open_development_mode_preserves_legacy_routes_and_rejects_provisioning(client):
    assert client.get(API + "/devices").status_code == 200
    assert client.get(API + "/cloud/status").json().get("account") is None
    assert client.get(API + "/accounts").status_code == 403
    assert client.post(API + "/accounts", json={"name": "Alex"}).status_code == 403
    assert client.get(PRIVATE, params=VIEW).status_code == 403
    assert client.put(LEGACY, params=VIEW, json={"slots": ["device-1"]}).status_code == 200
