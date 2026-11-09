from dataclasses import replace

from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.setup_api import managed_key_path

CODE = "a-test-setup-code-at-least-32-chars"
SETUP = "/api/v1/setup"
DEVICES = "/api/v1/devices"


def test_initialize_once_and_preserve_key_across_restart(tmp_path):
    settings = Settings(database_path=str(tmp_path / "test.db"), setup_code=CODE)
    with TestClient(create_app(settings), base_url="https://dashboard.test") as client:
        availability = client.get(SETUP)
        assert availability.json() == {"can_initialize": True}
        assert availability.headers["cache-control"] == "no-store"
        assert client.get(DEVICES).status_code == 503
        assert client.post(SETUP, json={"setup_code": "wrong"}).status_code == 403
        assert not managed_key_path(settings).exists()

        created = client.post(SETUP, json={"setup_code": CODE})
        assert created.status_code == 201
        assert created.headers["cache-control"] == "no-store"
        key = created.json()["access_key"]
        headers = {"X-API-Key": key}
        assert len(key) == 43
        assert managed_key_path(settings).stat().st_mode & 0o777 == 0o600
        assert client.get(DEVICES).status_code == 401
        assert client.get(DEVICES, headers=headers).status_code == 200
        assert client.get(SETUP).json() == {"can_initialize": False}
        assert client.post(SETUP, json={"setup_code": CODE}).status_code == 409

    with TestClient(create_app(replace(settings, setup_code=""))) as restarted:
        assert restarted.get(DEVICES, headers=headers).status_code == 200


def test_setup_requires_opt_in_and_secure_connection(tmp_path):
    settings = Settings(database_path=str(tmp_path / "test.db"), setup_code=CODE)
    with TestClient(create_app(settings), base_url="http://localhost") as remote_http:
        assert remote_http.get(SETUP).json() == {"can_initialize": False}
        assert remote_http.post(SETUP, json={"setup_code": CODE}).status_code == 403

    with TestClient(create_app(settings), base_url="http://localhost", client=("127.0.0.1", 43210)) as local_http:
        assert local_http.get(SETUP).json() == {"can_initialize": True}

    with TestClient(create_app(replace(settings, setup_code="")), base_url="https://dashboard.test") as open_dev:
        assert open_dev.get(SETUP).json() == {"can_initialize": False}
        assert open_dev.post(SETUP, json={"setup_code": CODE}).status_code == 409
        assert open_dev.get(DEVICES).status_code == 200


def test_existing_explicit_key_takes_precedence(tmp_path):
    settings = Settings(database_path=str(tmp_path / "test.db"), setup_code=CODE, api_token="existing")
    with TestClient(create_app(settings), base_url="https://dashboard.test") as client:
        assert client.get(SETUP).json() == {"can_initialize": False}
        assert client.post(SETUP, json={"setup_code": CODE}).status_code == 409
        assert client.get(DEVICES, headers={"X-API-Key": "existing"}).status_code == 200
        assert not managed_key_path(settings).exists()
