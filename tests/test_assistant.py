from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from smarthome import assistant_sessions
from smarthome.assistant_sessions import AssistantSessions, DashboardCredential
from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.tuya import TuyaController

from .conftest import KEY
from .test_household_accounts import API, OWNER, OWNER_KEY, create_member

EMBED = API + "/assistant/embed"
SESSION = API + "/assistant/session"
URL = "https://voice.test:8012/embed"


@pytest.fixture
def chat_client(tmp_path, factory):
    settings = Settings(
        database_path=str(tmp_path / "assistant.db"),
        api_token=OWNER_KEY,
        ai_chat_embed_url=URL,
        display_poll_interval=0,
    )
    app = create_app(settings, TuyaController(settings, factory))
    with TestClient(app) as client:
        yield client


def sign_in(client, headers):
    result = client.post(EMBED, headers=headers)
    assert result.status_code == 200, result.text
    assert result.headers["Cache-Control"] == "no-store"
    url, ticket = (result.json()[field] for field in ("url", "ticket"))
    assert url == URL
    assert len(ticket) == 43 and ticket != headers["X-API-Key"]
    credentials = {"ticket": ticket}
    result = client.post(SESSION, json=credentials)
    assert result.status_code == 200, result.text
    assert result.headers["Cache-Control"] == "no-store"
    assert client.post(SESSION, json=credentials).status_code == 401
    return {"X-API-Key": result.json()["key"]}


def test_owner_chat_is_passwordless_and_limited_to_chat_routes(chat_client):
    assert chat_client.post(EMBED).status_code == 401
    chat = sign_in(chat_client, OWNER)
    assert chat_client.get(API + "/accounts/me", headers=chat).json()["role"] == "owner"
    assert chat_client.get(API + "/devices", headers=chat).status_code == 200
    assert chat_client.get(API + "/accounts", headers=chat).status_code == 403
    assert chat_client.post(EMBED, headers=chat).status_code == 403
    settings = chat_client.app.state.settings
    chat_client.app.state.settings = replace(settings, api_token="another-key")
    assert chat_client.get(API + "/devices", headers=chat).status_code == 401


def test_member_chat_keeps_device_permissions_and_revocation(chat_client, factory):
    member, credentials = create_member(chat_client, "Alex")
    chat = sign_in(chat_client, credentials)
    assert chat_client.get(API + "/accounts/me", headers=chat).json()["id"] == member["id"]
    assert chat_client.get(API + "/accounts/me", headers=chat).json()["role"] == "member"

    def add_device(name, category, ip):
        created = chat_client.post(API + "/devices", headers=OWNER, json={
            "name": name, "device_id": name, "category": category, "ip": ip, "local_key": KEY,
            "version": "3.5", "capabilities": {"switch": {"dp": "1", "type": "boolean"}},
        })
        assert created.status_code == 201, created.text
        return created.json()["id"]

    outlet = add_device("Outlet", "cz", "192.168.1.40")
    camera = add_device("Camera", "sp", "192.168.1.41")
    assert [row["id"] for row in chat_client.get(API + "/devices", headers=chat).json()] == [outlet]
    payload = {"values": {"switch": True}}
    assert chat_client.post(f"{API}/devices/{camera}/commands/capabilities", headers=chat, json=payload).status_code == 403
    assert chat_client.get(f"{API}/activity/devices/{outlet}", headers=chat).status_code == 403
    assert chat_client.post(f"{API}/devices/{outlet}/commands/capabilities", headers=chat, json=payload).status_code == 200
    assert factory.commands == [("Outlet", "set_dps", {"1": True})]

    key_path = f"{API}/accounts/{member['id']}/keys/{member['key_id']}"
    assert chat_client.delete(key_path, headers=OWNER).status_code == 204
    assert chat_client.get(API + "/devices", headers=chat).status_code == 401


def test_ticket_is_atomic_and_credentials_expire(monkeypatch):
    clock = iter([10, 10])
    monkeypatch.setattr(assistant_sessions, "monotonic", lambda: next(clock, 10))
    sessions = AssistantSessions()
    source = DashboardCredential("key", "fingerprint")
    ticket = sessions.issue_ticket(source)
    with ThreadPoolExecutor(max_workers=4) as pool:
        keys = [key for key in pool.map(sessions.redeem, [ticket] * 4) if key]
    assert len(keys) == 1
    assert sessions.resolve(keys[0]) == source
    expired_ticket = sessions.issue_ticket(source)
    monkeypatch.setattr(assistant_sessions, "monotonic", lambda: 10 + assistant_sessions.SESSION_TTL)
    assert sessions.resolve(keys[0]) is None
    assert sessions.redeem(expired_ticket) is None


@pytest.mark.parametrize("url", [
    "http://voice.test/", "https://user:password@voice.test/",
    "https://voice.test/?key=123", "https://voice.test/#secret", "javascript:alert(1)",
])
def test_embed_rejects_insecure_or_credential_bearing_urls(url):
    with pytest.raises(ValueError):
        Settings(ai_chat_embed_url=url)
