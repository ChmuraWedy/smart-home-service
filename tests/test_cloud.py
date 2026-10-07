import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from smarthome.cloud import CloudBridge
from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.models import Device

API = "/api/v1/cloud"
SECRET = "secret-cloud-access"
REFRESH = "secret-cloud-refresh"
KEY = "0123456789abcdef"


class FakeLogin:
    success = True
    ready = True

    def qr_code(self, client_id, schema, user_code):
        self.user_code = user_code
        return {"success": self.success, "result": {"qrcode": "qr-secret"}, "access_token": SECRET}

    def login_result(self, qr, client_id, user_code):
        return self.ready, {
            "terminal_id": "terminal",
            "endpoint": "https://apigw.iotbing.com",
            "t": 100,
            "uid": "user",
            "expire_time": 3600,
            "access_token": SECRET,
            "refresh_token": REFRESH,
        }


class FakeAPI:
    def __init__(self):
        self.calls = []
        self.success = True

    def post(self, path, params, body):
        self.calls.append((path, body))
        return {"success": self.success, "result": True, "access_token": SECRET}


class FakeManager:
    def __init__(self, client, user_code, terminal, endpoint, tokens, listener):
        self.listener = listener
        self.device_map = {}
        self.customer_api = FakeAPI()
        self.refreshes = 0

    def update_device_cache(self):
        self.refreshes += 1
        self.device_map = {
            device.id: device
            for device in [
                SimpleNamespace(
                    id="gateway",
                    name="Gateway",
                    local_key=KEY,
                    ip="203.0.113.10",
                    sub=False,
                    category="zigbee",
                    product_id="prod",
                    online=True,
                    support_local=True,
                    node_id=None,
                    status={"switch": True},
                    function={
                        "switch": SimpleNamespace(code="switch", type="Boolean", values="{}")
                    },
                ),
                SimpleNamespace(
                    id="child",
                    name="Sensor",
                    local_key=KEY,
                    ip="",
                    sub=True,
                    category="wsdcg",
                    product_id="sensor",
                    online=True,
                    support_local=True,
                    node_id="node-1",
                    status={"temp_current": 215, "local_key": KEY},
                    function={},
                ),
            ]
        }

    def query_scenes(self):
        return [
            SimpleNamespace(
                scene_id="scene-1",
                name="Вечер",
                home_id=1,
                enabled=True,
                actions=[{"secret": SECRET}],
            )
        ]

    def unload(self):
        raise AssertionError("Must not revoke the shared terminal automatically")


@pytest.fixture
def cloud_client(tmp_path):
    settings = Settings(
        database_path=str(tmp_path / "inventory.db"),
        cloud_session_path=str(tmp_path / "cloud.json"),
        cloud_enabled=True,
        api_token="test-api-key",
        display_poll_interval=0,
    )
    with TestClient(create_app(settings)) as client:
        client.headers["X-API-Key"] = "test-api-key"
        client.app.state.cloud = CloudBridge(settings, FakeLogin, FakeManager)
        yield client


def login(client):
    response = client.post(API + "/login/qr", json={"user_code": "user-code-private"})
    assert response.status_code == 201
    id = response.json()["session_id"]
    result = client.post(API + f"/login/{id}/confirm")
    assert result.status_code == 200, result.text
    return id


def test_qr_flow_uses_local_renderer_and_never_returns_tokens(cloud_client):
    client = cloud_client
    response = client.post(API + "/login/qr", json={"user_code": "user-code-private"})
    assert response.status_code == 201
    assert "qr-secret" not in response.text and "user-code-private" not in response.text
    qr = client.get(response.json()["qr_url"])
    assert (
        qr.status_code == 200
        and qr.headers["cache-control"] == "no-store"
        and b"<svg" in qr.content
    )
    result = client.post(API + "/login/" + response.json()["session_id"] + "/confirm")
    assert result.json()["tokens_stored_on_server"] is True
    for secret in [SECRET, REFRESH, "user-code-private"]:
        assert secret not in result.text
    path = client.app.state.cloud.path
    assert path.stat().st_mode & 0o777 == 0o600
    saved = json.loads(path.read_text())
    assert saved["token_info"]["access_token"] == SECRET
    assert saved["user_code"] == "user-code-private"
    status = client.get(API + "/status")
    assert status.json()["connected"] is True
    assert status.json()["has_saved_user_code"] is True
    assert "user-code-private" not in status.text


@pytest.mark.parametrize("body", [{}, {"user_code": None}])
def test_repeat_qr_requires_a_saved_code_or_confirmed_login(cloud_client, body):
    assert cloud_client.get(API + "/status").json()["has_saved_user_code"] is False
    assert cloud_client.post(API + "/login/qr", json=body).status_code == 422
    bridge = cloud_client.app.state.cloud
    assert bridge.auth is None and bridge.pending == {} and not bridge.path.exists()


def test_save_user_code_before_qr_is_private_persistent_and_does_not_connect(cloud_client):
    bridge = cloud_client.app.state.cloud

    def no_network(*args):
        raise AssertionError("Saving User Code must not contact Tuya")

    bridge.login_factory = bridge.manager_factory = no_network
    response = cloud_client.put(API + "/user-code", json={"user_code": "  saved-private-code  "})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "has_saved_user_code": True,
        "connected": False,
        "saved_user_code_requires_login": True,
    }
    assert "saved-private-code" not in response.text
    assert bridge.auth is None and bridge.manager is None and bridge.pending == {}
    assert json.loads(bridge.path.read_text()) == {"saved_user_code": "saved-private-code"}
    assert bridge.path.stat().st_mode & 0o777 == 0o600
    restarted = CloudBridge(bridge.settings, FakeLogin, FakeManager)
    cloud_client.app.state.cloud = restarted
    status = cloud_client.get(API + "/status")
    assert status.json()["has_saved_user_code"] is True
    assert status.json()["connected"] is False
    assert status.json()["saved_user_code_requires_login"] is True
    assert "saved-private-code" not in status.text
    assert cloud_client.get(API + "/devices").status_code == 409
    start = cloud_client.post(API + "/login/qr", json={})
    assert start.status_code == 201
    assert restarted.pending[start.json()["session_id"]]["user_code"] == "saved-private-code"
    assert cloud_client.delete(API + "/session").status_code == 200
    assert not restarted.path.exists()
    assert cloud_client.get(API + "/status").json()["has_saved_user_code"] is False


def test_saved_new_code_preserves_active_account_until_qr_confirmation(cloud_client):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    bridge.devices()
    manager, auth = bridge.manager, dict(bridge.auth)
    old_qr = cloud_client.post(API + "/login/qr", json={}).json()
    response = cloud_client.put(API + "/user-code", json={"user_code": "other-private-code"})
    assert response.json()["connected"] is True
    assert response.json()["saved_user_code_requires_login"] is True
    assert "other-private-code" not in response.text
    assert bridge.auth == auth and bridge.manager is manager
    assert cloud_client.get(old_qr["qr_url"]).status_code == 404
    tokens = {**auth["token_info"], "access_token": "refreshed-access"}
    manager.listener.update_token(tokens)
    restarted = CloudBridge(bridge.settings, FakeLogin, FakeManager)
    cloud_client.app.state.cloud = restarted
    assert restarted.auth["user_code"] == "user-code-private"
    assert restarted.auth["token_info"] == tokens
    assert restarted.login_user_code == "other-private-code"
    start = cloud_client.post(API + "/login/qr", json={}).json()
    assert restarted.pending[start["session_id"]]["user_code"] == "other-private-code"
    assert cloud_client.post(API + "/login/" + start["session_id"] + "/confirm").status_code == 200
    assert restarted.auth["user_code"] == "other-private-code"
    assert cloud_client.get(API + "/status").json()["saved_user_code_requires_login"] is False


def test_failed_user_code_save_preserves_previous_code_account_and_pending_qr(cloud_client, monkeypatch):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    stored = bridge.path.read_text()
    start = cloud_client.post(API + "/login/qr", json={}).json()

    def broken_save(*args):
        raise OSError(SECRET + "other-private-code")

    monkeypatch.setattr("smarthome.cloud.os.replace", broken_save)
    response = cloud_client.put(API + "/user-code", json={"user_code": "other-private-code"})
    assert response.status_code == 503
    assert SECRET not in response.text and "other-private-code" not in response.text
    assert bridge.path.read_text() == stored and bridge.login_user_code == "user-code-private"
    assert bridge.auth["user_code"] == "user-code-private"
    assert start["session_id"] in bridge.pending
    assert list(bridge.path.parent.glob(".cloud-*")) == []


def test_failed_confirmation_keeps_saved_preference_and_connected_account(cloud_client, monkeypatch):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    cloud_client.put(API + "/user-code", json={"user_code": "saved-next-code"})
    start = cloud_client.post(API + "/login/qr", json={"user_code": "third-private-code"}).json()
    stored = bridge.path.read_text()

    def broken_save(*args):
        raise OSError(SECRET)

    monkeypatch.setattr("smarthome.cloud.os.replace", broken_save)
    response = cloud_client.post(API + "/login/" + start["session_id"] + "/confirm")
    assert response.status_code == 503 and SECRET not in response.text
    assert bridge.auth["user_code"] == "user-code-private"
    assert bridge.login_user_code == "saved-next-code"
    assert bridge.path.read_text() == stored
    assert list(bridge.path.parent.glob(".cloud-*")) == []


def test_legacy_session_reuses_its_confirmed_user_code(cloud_client):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    bridge.path.write_text(json.dumps(bridge.auth))
    restarted = CloudBridge(bridge.settings, FakeLogin, FakeManager)
    assert restarted.saved_user_code is None
    assert restarted.login_user_code == "user-code-private"
    assert restarted.saved_code_requires_login is False


@pytest.mark.parametrize("stored", [
    {"saved_user_code": None},
    {"saved_user_code": " "},
    {"saved_user_code": "x" * 129},
    {"saved_user_code": "code", "token_info": {}},
])
def test_malformed_saved_code_files_are_rejected(cloud_client, stored):
    bridge = cloud_client.app.state.cloud
    bridge.path.write_text(json.dumps(stored))
    with pytest.raises(ValueError):
        CloudBridge(bridge.settings, FakeLogin, FakeManager)


def test_user_code_save_requires_authorization_and_valid_secret_input(cloud_client):
    cloud_client.headers.clear()
    assert cloud_client.put(API + "/user-code", json={"user_code": SECRET}).status_code == 401
    cloud_client.headers["X-API-Key"] = "test-api-key"
    for body in ({}, {"user_code": ""}, {"user_code": " "}, {"user_code": None},
                 {"user_code": "x" * 129}, {"user_code": {"bad": SECRET}}):
        response = cloud_client.put(API + "/user-code", json=body)
        assert response.status_code == 422 and SECRET not in response.text
    bridge = cloud_client.app.state.cloud
    assert not bridge.path.exists() and bridge.login_user_code is None


def test_repeat_qr_reuses_saved_code_after_restart_without_disclosure(cloud_client):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    restarted = CloudBridge(bridge.settings, FakeLogin, FakeManager)
    cloud_client.app.state.cloud = restarted
    response = cloud_client.post(API + "/login/qr", json={})
    assert response.status_code == 201
    item = restarted.pending[response.json()["session_id"]]
    assert item["login"].user_code == "user-code-private"
    for secret in ("user-code-private", SECRET, REFRESH):
        assert secret not in response.text
    assert restarted.path.stat().st_mode & 0o777 == 0o600


def test_failed_or_expired_repeat_login_keeps_saved_code(cloud_client):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    response = cloud_client.post(API + "/login/qr", json={})
    id = response.json()["session_id"]
    bridge.pending[id]["login"].ready = False
    assert cloud_client.post(API + f"/login/{id}/confirm").status_code == 409
    bridge.pending[id]["expires"] = 0
    assert cloud_client.get(response.json()["qr_url"]).status_code == 410
    assert cloud_client.post(API + "/login/qr", json={}).status_code == 201
    assert bridge.auth["user_code"] == "user-code-private"
    assert json.loads(bridge.path.read_text())["user_code"] == "user-code-private"


def test_new_user_code_replaces_saved_account_only_after_confirmation(cloud_client):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    response = cloud_client.post(API + "/login/qr", json={"user_code": "another-private-code"})
    id = response.json()["session_id"]
    assert bridge.pending[id]["login"].user_code == "another-private-code"
    assert bridge.auth["user_code"] == "user-code-private"
    assert json.loads(bridge.path.read_text())["user_code"] == "user-code-private"
    bridge.pending[id]["login"].ready = False
    assert cloud_client.post(API + f"/login/{id}/confirm").status_code == 409
    repeat = cloud_client.post(API + "/login/qr", json={}).json()
    assert bridge.pending[repeat["session_id"]]["user_code"] == "user-code-private"
    bridge.pending[id]["login"].ready = True
    assert cloud_client.post(API + f"/login/{id}/confirm").status_code == 200
    restarted = CloudBridge(bridge.settings, FakeLogin, FakeManager)
    cloud_client.app.state.cloud = restarted
    repeat = cloud_client.post(API + "/login/qr", json={})
    assert repeat.status_code == 201 and "another-private-code" not in repeat.text
    assert restarted.pending[repeat.json()["session_id"]]["user_code"] == "another-private-code"


def test_refresh_tokens_are_persisted_for_restart(cloud_client):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    bridge.devices()
    tokens = {
        **bridge.auth["token_info"],
        "access_token": "new-access",
        "refresh_token": "new-refresh",
    }
    bridge.manager.listener.update_token(tokens)
    restarted = CloudBridge(bridge.settings, FakeLogin, FakeManager)
    assert restarted.auth["token_info"]["access_token"] == "new-access"
    assert restarted.manager is None


def test_devices_and_scene_results_are_whitelisted(cloud_client):
    login(cloud_client)
    response = cloud_client.get(API + "/devices")
    assert response.status_code == 200 and response.json()[0]["has_local_key"] is True
    for secret in [KEY, SECRET, REFRESH]:
        assert secret not in response.text
    assert "local_key" not in response.json()[0]
    scenes = cloud_client.get(API + "/scenes")
    assert scenes.json() == [{"id": "scene-1", "name": "Вечер", "home_id": "1", "enabled": True}]
    assert SECRET not in scenes.text
    status = cloud_client.get(API + "/devices/child/status")
    assert (
        status.status_code == 200
        and KEY not in status.text
        and "local_key" not in status.json()["status"]
    )


def test_cloud_import_requires_explicit_gateway_and_preserves_secrets(cloud_client):
    login(cloud_client)
    body = {"device_ids": ["gateway", "child"]}
    assert cloud_client.post(API + "/imports/local-inventory", json=body).status_code == 422
    assert cloud_client.get("/api/v1/devices").json() == []
    body["parent_map"] = {"child": "gateway"}
    assert (
        cloud_client.post(
            API + "/imports/local-inventory", json={**body, "dry_run": True}
        ).status_code
        == 200
    )
    assert cloud_client.get("/api/v1/devices").json() == []
    response = cloud_client.post(API + "/imports/local-inventory", json=body)
    assert response.status_code == 200 and KEY not in response.text
    devices = cloud_client.get("/api/v1/devices").json()
    parent, child = devices
    assert parent["ip"] is None and parent["version"] is None and parent["has_local_key"] is True
    assert (
        child["transport"] == "zigbee"
        and child["cid"] == "node-1"
        and child["parent_id"] == parent["id"]
    )
    with Session(cloud_client.app.state.engine) as session:
        assert all(d.local_key == KEY for d in session.scalars(select(Device)).all())


def test_cloud_command_checks_ack_without_claiming_physical_state(cloud_client):
    login(cloud_client)
    path = API + "/devices/gateway/commands"
    result = cloud_client.post(path, json={"commands": [{"code": "switch", "value": True}]})
    assert result.status_code == 200 and result.json()["state_confirmed"] is False
    manager = cloud_client.app.state.cloud.manager
    assert manager.customer_api.calls == [
        ("/v1.1/m/thing/gateway/commands", {"commands": [{"code": "switch", "value": True}]})
    ]
    assert SECRET not in result.text
    for commands in [
        [{"code": "missing", "value": True}],
        [{"code": "switch", "value": "true"}],
        [{"code": "switch", "value": True}] * 2,
    ]:
        assert cloud_client.post(path, json={"commands": commands}).status_code == 422
    assert len(manager.customer_api.calls) == 1
    manager.customer_api.success = False
    assert (
        cloud_client.post(path, json={"commands": [{"code": "switch", "value": False}]}).status_code
        == 502
    )


def test_pending_expired_and_malformed_authorization_are_safe(cloud_client):
    start = cloud_client.post(API + "/login/qr", json={"user_code": "code"}).json()
    item = cloud_client.app.state.cloud.pending[start["session_id"]]
    item["login"].ready = False
    assert cloud_client.post(API + "/login/" + start["session_id"] + "/confirm").status_code == 409
    item["expires"] = 0
    assert cloud_client.get(start["qr_url"]).status_code == 410
    assert cloud_client.get(API + "/login/unknown/qr.svg").status_code == 404


def test_logout_deletes_only_our_local_session(cloud_client):
    login(cloud_client)
    cloud_client.get(API + "/devices")
    path = cloud_client.app.state.cloud.path
    response = cloud_client.delete(API + "/session")
    assert response.json()["remote_authorization_revoked"] is False and not path.exists()
    assert cloud_client.get(API + "/devices").status_code == 409
    assert cloud_client.get(API + "/status").json()["has_saved_user_code"] is False
    assert cloud_client.post(API + "/login/qr", json={}).status_code == 422


def test_cloud_is_optional_and_requires_api_token(tmp_path):
    with TestClient(create_app(Settings(database_path=str(tmp_path / "disabled.db")))) as client:
        assert client.post(API + "/login/qr", json={"user_code": "code"}).status_code == 503
        assert client.put(API + "/user-code", json={"user_code": "code"}).status_code == 503
        assert client.get(API + "/status").json()["enabled"] is False
    with TestClient(
        create_app(Settings(database_path=str(tmp_path / "no-token.db"), cloud_enabled=True))
    ) as client:
        assert client.post(API + "/login/qr", json={"user_code": "code"}).status_code == 503
        assert client.put(API + "/user-code", json={"user_code": "code"}).status_code == 503


def test_qr_routes_require_authorization_and_validate_inputs(cloud_client):
    cloud_client.headers.clear()
    assert cloud_client.post(API + "/login/qr", json={"user_code": "code"}).status_code == 401
    cloud_client.headers["X-API-Key"] = "test-api-key"
    response = cloud_client.post(API + "/login/qr", json={"user_code": {"bad": SECRET}})
    assert response.status_code == 422 and SECRET not in response.text
    assert cloud_client.post(API + "/login/qr", json={"user_code": ""}).status_code == 422


def test_upstream_failure_never_leaks_token(cloud_client):
    class UnsafeLogin(FakeLogin):
        def qr_code(self, *args):
            raise RuntimeError(SECRET + KEY)

    cloud_client.app.state.cloud.login_factory = UnsafeLogin
    response = cloud_client.post(API + "/login/qr", json={"user_code": "code"})
    assert response.status_code == 502 and SECRET not in response.text and KEY not in response.text


def test_local_key_metadata_cloud_does_not_override_custom_aliases(cloud_client):
    login(cloud_client)
    cloud_client.post(
        "/api/v1/devices",
        json={
            "name": "Our name",
            "device_id": "gateway",
            "aliases": ["stable"],
            "ip": "192.168.1.20",
            "version": "3.5",
        },
    )
    response = cloud_client.post(API + "/imports/local-inventory", json={"device_ids": ["gateway"]})
    assert response.status_code == 200
    device = cloud_client.get("/api/v1/devices/stable").json()
    assert device["version"] == "3.5" and device["ip"] == "192.168.1.20"
    assert device["aliases"] == ["Gateway", "stable"]
