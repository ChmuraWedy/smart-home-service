import pytest
from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.tuya import TuyaController

KEY = "0123456789abcdef"


class FakeTuya:
    def __init__(self, factory, device_id, address=None, local_key="", **kwargs):
        self.factory, self.id = factory, device_id
        self.address, self.local_key = address, local_key
        self.kwargs = kwargs
        self.closed = False
        self.retry = None

    def set_retry(self, value):
        self.retry = value

    def status(self):
        self.factory.commands.append((self.id, "status", None))
        result = self.factory.result
        if isinstance(result, Exception):
            raise result
        return result

    def set_multiple_values(self, dps):
        self.factory.commands.append((self.id, "set_dps", dps))
        return self.status_result()

    def status_result(self):
        result = self.factory.result
        if isinstance(result, Exception):
            raise result
        return result

    def close(self):
        self.closed = True


class Factory:
    def __init__(self):
        self.instances = []
        self.commands = []
        self.result = {"dps": {"1": True}}

    def __call__(self, *args, **kwargs):
        item = FakeTuya(self, *args, **kwargs)
        self.instances.append(item)
        return item


@pytest.fixture
def factory():
    return Factory()


@pytest.fixture
def client(tmp_path, factory):
    settings = Settings(
        database_path=str(tmp_path / "test.db"),
        tuya_timeout=1,
        lock_timeout=0.1,
        display_poll_interval=0,
    )
    app = create_app(settings, TuyaController(settings, factory))
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def direct(client):
    result = client.post(
        "/api/v1/devices",
        json={
            "name": "Outlet",
            "device_id": "wifi-1",
            "ip": "192.168.1.40",
            "local_key": KEY,
            "version": "3.5",
            "capabilities": {"switch": {"dp": "1", "type": "boolean"}},
        },
    )
    assert result.status_code == 201, result.text
    return result.json()


@pytest.fixture
def gateway(client):
    result = client.post(
        "/api/v1/devices",
        json={
            "name": "Gateway",
            "device_id": "gateway-1",
            "is_gateway": True,
            "ip": "192.168.1.20",
            "local_key": KEY,
            "version": "3.5",
        },
    )
    assert result.status_code == 201, result.text
    return result.json()


@pytest.fixture
def child(client, gateway):
    result = client.post(
        "/api/v1/devices",
        json={
            "name": "Zigbee relay",
            "device_id": "child-1",
            "transport": "zigbee",
            "parent_id": gateway["id"],
            "node_id": "001122334455",
            "local_key": "fedcba9876543210",
            "capabilities": {"switch": {"dp": "1", "type": "boolean"}},
        },
    )
    assert result.status_code == 201, result.text
    return result.json()
