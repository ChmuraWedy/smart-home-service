import copy
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from smarthome.cloud import CloudBridge
from smarthome.config import Settings
from smarthome.main import create_app
from tests.test_cloud import API, KEY, SECRET, FakeLogin, login


class QueryAPI:
    def __init__(self):
        self.calls = []
        self.bad_detail = False
        self.bad_home = False
        self.rows = [
            {
                "id": f"switch-{i}",
                "name": f"Switch {i}",
                "online": True,
                "status": [
                    {"code": "switch_1", "value": False},
                    {"code": "switch_2", "value": False},
                ],
                "local_key": KEY,
                "product_id": "switch-product",
                "sub": False,
            }
            for i in range(64)
        ]

    def get(self, path, params=None):
        self.calls.append(("GET", path, params))
        if path == "/homes":
            result = [SimpleNamespace(id="home")]
        elif path.endswith("/home/devices"):
            result = "invalid" if self.bad_home else copy.deepcopy(self.rows)
        elif path.endswith("/devices/detail"):
            result = copy.deepcopy([r for r in self.rows if r["id"] == params["devIds"]])
            if self.bad_detail:
                result[0]["id"] = "someone-else"
        elif path.endswith("/specifications"):
            specs = [{"code": f"switch_{i}", "type": "Boolean", "values": "{}"} for i in (1, 2)]
            result = {"functions": specs, "status": specs}
        elif path.endswith("/status"):
            result = {
                "productKey": "switch-product",
                "dpStatusRelationDTOS": [
                    {
                        "dpId": i,
                        "statusCode": f"switch_{i}",
                        "supportLocal": True,
                        "valueConvert": "default",
                        "statusFormat": json.dumps({f"switch_{i}": "$"}),
                        "valueDesc": "{}",
                        "valueType": "Boolean",
                        "enumMappingMap": {},
                    }
                    for i in (1, 2)
                ],
            }
        elif path.endswith("/custom-type"):
            result = False
        elif path.endswith("/dp-report-types"):
            result = []
        else:
            raise AssertionError("Unexpected cloud query")
        return {"success": True, "result": result}

    def post(self, path, params, body):
        self.calls.append(("POST", path, body))
        return {"success": True, "result": True}


class FakeMQ:
    def __init__(self, api, homes, devices):
        self.device = devices
        self.listeners = []
        self.client = SimpleNamespace(is_connected=lambda: True)
        self.started = self.stopped = False

    def add_message_listener(self, callback):
        self.listeners.append(callback)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def subscribe_device(self, id, device):
        self.device.append(device)

    def un_subscribe_device(self, id, support_local):
        self.device = [device for device in self.device if device.id != id]

    def emit_other(self, biz, id="switch-0"):
        for listener in self.listeners:
            listener({"protocol": 20, "data": {"bizCode": biz, "bizData": {"devId": id}}})

    def emit(self, id="switch-0", value=True, timestamp=1791400000000):
        for listener in self.listeners:
            listener(
                {
                    "protocol": 4,
                    "data": {"devId": id, "status": [{"dpId": 2, "value": value, "t": timestamp}]},
                }
            )


@pytest.fixture
def lazy_client(tmp_path):
    sdk = pytest.importorskip("tuya_sharing")
    from tuya_sharing.device import DeviceRepository

    def manager_factory(*args):
        manager = sdk.Manager(*args)
        api = QueryAPI()
        manager.customer_api = api
        manager.device_repository = DeviceRepository(api)
        manager.home_repository = SimpleNamespace(query_homes=lambda: api.get("/homes")["result"])
        manager.update_device_cache = lambda: pytest.fail("Full SDK account refresh is forbidden")
        return manager

    settings = Settings(
        database_path=str(tmp_path / "state.db"),
        cloud_session_path=str(tmp_path / "session.json"),
        cloud_enabled=True,
        api_token="test-api-key",
        display_poll_interval=0,
    )
    with TestClient(create_app(settings)) as client:
        client.headers["X-API-Key"] = settings.api_token
        client.app.state.cloud = CloudBridge(settings, FakeLogin, manager_factory, FakeMQ)
        login(client)
        yield client


def test_inventory_cost_is_per_home_and_status_refresh_is_one_device_query(lazy_client):
    rows = lazy_client.get(API + "/devices?refresh=true")
    assert len(rows.json()) == 64 and KEY not in rows.text
    bridge = lazy_client.app.state.cloud
    calls = bridge.manager.customer_api.calls
    assert len(calls) == 2  # Home list + home inventory, no 4×64 metadata calls.
    assert lazy_client.get(API + "/devices/switch-0/functions").status_code == 200
    assert len(calls) == 6  # Four metadata calls, only for switch-0, once.
    assert lazy_client.get(API + "/devices/switch-0/functions").status_code == 200
    assert len(calls) == 6
    assert lazy_client.get(API + "/devices/switch-0/status?refresh=true").status_code == 200
    assert calls[-1] == ("GET", "/v1.0/m/life/ha/devices/detail", {"devIds": "switch-0"})
    assert len(calls) == 7
    cached = lazy_client.get(API + "/devices/switch-0/status")
    assert cached.json()["status"]["switch_2"] is False and len(calls) == 7
    assert cached.json()["event_stream_connected"] is True
    assert KEY not in cached.text and SECRET not in cached.text


def test_reported_channel_two_overrides_stale_http_and_late_reports(lazy_client):
    path = API + "/devices/switch-0/status"
    assert lazy_client.get(path).json()["status"]["switch_2"] is False
    bridge = lazy_client.app.state.cloud
    mq = bridge.state.mq
    mq.emit()
    result = lazy_client.get(path + "?refresh=true").json()
    assert result["status"]["switch_2"] is True
    assert result["status"]["switch_1"] is False
    assert result["status_observations"]["switch_2"]["observed_at"]
    mq.emit(value=False, timestamp=1791390000000)
    assert lazy_client.get(path).json()["status"]["switch_2"] is True
    mq.emit(value=False, timestamp=1791410000000)
    assert lazy_client.get(path).json()["status"]["switch_2"] is False


def test_unknown_device_and_malformed_detail_never_replace_cached_state(lazy_client):
    path = API + "/devices/switch-0/status"
    lazy_client.get(path)
    api = lazy_client.app.state.cloud.manager.customer_api
    count = len(api.calls)
    assert lazy_client.get(API + "/devices/unknown/status?refresh=true").status_code == 404
    assert len(api.calls) == count
    api.bad_detail = True
    assert lazy_client.get(path + "?refresh=true").status_code == 502
    assert lazy_client.get(path).json()["status"]["switch_2"] is False
    api.bad_home = True
    assert lazy_client.get(API + "/devices?refresh=true").status_code == 502
    assert lazy_client.get(path).status_code == 200


def test_ack_does_not_create_a_report_and_logout_stops_local_mq(lazy_client):
    path = API + "/devices/switch-0"
    lazy_client.get(path + "/status")
    bridge = lazy_client.app.state.cloud
    mq = bridge.state.mq
    result = lazy_client.post(
        path + "/commands", json={"commands": [{"code": "switch_2", "value": True}]}
    )
    assert result.json()["acknowledged"] is True
    snapshot = lazy_client.get(path + "/status").json()
    assert snapshot["status"]["switch_2"] is False and snapshot["status_observations"] == {}
    bridge.logout()
    assert mq.stopped and bridge.state.reports == {}
    mq.emit()  # Late callbacks from an old account cannot restore its state.
    assert bridge.state.reports == {} and bridge.auth is None


def test_received_reports_survive_restart_are_account_scoped_and_clear_on_logout(lazy_client):
    path = API + "/devices/switch-0/status"
    lazy_client.get(path)
    original = lazy_client.app.state.cloud
    original.state.mq.emit()
    original.close()
    restored = CloudBridge(original.settings, FakeLogin, original.manager_factory, FakeMQ)
    lazy_client.app.state.cloud = restored
    snapshot = lazy_client.get(path + "?refresh=true").json()
    assert snapshot["status"]["switch_2"] is True
    assert snapshot["status_observations"]["switch_2"]["observed_at"]
    restored.close()
    other = CloudBridge(original.settings, FakeLogin, original.manager_factory, FakeMQ)
    other.auth["token_info"]["uid"] = "another-account"
    lazy_client.app.state.cloud = other
    assert lazy_client.get(path).json()["status"]["switch_2"] is False
    other.close()
    restored = CloudBridge(original.settings, FakeLogin, original.manager_factory, FakeMQ)
    lazy_client.app.state.cloud = restored
    lazy_client.get(path)
    restored.logout()
    # Reconnect the original account: explicit logout deleted its persisted reports.
    login(lazy_client)
    assert lazy_client.get(path).json()["status_observations"] == {}


def test_online_and_delete_events_use_the_registered_mq_without_revoking_account(lazy_client):
    path = API + "/devices/switch-0/status"
    lazy_client.get(path)
    bridge = lazy_client.app.state.cloud
    mq = bridge.state.mq
    assert bridge.manager.mq is mq
    mq.emit_other("offline")
    assert lazy_client.get(path + "?refresh=true").json()["online"] is False
    mq.emit_other("online")
    assert lazy_client.get(path).json()["online"] is True
    mq.emit()
    mq.emit_other("delete")
    assert lazy_client.get(path).status_code == 404
    assert "switch-0" not in bridge.state.reports
    assert not any(method == "POST" for method, _, _ in bridge.manager.customer_api.calls)


def test_inventory_card_controls_reuse_known_definitions_without_eager_queries(lazy_client):
    client = lazy_client
    bridge = client.app.state.cloud
    first = client.get(API + '/devices').json()[0]
    assert first['controls']['ready'] is False
    assert first['controls']['snapshot']['status'] == {'switch_1': False, 'switch_2': False}
    assert len(bridge.manager.customer_api.calls) == 2
    client.get(API + '/devices/switch-0/functions')
    client.put(API + '/devices/switch-0/channel-labels', json={'labels': {'switch_1': 'Światło'}})
    bridge.manager.customer_api.calls.clear()
    row = client.get(API + '/devices?refresh=true').json()[0]
    assert len(bridge.manager.customer_api.calls) == 2  # Home inventory only.
    assert row['controls']['ready'] is True
    definitions = row['controls']['definitions']
    assert definitions['device_id'] == row['id']
    assert definitions['functions'][0]['code'] == 'switch_1'
    assert definitions['functions'][0]['user_label'] == 'Światło'


def test_inventory_card_snapshot_does_not_expose_private_status_and_uses_actual_reports(lazy_client):
    client = lazy_client
    client.get(API + '/devices')
    bridge = client.app.state.cloud
    item = bridge.manager.device_map['switch-0']
    item.status.update(local_key=KEY, access_token='private-token', unknown_value=KEY)
    bridge.state.mq.emit(timestamp=1791400000000)
    row = client.get(API + '/devices').json()[0]
    snapshot = row['controls']['snapshot']
    assert KEY not in str(snapshot) and 'private-token' not in str(snapshot)
    assert snapshot['status']['switch_2'] is True
    assert snapshot['status_observations']['switch_2']['observed_at']
