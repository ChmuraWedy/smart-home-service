import threading
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace

import pytest

from smarthome.commissioning import MAX_SESSIONS, TTL

API = "/api/v1/commissioning"
KEY = "0123456789abcdef"
DRAFT = {
    "name": "New lamp",
    "device_id": "new-lamp",
    "ip": "192.168.1.40",
    "version": "3.5",
    "local_key": KEY,
}


class Bridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.auth = {"token_info": {"uid": "account-1"}}
        self.status_calls = []
        self.device = SimpleNamespace(
            id="new-lamp",
            local_key=KEY,
            category="dj",
            product_id="prod",
            online=True,
            function={
                "switch_led": SimpleNamespace(
                    code="switch_led", type="Boolean", values="{}", dp_id=1
                ),
                "bright_value": SimpleNamespace(
                    code="bright_value",
                    type="Integer",
                    values='{"min":10,"max":1000,"step":1,"scale":0}',
                    dp_id=2,
                ),
                "colour_data": SimpleNamespace(
                    code="colour_data", type="String", values="{}", dp_id=4
                ),
            },
            status_range={},
            local_strategy={},
            status={"switch_led": False},
            status_observations={"switch_led": {"received_at": "2026-10-08T10:00:00+00:00"}},
        )

    def require_enabled(self):
        pass

    def writable_device(self, id):
        assert id == self.device.id
        return self.device

    def device_status(self, id, refresh):
        assert id == self.device.id
        self.status_calls.append(refresh)
        return self.device


@pytest.fixture
def observer(client):
    now = [0.0]
    client.app.state.observations.clock = lambda: now[0]
    bridge = Bridge()
    client.app.state.cloud = bridge
    yield now, bridge
    # Lifespan closes the bridge after this fixture. Restore its close interface.
    bridge.close = lambda: None


def begin(client, **kwargs):
    result = client.post(API, json={"draft": DRAFT, **kwargs})
    assert result.status_code == 201, result.text
    assert KEY not in result.text
    return result.json()["session_id"]


def sample(client, token, **kwargs):
    result = client.post(f"{API}/{token}/samples", json=kwargs)
    assert result.status_code == 200, result.text
    assert KEY not in result.text
    return result.json()


def save(client, token, **kwargs):
    return client.post(
        f"{API}/{token}/register", json={"name": "Saved lamp", "reviewed": True, **kwargs}
    )


def test_read_only_baseline_changes_and_registration(client, factory, observer):
    now, _ = observer
    token = begin(client)
    assert client.get("/api/v1/devices").json() == []
    assert factory.commands == []
    assert save(client, token).status_code == 409
    first = sample(client, token)
    assert first["changes"] == []
    assert first["readings"][0]["value"] is True
    assert first["readings"][0]["code"] is None
    assert not first["readings"][0]["can_write"]
    assert client.get("/api/v1/devices").json() == []
    assert client.post(f"{API}/{token}/samples", json={}).status_code == 429
    assert len(factory.commands) == 1
    factory.result = {"dps": {"1": False}}
    now[0] += 3
    second = sample(client, token, action="power")
    assert second["sample_count"] == 2
    change = second["changes"][0]
    assert (change["previous"], change["value"], change["action"]) == (True, False, "power")
    assert save(client, token, reviewed=False).status_code == 422
    assert save(client, token, writable=["dp_1"]).status_code == 422
    result = save(client, token, aliases=["lamp", "main_light"])
    assert result.status_code == 201, result.text
    assert KEY not in result.text
    device = result.json()
    assert device["has_local_key"] is True
    assert device["last_dps"] == {"1": False}
    assert not device["capabilities"]["dp_1"]["writable"]
    assert "Saved lamp" in device["aliases"]
    assert save(client, token).status_code == 404
    assert factory.commands == [("new-lamp", "status", None)] * 2
    assert all(item.closed for item in factory.instances)
    assert begin_duplicate(client) == 409


def begin_duplicate(client):
    return client.post(API, json={"draft": DRAFT}).status_code


def test_cloud_labels_server_key_confirmed_control_and_unknown_read_only(client, factory, observer):
    factory.result = {"dps": {"1": True, "2": 650, "4": "ff0000", "99": 123}}
    draft = {k: v for k, v in DRAFT.items() if k != "local_key"}
    result = client.post(API, json={"draft": draft, "provider": "sharing"})
    assert result.status_code == 201, result.text
    token = result.json()["session_id"]
    values = sample(client, token)["readings"]
    assert [(row["code"], row["can_write"]) for row in values] == [
        ("switch_led", True),
        ("bright_value", True),
        ("colour_data", False),
        (None, False),
    ]
    result = save(client, token, writable=["dp_1", "dp_2"])
    assert result.status_code == 201, result.text
    caps = result.json()["capabilities"]
    assert caps["switch_led"]["writable"]
    assert caps["bright_value"]["maximum"] == 1000
    assert not caps["colour_data"]["writable"]
    assert not caps["dp_99"]["writable"]
    device_id = result.json()["id"]
    assert (
        client.post(
            f"/api/v1/devices/{device_id}/commands/capabilities",
            json={"values": {"bright_value": 650}},
        ).status_code
        == 200
    )
    assert factory.commands[-1] == ("new-lamp", "set_dps", {"2": 650})


def test_zigbee_uses_actual_parent_and_cid_without_registering_child(
    client, factory, gateway, observer
):
    draft = {
        "name": "Sensor",
        "device_id": "sensor-2",
        "transport": "zigbee",
        "parent_id": gateway["id"],
        "cid": "node-2",
        "local_key": "fedcba9876543210",
    }
    result = client.post(API, json={"draft": draft})
    assert result.status_code == 201, result.text
    token = result.json()["session_id"]
    factory.result = {"data": {"cid": "node-2", "dps": {"1": True}}}
    sample(client, token)
    root, child = factory.instances[-2:]
    assert root.id == "gateway-1" and root.local_key == KEY
    assert child.kwargs["parent"] is root and child.kwargs["cid"] == "node-2"
    assert child.local_key == ""
    assert len(client.get("/api/v1/devices").json()) == 1
    assert client.delete(f"{API}/{token}").status_code == 204
    assert len(client.get("/api/v1/devices").json()) == 1
    assert client.post(f"{API}/{token}/samples", json={}).status_code == 404


def test_wrong_child_sleeping_and_failed_read_do_not_create_sample(
    client, factory, gateway, observer
):
    draft = {
        "name": "Sensor",
        "device_id": "sensor-2",
        "transport": "zigbee",
        "parent_id": gateway["id"],
        "cid": "node-2",
    }
    result = client.post(API, json={"draft": draft})
    token = result.json()["session_id"]
    now, _ = observer
    for raw in ({"cid": "other-node", "dps": {"1": True}}, {"dps": {}}, RuntimeError(KEY)):
        factory.result = raw
        result = client.post(f"{API}/{token}/samples", json={})
        assert result.status_code == 502 and KEY not in result.text
        now[0] += 3
    assert save(client, token).status_code == 409
    assert client.app.state.observations.entries[token].sample_count == 0


def test_cloud_reports_diffs_keep_original_timestamp_and_never_seed_local_cache(client, observer):
    now, bridge = observer
    token = begin(client, mode="cloud", provider="sharing")
    first = sample(client, token)
    assert first["readings"][0]["received_at"] == "2026-10-08T10:00:00+00:00"
    now[0] += 5
    assert sample(client, token)["changes"] == []
    bridge.device.status["switch_led"] = True
    now[0] += 5
    result = sample(client, token, action="power")
    assert len(result["changes"]) == 1
    assert not result["readings"][0]["can_write"]
    assert bridge.status_calls == [True, False, True]
    saved = save(client, token)
    assert saved.status_code == 201
    assert saved.json()["last_dps"] is None
    assert saved.json()["capabilities"] == {}


def test_account_change_invalidates_samples_and_final_registration(client, observer):
    _, bridge = observer
    token = begin(client, provider="sharing")
    sample(client, token)
    bridge.auth["token_info"]["uid"] = "account-2"
    assert client.post(f"{API}/{token}/samples", json={}).status_code == 409
    assert save(client, token).status_code == 409
    assert client.get("/api/v1/devices").json() == []


def test_ambiguous_dp_is_not_labelled_or_writable(client, factory, observer):
    _, bridge = observer
    bridge.device.local_strategy = {2: {"status_code": "switch_led"}}
    token = begin(client, provider="sharing")
    row = sample(client, token)["readings"][0]
    assert row["code"] is None and not row["can_write"]
    assert save(client, token, writable=["dp_1"]).status_code == 422


def test_secret_fields_and_nested_values_are_redacted(client, factory, observer):
    factory.result = {
        "dps": {
            "1": KEY,
            "2": {"local_key": KEY, "nested": {"password": "private", "value": "prefix-" + KEY}},
            "3": "safe",
            "local_key": KEY,
        }
    }
    token = begin(client)
    data = sample(client, token)
    assert len(data["readings"]) == 3
    assert data["readings"][0]["value"] == "[hidden]"
    assert data["readings"][1]["value"] == {"nested": {"value": "[hidden]"}}
    result = save(client, token)
    assert result.status_code == 201 and KEY not in result.text and "private" not in result.text
    assert result.json()["last_dps"] == {"3": "safe"}


def test_cancel_expiry_capacity_auth_and_validation(client, observer):
    now, _ = observer
    token = begin(client)
    assert client.delete(f"{API}/{token}").status_code == 204
    assert client.get("/api/v1/devices").json() == []
    tokens = [begin(client) for _ in range(MAX_SESSIONS)]
    assert client.post(API, json={"draft": DRAFT}).status_code == 429
    now[0] += TTL
    assert client.post(f"{API}/{tokens[0]}/samples", json={}).status_code == 404
    begin(client)
    invalid = client.post(API, json={"draft": {**DRAFT, "local_key": KEY + "wrong"}})
    assert invalid.status_code == 422 and KEY not in invalid.text
    client.app.state.settings = replace(client.app.state.settings, api_token="required")
    assert client.post(API, json={"draft": DRAFT}).status_code == 401


def test_sparse_reports_preserve_per_dp_time_and_latest_last_seen(client, factory, observer):
    now, bridge = observer
    bridge.device.status_range = {
        "temp_current": SimpleNamespace(
            code="temp_current",
            type="Integer",
            values='{"min":-400,"max":1250,"scale":1,"unit":"°C"}',
            dp_id=7,
        )
    }
    factory.result = {"dps": {"1": True, "7": 215}}
    token = begin(client, provider="sharing")
    first = sample(client, token)
    factory.result = {"dps": {"1": False}}
    now[0] += 3
    second = sample(client, token)
    assert second["readings"][1]["received_at"] == first["readings"][1]["received_at"]
    assert len(second["changes"]) == 1
    result = save(client, token)
    assert result.status_code == 201, result.text
    saved = result.json()
    assert datetime.fromisoformat(saved["last_seen_at"].replace("Z", "+00:00")) == max(
        datetime.fromisoformat(row["received_at"]) for row in second["readings"]
    )
    state = client.get(f"/api/v1/devices/{saved['id']}/state").json()
    assert state["values"]["temp_current"]["value"] == 21.5
    assert not saved["capabilities"]["temp_current"]["writable"]


def test_session_bounds_and_serialized_samples(client, factory, observer):
    now, _ = observer
    token = begin(client)
    entry = client.app.state.observations.entries[token]
    entry.lock.acquire()
    try:
        assert client.post(f"{API}/{token}/samples", json={}).status_code == 409
        assert factory.commands == []
    finally:
        entry.lock.release()
    factory.result = {"dps": {str(dp): 0 for dp in range(1, 75)}}
    assert len(sample(client, token)["readings"]) == 64
    for index in range(102):
        factory.result = {"dps": {"1": index % 2 == 0}}
        now[0] += 3
        result = sample(client, token)
    assert len(result["changes"]) == 100
    assert len(result["readings"]) == 64
    assert len(client.get("/api/v1/devices").json()) == 0


def test_invalid_cloud_key_is_sanitized(client, observer):
    _, bridge = observer
    bridge.device.local_key = "private-invalid-key"
    draft = {k: v for k, v in DRAFT.items() if k != "local_key"}
    result = client.post(API, json={"draft": draft, "provider": "sharing"})
    assert result.status_code == 502
    assert "private-invalid-key" not in result.text
    assert client.app.state.observations.entries == {}
