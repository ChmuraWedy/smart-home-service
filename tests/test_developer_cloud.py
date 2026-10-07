import hashlib
import hmac
import io
import json
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from smarthome.config import Settings
from smarthome.developer_cloud import REGIONS, DeveloperBridge, DeveloperClient, signature
from smarthome.main import create_app
from smarthome.models import Device
from tests.test_cloud import CloudBridge, FakeLogin, FakeManager, login

API = "/api/v1/cloud"
CREDENTIALS = {
    "access_id": "test-developer-id",
    "access_secret": "test-developer-secret",
    "region": "eu",
    "sample_device_id": None,
}
KEY = "0123456789abcdef"
TOKEN = "test-developer-token"


class FakeDeveloper:
    failure = None

    def __init__(self, credentials, timeout):
        self.credentials, self.timeout, self.calls = credentials, timeout, []

    def authenticate(self):
        self.calls.append(("AUTH",))
        if self.failure:
            raise RuntimeError(self.failure)

    def devices(self):
        self.calls.append(("LIST",))
        return [
            {
                "id": "wifi",
                "name": "WiFi light",
                "local_key": KEY,
                "ip": "192.168.1.4",
                "sub": False,
                "online": True,
            },
            {
                "id": "gateway",
                "name": "Gateway",
                "local_key": KEY,
                "ip": "203.0.113.4",
                "sub": False,
            },
            {
                "id": "child",
                "name": "Child",
                "node_id": "cid-4",
                "gateway_id": "gateway",
                "sub": True,
            },
        ]

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if self.failure:
            raise RuntimeError(self.failure)
        if path.endswith("/status"):
            return [{"code": "switch", "value": True}, {"code": "local_key", "value": KEY}]
        if path.endswith("/functions"):
            return {
                "functions": [
                    {"code": "switch", "type": "Boolean", "values": "{}"},
                    {
                        "code": "bright",
                        "type": "value",
                        "values": {"min": 10, "max": 1000, "step": 10},
                    },
                    {"code": "mode", "type": "Enum", "values": '{"range":["white","colour"]}'},
                ]
            }
        return True


@pytest.fixture
def developer(tmp_path):
    settings = Settings(
        database_path=str(tmp_path / "inventory.db"),
        api_token="test-api-key",
        cloud_enabled=True,
        display_poll_interval=0,
    )
    with TestClient(create_app(settings)) as client:
        client.headers["X-API-Key"] = "test-api-key"
        client.app.state.developer_cloud = DeveloperBridge(settings, FakeDeveloper)
        client.app.state.cloud = CloudBridge(settings, FakeLogin, FakeManager)
        yield client


def connect(client):
    assert client.put(API + "/developer/credentials", json=CREDENTIALS).status_code == 200
    response = client.post(API + "/developer/connect")
    assert response.status_code == 200, response.text
    return client.app.state.developer_cloud


def test_developer_save_restart_privacy_and_qr_independence(developer):
    login(developer)
    sharing = developer.app.state.cloud
    original = sharing.path.read_text()
    bridge = developer.app.state.developer_cloud
    response = developer.put(API + "/developer/credentials", json=CREDENTIALS)
    assert response.json()["configured"] is True and response.json()["connected"] is False
    assert response.headers["cache-control"] == "no-store"
    assert json.loads(bridge.path.read_text()) == CREDENTIALS
    assert bridge.path.stat().st_mode & 0o777 == 0o600
    restarted = DeveloperBridge(bridge.settings, FakeDeveloper)
    assert restarted.status()["configured"] and not restarted.status()["connected"]
    assert sharing.path.read_text() == original and sharing.auth is not None
    assert CREDENTIALS["access_secret"] not in response.text
    status = developer.get(API + "/status")
    assert status.json()["connected"] and status.json()["developer"]["configured"]
    for secret in (CREDENTIALS["access_id"], CREDENTIALS["access_secret"], TOKEN):
        assert secret not in status.text
    assert developer.get(API + "/devices?provider=developer").status_code == 409
    assert developer.post(API + "/developer/connect").json()["device_count"] == 3
    assert sharing.path.read_text() == original
    assert (
        developer.delete(API + "/developer/credentials").json()["remote_authorization_revoked"]
        is False
    )
    assert not bridge.path.exists() and bridge.client is None
    assert sharing.path.read_text() == original


def test_save_failure_preserves_active_developer_connection(developer, monkeypatch):
    bridge = connect(developer)
    stored, client = bridge.path.read_text(), bridge.client

    def fail(*args):
        raise OSError(CREDENTIALS["access_secret"])

    monkeypatch.setattr("smarthome.developer_cloud.os.replace", fail)
    response = developer.put(
        API + "/developer/credentials", json={**CREDENTIALS, "access_secret": "new-private-secret"}
    )
    assert response.status_code == 503 and CREDENTIALS["access_secret"] not in response.text
    assert bridge.path.read_text() == stored and bridge.client is client
    assert list(bridge.path.parent.glob(".developer-*")) == []


def test_new_credentials_clear_only_developer_cache(developer):
    login(developer)
    bridge = connect(developer)
    assert (
        developer.put(
            API + "/developer/credentials", json={**CREDENTIALS, "region": "us"}
        ).status_code
        == 200
    )
    assert bridge.client is None and bridge.cache is None
    assert developer.get(API + "/status").json()["connected"] is True
    assert developer.get(API + "/devices?provider=developer").status_code == 409


@pytest.mark.parametrize(
    "changes",
    [
        {"access_secret": ""},
        {"access_secret": None},
        {"access_secret": {"bad": TOKEN}},
        {"access_id": " "},
        {"access_secret": "bad\nsecret"},
        {"access_secret": "x" * 257},
        {"region": "https://untrusted.example"},
        {"sample_device_id": " "},
    ],
)
def test_developer_invalid_inputs_are_private(developer, changes):
    response = developer.put(API + "/developer/credentials", json={**CREDENTIALS, **changes})
    assert response.status_code == 422
    assert CREDENTIALS["access_secret"] not in response.text and TOKEN not in response.text
    assert not developer.app.state.developer_cloud.path.exists()


def test_developer_missing_auth_disabled_and_missing_credentials(developer, tmp_path):
    assert developer.post(API + "/developer/connect").status_code == 409
    developer.headers.clear()
    for path, method in [
        ("/developer/status", "get"),
        ("/developer/connect", "post"),
        ("/developer/credentials", "delete"),
    ]:
        assert getattr(developer, method)(API + path).status_code == 401
    assert developer.put(API + "/developer/credentials", json=CREDENTIALS).status_code == 401
    for enabled in (False, True):
        with TestClient(
            create_app(
                Settings(
                    database_path=str(tmp_path / f"{enabled}.db"),
                    cloud_enabled=enabled,
                    display_poll_interval=0,
                )
            )
        ) as client:
            assert client.put(API + "/developer/credentials", json=CREDENTIALS).status_code == 503
            assert client.post(API + "/developer/connect").status_code == 503


def test_failed_connect_hides_errors_and_preserves_qr(developer, monkeypatch):
    login(developer)
    developer.put(API + "/developer/credentials", json=CREDENTIALS)
    monkeypatch.setattr(FakeDeveloper, "failure", CREDENTIALS["access_secret"] + TOKEN)
    response = developer.post(API + "/developer/connect")
    assert response.status_code == 502
    assert CREDENTIALS["access_secret"] not in response.text and TOKEN not in response.text
    assert developer.app.state.developer_cloud.client is None
    assert developer.get(API + "/status").json()["connected"]


def test_developer_inventory_status_functions_and_parent_cid_import(developer):
    connect(developer)
    rows = developer.get(API + "/devices?provider=developer&refresh=true")
    assert rows.status_code == 200 and rows.headers["cache-control"] == "no-store"
    assert KEY not in rows.text and rows.json()[0]["has_local_key"]
    status = developer.get(API + "/devices/wifi/status?provider=developer")
    assert status.json()["status"] == {"switch": True} and KEY not in status.text
    assert status.json()["source"] == "tuya_developer_cloud_snapshot"
    functions = developer.get(API + "/devices/wifi/functions?provider=developer").json()
    assert functions["functions"][1]["type"] == "Integer"
    assert developer.get(API + "/devices/missing/status?provider=developer").status_code == 404
    assert developer.get(API + "/devices?provider=invalid").status_code == 422
    assert developer.get(API + "/devices").status_code == 409  # No implicit fallback to Developer.
    body = {"device_ids": ["wifi", "gateway", "child"], "dry_run": True}
    assert (
        developer.post(API + "/imports/local-inventory?provider=developer", json=body).status_code
        == 200
    )
    assert developer.get("/api/v1/devices").json() == []
    response = developer.post(
        API + "/imports/local-inventory?provider=developer", json={**body, "dry_run": False}
    )
    assert response.status_code == 200 and KEY not in response.text
    inventory = {d["device_id"]: d for d in developer.get("/api/v1/devices").json()}
    assert inventory["wifi"]["ip"] == "192.168.1.4"
    assert inventory["gateway"]["ip"] is None and inventory["gateway"]["is_gateway"]
    assert inventory["child"]["parent_id"] == inventory["gateway"]["id"]
    assert inventory["child"]["cid"] == "cid-4" and inventory["child"]["transport"] == "zigbee"
    assert inventory["wifi"]["version"] is None
    with Session(developer.app.state.engine) as session:
        assert session.scalar(select(Device).where(Device.device_id == "wifi")).local_key == KEY


@pytest.mark.parametrize(
    "command",
    [
        {"code": "switch", "value": 1},
        {"code": "bright", "value": 1001},
        {"code": "bright", "value": 15},
        {"code": "mode", "value": "invalid"},
        {"code": "unknown", "value": True},
    ],
)
def test_developer_commands_validate_before_sending(developer, command):
    bridge = connect(developer)
    response = developer.post(
        API + "/devices/wifi/commands?provider=developer", json={"commands": [command]}
    )
    assert response.status_code == 422
    assert not any(call[0] == "POST" for call in bridge.client.calls)


def test_developer_commands_checked_ack_no_retry_and_no_fallback(developer, monkeypatch):
    bridge = connect(developer)
    body = {"commands": [{"code": "switch", "value": False}]}
    response = developer.post(API + "/devices/wifi/commands?provider=developer", json=body)
    assert response.json()["acknowledged"] and not response.json()["state_confirmed"]
    original = bridge.client.request

    def no_ack(method, path, **kwargs):
        if method == "POST":
            bridge.client.calls.append((method, path, kwargs))
            return False
        return original(method, path, **kwargs)

    monkeypatch.setattr(bridge.client, "request", no_ack)
    assert (
        developer.post(API + "/devices/wifi/commands?provider=developer", json=body).status_code
        == 502
    )
    assert len([call for call in bridge.client.calls if call[0] == "POST"]) == 2
    assert developer.get(API + "/scenes?provider=developer").status_code == 501


def test_developer_files_reject_symlinks_malformed_and_shared_path(developer, tmp_path):
    bridge = developer.app.state.developer_cloud
    target = tmp_path / "target.json"
    target.write_text("unchanged")
    bridge.path.symlink_to(target)
    with pytest.raises(ValueError):
        DeveloperBridge(bridge.settings)
    assert developer.put(API + "/developer/credentials", json=CREDENTIALS).status_code == 503
    assert target.read_text() == "unchanged"
    bridge.path.unlink()
    bridge.path.write_text('{"access_secret":"private-invalid"}')
    with pytest.raises(ValueError, match="Invalid Developer credentials file"):
        DeveloperBridge(bridge.settings)
    with pytest.raises(ValueError, match="different files"):
        DeveloperBridge(
            Settings(
                database_path=str(tmp_path / "x.db"),
                cloud_session_path=str(target),
                developer_session_path=str(target),
            )
        )


def test_signature_matches_published_tuya_token_and_business_vectors():
    common = dict(
        access_id="1KAD46OrT9HafiKdsXeg",
        secret="4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC",
        timestamp="1588925778000",
        method="GET",
        nonce="5138cc3a9033d69856923fd07b491173",
        signed_headers="area_id:29a33e8796834b1efa6\ncall_id:8afdb70ab2ed11eb85290242ac130003\n",
    )
    assert (
        signature(**common, path="/v1.0/token?grant_type=1")
        == "9E48A3E93B302EEECC803C7241985D0A34EB944F40FB573C7B5C2A82158AF13E"
    )
    assert (
        signature(
            **common,
            path="/v2.0/apps/schema/users?page_no=1&page_size=50",
            token="3f4eda2bdec17232f67c0b188af3eec1",
        )
        == "AE4481C692AA80B25F3A7E12C3A5FD9BBF6251539DD78E565A1A72A508A88784"
    )


class FakeOpener:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return io.BytesIO(json.dumps(result).encode())


def ok(value):
    return {"success": True, "result": value}


def test_signed_http_timeout_body_expiry_and_single_command_attempt():
    opener = FakeOpener(
        [
            ok({"access_token": TOKEN, "expire_time": 3600}),
            ok([]),
            ok({"access_token": "next-token", "expire_time": 3600}),
            ok(True),
            TimeoutError("private-error"),
        ]
    )
    client = DeveloperClient(CREDENTIALS, timeout=4, opener=opener)
    client.request("GET", "/devices", query={"size": 50, "last_row_key": "a b&c"})
    request = opener.calls[1][0]
    assert request.full_url == "https://openapi.tuyaeu.com/devices?last_row_key=a+b%26c&size=50"
    assert request.get_header("Access_token") == TOKEN
    assert all(timeout == 4 for _, timeout in opener.calls)
    client.expires = 0
    body = {"commands": [{"code": "mode", "value": "цвет"}]}
    assert client.request("POST", "/commands", body=body) is True
    request = opener.calls[3][0]
    payload = request.data
    message = (
        CREDENTIALS["access_id"]
        + "next-token"
        + request.get_header("T")
        + request.get_header("Nonce")
        + "POST\n"
        + hashlib.sha256(payload).hexdigest()
        + "\n\n/commands"
    )
    assert (
        request.get_header("Sign")
        == hmac.new(CREDENTIALS["access_secret"].encode(), message.encode(), hashlib.sha256)
        .hexdigest()
        .upper()
    )
    assert json.loads(payload) == body
    with pytest.raises(TimeoutError):
        client.request("POST", "/commands", body=body)
    assert len(opener.calls) == 5


@pytest.mark.parametrize("region,host", REGIONS.items())
def test_developer_region_uses_fixed_https_host(region, host):
    opener = FakeOpener([ok({"access_token": TOKEN, "expire_time": 3600})])
    DeveloperClient({**CREDENTIALS, "region": region}, opener=opener).authenticate()
    url = urlsplit(opener.calls[0][0].full_url)
    assert url.scheme == "https" and url.netloc == host
    assert opener.calls[0][0].get_header("Access_token") is None


def test_device_pages_and_sample_device_user_route():
    opener = FakeOpener(
        [
            ok({"access_token": TOKEN, "expire_time": 3600}),
            ok({"devices": [{"id": "a"}], "has_more": True, "last_row_key": "cursor"}),
            ok({"devices": [{"id": "b"}], "has_more": False}),
        ]
    )
    client = DeveloperClient(CREDENTIALS, opener=opener)
    assert client.devices() == [{"id": "a"}, {"id": "b"}]
    assert "last_row_key=cursor" in opener.calls[2][0].full_url
    opener = FakeOpener(
        [ok({"access_token": TOKEN, "expire_time": 3600}), ok({"uid": "user"}), ok([])]
    )
    client = DeveloperClient({**CREDENTIALS, "sample_device_id": "sample"}, opener=opener)
    assert client.devices() == []
    assert opener.calls[1][0].full_url.endswith("/v1.0/devices/sample")
    assert opener.calls[2][0].full_url.endswith("/v1.0/users/user/devices")


def test_repeated_cursor_and_rejected_token_fail_without_retry():
    page = ok({"devices": [], "has_more": True, "last_row_key": "repeat"})
    opener = FakeOpener([ok({"access_token": TOKEN, "expire_time": 3600}), page, page])
    with pytest.raises(ValueError, match="pagination"):
        DeveloperClient(CREDENTIALS, opener=opener).devices()
    opener = FakeOpener([{"success": False, "msg": CREDENTIALS["access_secret"]}])
    with pytest.raises(ValueError) as error:
        DeveloperClient(CREDENTIALS, opener=opener).authenticate()
    assert CREDENTIALS["access_secret"] not in str(error.value) and len(opener.calls) == 1
