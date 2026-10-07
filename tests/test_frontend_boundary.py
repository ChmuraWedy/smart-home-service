import pytest
from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app

ORIGIN = "http://127.0.0.1:5173"


def client(tmp_path, **kwargs):
    return TestClient(
        create_app(Settings(database_path=str(tmp_path / "ui.db"), api_token="token", **kwargs))
    )


def test_configured_origin_preflight_and_authentication(tmp_path):
    with client(tmp_path, cors_origins=(ORIGIN,)) as app:
        result = app.options(
            "/api/v1/cloud/status",
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": "content-type,x-api-key",
            },
        )
        assert result.status_code == 200
        assert result.headers["Access-Control-Allow-Origin"] == ORIGIN
        assert "Access-Control-Allow-Credentials" not in result.headers
        denied = app.get("/api/v1/cloud/status", headers={"Origin": ORIGIN})
        assert denied.status_code == 401
        assert denied.headers["Access-Control-Allow-Origin"] == ORIGIN
        allowed = app.get(
            "/api/v1/cloud/status", headers={"Origin": ORIGIN, "X-API-Key": "token"}
        )
        assert allowed.status_code == 200
        assert allowed.headers["Access-Control-Allow-Origin"] == ORIGIN


def test_other_origins_and_headers_are_not_allowed(tmp_path):
    with client(tmp_path, cors_origins=(ORIGIN,)) as app:
        result = app.options(
            "/api/v1/cloud/status",
            headers={
                "Origin": "https://example.org",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "x-api-key",
            },
        )
        assert result.status_code == 400
        assert "Access-Control-Allow-Origin" not in result.headers
        result = app.options(
            "/api/v1/cloud/status",
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        assert result.status_code == 400


def test_cors_disabled_by_default_and_no_embedded_ui(tmp_path):
    with client(tmp_path, cors_origins=(), frontend_url="") as app:
        result = app.get("/health", headers={"Origin": ORIGIN})
        assert result.status_code == 200
        assert "Access-Control-Allow-Origin" not in result.headers
        result = app.get("/cloud", follow_redirects=False)
        assert result.status_code == 404
        assert result.headers["Content-Type"].startswith("application/json")


def test_legacy_cloud_url_redirects_without_credentials(tmp_path):
    with client(tmp_path, frontend_url=ORIGIN) as app:
        result = app.get("/cloud", follow_redirects=False)
        assert result.status_code == 307
        assert result.headers["Location"] == ORIGIN
        assert result.headers["Cache-Control"] == "no-store"
        assert "token" not in result.text


@pytest.mark.parametrize(
    "origin",
    ["*", "https://example.org/", "https://example.org/path", "http://u:p@localhost", "null"],
)
def test_invalid_origins_rejected(origin):
    with pytest.raises(ValueError):
        Settings(cors_origins=(origin,))


@pytest.mark.parametrize("url", ["javascript:alert(1)", "//example.org", "https://u:p@example.org"])
def test_invalid_frontend_redirect_rejected(url):
    with pytest.raises(ValueError):
        Settings(frontend_url=url)


def test_settings_from_environment(monkeypatch):
    monkeypatch.setenv("SMART_HOME_CORS_ORIGINS", f" {ORIGIN}, https://home.example.org , ")
    monkeypatch.setenv("SMART_HOME_FRONTEND_URL", "https://home.example.org/cloud")
    settings = Settings()
    assert settings.cors_origins == (ORIGIN, "https://home.example.org")
    assert settings.frontend_url == "https://home.example.org/cloud"
