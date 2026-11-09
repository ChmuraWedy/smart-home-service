from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from smarthome import assistant_sessions
from smarthome.assistant_sessions import AssistantSessions, fingerprint
from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.tuya import TuyaController

from .conftest import KEY

API = "/api/v1"
EMBED = API + "/assistant/embed"
SESSION = API + "/assistant/session"
SERVICE_KEY = "test-service-key"
OWNER = {"X-API-Key": SERVICE_KEY}
URL = "https://voice.test:8013/embed"


def test_chat_ticket_has_scoped_access_and_only_works_once(tmp_path, factory):
    settings = Settings(
        database_path=str(tmp_path / "assistant.db"), api_token=SERVICE_KEY,
        ai_chat_embed_url=URL, display_poll_interval=0,
    )
    app = create_app(settings, TuyaController(settings, factory))
    with TestClient(app) as client:
        assert client.post(EMBED).status_code == 401
        embed = client.post(EMBED, headers=OWNER)
        assert embed.headers["Cache-Control"] == "no-store"
        assert embed.json()["url"] == URL
        ticket = embed.json()["ticket"]
        assert len(ticket) == 43 and ticket != SERVICE_KEY
        session = client.post(SESSION, json={"ticket": ticket})
        assert session.status_code == 200
        assert session.headers["Cache-Control"] == "no-store"
        assert client.post(SESSION, json={"ticket": ticket}).status_code == 401
        chat = {"X-API-Key": session.json()["key"]}

        device = client.post(API + "/devices", headers=OWNER, json={
            "name": "Outlet", "device_id": "outlet", "ip": "192.168.1.40",
            "local_key": KEY, "version": "3.5",
            "capabilities": {"switch": {"dp": "1", "type": "boolean"}},
        })
        assert device.status_code == 201, device.text
        path = f"{API}/devices/{device.json()['id']}"
        assert client.get(API + "/devices", headers=chat).status_code == 200
        assert client.patch(path, headers=chat, json={"name": "Edited"}).status_code == 403
        assert client.post(EMBED, headers=chat).status_code == 403
        assert client.post(path + "/commands/capabilities", headers=chat, json={
            "values": {"switch": True},
        }).status_code == 200
        assert factory.commands == [("outlet", "set_dps", {"1": True})]
        app.state.settings = replace(settings, api_token="another-key")
        assert client.get(API + "/devices", headers=chat).status_code == 401


def test_disabled_chat_and_open_mode_do_not_issue_credentials(tmp_path):
    settings = Settings(database_path=str(tmp_path / "assistant.db"), display_poll_interval=0)
    with TestClient(create_app(settings)) as client:
        assert client.post(EMBED).json() == {"url": None, "ticket": None}
        client.app.state.settings = replace(settings, ai_chat_embed_url=URL)
        assert client.post(EMBED).status_code == 403


def test_ticket_redemption_is_atomic_and_expires(monkeypatch):
    monkeypatch.setattr(assistant_sessions, "monotonic", lambda: 10)
    store = AssistantSessions()
    credential = fingerprint(SERVICE_KEY)
    ticket = store.issue_ticket(credential)
    with ThreadPoolExecutor(max_workers=4) as pool:
        keys = [key for key in pool.map(store.redeem, [ticket] * 4) if key]
    assert len(keys) == 1
    assert store.resolve(keys[0]) == credential
    unused_ticket = store.issue_ticket(credential)
    monkeypatch.setattr(assistant_sessions, "monotonic", lambda: 10 + assistant_sessions.SESSION_TTL)
    assert store.resolve(keys[0]) is None
    assert store.redeem(unused_ticket) is None


@pytest.mark.parametrize("url", [
    "http://voice.test/", "https://user:password@voice.test/",
    "https://voice.test/?key=123", "https://voice.test/#secret", "javascript:alert(1)",
])
def test_embed_rejects_insecure_or_credential_bearing_urls(url):
    with pytest.raises(ValueError):
        Settings(ai_chat_embed_url=url)
