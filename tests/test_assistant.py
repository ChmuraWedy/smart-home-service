import pytest
from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app

PATH = "/api/v1/assistant/embed"
SERVICE_KEY = "test-service-key"
URL = "https://voice.test:8011/"


@pytest.mark.parametrize("embed_url", ["", URL])
def test_embed_returns_only_the_configured_public_url(tmp_path, embed_url):
    with TestClient(create_app(Settings(
        database_path=str(tmp_path / "assistant.db"),
        api_token=SERVICE_KEY,
        ai_chat_embed_url=embed_url,
    ))) as client:
        assert client.get(PATH).status_code == 401
        result = client.get(PATH, headers={"X-API-Key": SERVICE_KEY})
        assert result.status_code == 200
        assert result.headers["Cache-Control"] == "no-store"
        assert result.json() == {"url": embed_url or None}


@pytest.mark.parametrize("url", [
    "http://voice.test/", "https://user:password@voice.test/",
    "https://voice.test/?key=123", "https://voice.test/#secret", "javascript:alert(1)",
])
def test_embed_rejects_insecure_or_credential_bearing_urls(url):
    with pytest.raises(ValueError):
        Settings(ai_chat_embed_url=url)
