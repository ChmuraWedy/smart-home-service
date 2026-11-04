"""Gateway key discovery never creates inventory or guesses child relationships."""

import hashlib
import hmac
import threading
from types import SimpleNamespace

import pytest
import tinytuya
from sqlalchemy.orm import Session
from tinytuya.core import AESCipher, TuyaMessage

from smarthome.commissioning import TTL
from smarthome.gateway_keys import MAX_KEYS, candidates, discover
from smarthome.models import Device
from smarthome.schemas import DeviceCreate

API = "/api/v1/commissioning"
KEY = "0123456789abcdef"
OTHER = "fedcba9876543210"
DRAFT = {
    "name": "Actual gateway",
    "device_id": "gateway-real",
    "is_gateway": True,
    "ip": "192.168.1.30",
    "version": "3.5",
}


def cloud_device(id, key=None, **kwargs):
    return SimpleNamespace(id=id, local_key=key, category="wsdcg", sub=True, **kwargs)


class Bridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.auth = {"token_info": {"uid": "account-1"}}
        self.gateway = cloud_device("gateway-real")
        self.gateway.category = "wg2"
        self.children = [cloud_device("sensor-real", KEY)]

    def require_enabled(self):
        pass

    def writable_device(self, id):
        assert id == self.gateway.id
        return self.gateway

    def devices(self):
        return [self.gateway, *self.children]

    def close(self):
        pass


@pytest.fixture
def bridge(client):
    item = Bridge()
    client.app.state.cloud = item
    return item


def begin(client, draft=None, **kwargs):
    return client.post(
        API,
        json={
            "draft": DRAFT if draft is None else draft,
            "mode": "local",
            "provider": "sharing",
            "discover_gateway_key": True,
            **kwargs,
        },
    )


def save(client, token, **kwargs):
    return client.post(
        f"{API}/{token}/register",
        json={
            "name": "Actual gateway",
            "reviewed": True,
            **kwargs,
        },
    )


def install_proof(factory):
    original = factory.__call__

    def build(*args, **kwargs):
        target = original(*args, **kwargs)
        status = target.status
        target.real_local_key = target.local_key.encode()
        target.local_key = target.real_local_key

        def read():
            result = status()
            if args[2] == KEY and kwargs["version"] == 3.4:
                target.local_key = b"verified-session"
            return result

        target.status = read
        return target

    return build


def test_candidate_pool_prefers_explicit_metadata_without_inventing_parents():
    gateway = cloud_device("gw", OTHER)
    gateway.category = "wg2"
    another_gateway = cloud_device("other-gw", "aaaaaaaaaaaaaaaa")
    another_gateway.category = "wg2"  # Sharing can flag gateways sub=True.
    children = [
        cloud_device("unlinked", KEY),
        cloud_device("linked", KEY, gateway_id="gw"),
        cloud_device("foreign", "bbbbbbbbbbbbbbbb", gateway_id="other-gw"),
        cloud_device("invalid", "private-invalid-key"),
        another_gateway,
    ]
    assert candidates([*children, gateway], "gw") == [("gw", OTHER), ("linked", KEY)]
    assert not hasattr(children[0], "gateway_id")


def test_verified_gateway_without_dps_requires_explicit_save_and_keeps_key_server_side(
    client,
    bridge,
    factory,
):
    factory.result = {"Error": "Invalid JSON", "Err": "900", "Payload": "data unvalid " + KEY}
    client.app.state.controller.device_factory = install_proof(factory)
    response = begin(client)
    assert response.status_code == 201, response.text
    assert KEY not in response.text and OTHER not in response.text
    result = response.json()
    assert result["gateway_verification"] == {
        "ip": DRAFT["ip"],
        "version": "3.4",
        "key_source": "child",
    }
    assert result["readings"] == [] and result["sample_count"] == 0
    assert client.get("/api/v1/devices").json() == []
    assert factory.commands == [("gateway-real", "status", None)] * 2
    assert all(item.disabledetect and item.closed for item in factory.instances)
    assert all(item.kwargs["connection_timeout"] <= 1 for item in factory.instances)
    token = result["session_id"]
    assert client.post(f"{API}/{token}/samples", json={}).status_code == 409
    assert save(client, token, reviewed=False).status_code == 422
    assert save(client, token, writable=["dp_1"]).status_code == 422
    saved = save(client, token)
    assert saved.status_code == 201, saved.text
    assert KEY not in saved.text
    device = saved.json()
    assert device["is_gateway"] and device["has_local_key"]
    assert device["version"] == "3.4" and device["ip"] == DRAFT["ip"]
    assert device["capabilities"] == {} and device["last_dps"] is None
    assert device["parent_id"] is None
    with Session(client.app.state.engine) as session:
        assert session.get(Device, device["id"]).local_key == KEY
    assert len(client.get("/api/v1/devices").json()) == 1
    assert save(client, token).status_code == 404


@pytest.mark.parametrize("result", [None, {"Err": "914", "Payload": KEY}, RuntimeError(KEY)])
def test_failures_are_sanitized_and_do_not_keep_sessions(client, bridge, factory, result):
    factory.result = result
    response = begin(client)
    assert response.status_code == 409
    assert KEY not in response.text
    assert not client.app.state.observations.entries
    assert client.get("/api/v1/devices").json() == []
    assert len(factory.instances) == 3 and all(item.closed for item in factory.instances)


@pytest.mark.parametrize(
    "updates",
    [
        {"ip": "127.0.0.1"},
        {"ip": "8.8.8.8"},
        {"ip": "169.254.1.1"},
        {"ip": None},
        {"version": "3.1"},
        {"version": "3.2"},
        {"is_gateway": False},
        {"enabled": False},
        {"local_key": KEY},
    ],
)
def test_invalid_targets_never_contact_hardware(client, bridge, factory, updates):
    response = begin(client, {**DRAFT, **updates})
    assert response.status_code == 422 and KEY not in response.text
    assert factory.commands == []


def test_account_mode_category_pool_capacity_and_busy_guards(client, bridge, factory):
    assert begin(client, mode="cloud").status_code == 422
    assert begin(client, provider=None).status_code == 422
    bridge.gateway.category = "dj"
    assert begin(client).status_code == 422
    bridge.gateway.category = "wg2"
    bridge.children = []
    assert begin(client).status_code == 409
    bridge.children = [cloud_device(str(i), f"{i:016d}") for i in range(MAX_KEYS + 1)]
    assert begin(client).status_code == 409
    bridge.children = [cloud_device("sensor-real", KEY)]
    lock = client.app.state.observations.gateway_probe_lock
    with lock:
        assert begin(client).status_code == 409
    assert not client.app.state.observations.entries
    assert factory.commands == []


@pytest.mark.parametrize("change", ["key", "account", "parent", "gateway"])
def test_cloud_changes_invalidate_verification_before_save(client, bridge, monkeypatch, change):
    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", lambda device: True)
    response = begin(client)
    assert response.status_code == 201, response.text
    if change == "key":
        bridge.children[0].local_key = OTHER
    elif change == "account":
        bridge.auth["token_info"]["uid"] = "different-account"
    elif change == "parent":
        bridge.children[0].gateway_id = "another-gateway"
    else:
        bridge.gateway.category = "dj"
    assert save(client, response.json()["session_id"]).status_code == 409
    assert client.get("/api/v1/devices").json() == []


def test_account_change_during_network_probe_discards_result(client, bridge, monkeypatch):
    def probe(device):
        bridge.auth["token_info"]["uid"] = "different-account"
        return True

    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", probe)
    assert begin(client).status_code == 409
    assert not client.app.state.observations.entries


def test_cancel_expiry_and_gateway_own_key(client, bridge, monkeypatch):
    now = [0]
    client.app.state.observations.clock = lambda: now[0]
    bridge.gateway.local_key = KEY
    bridge.children = []
    monkeypatch.setattr(client.app.state.controller, "verify_gateway_key", lambda device: True)
    response = begin(client)
    assert response.json()["gateway_verification"]["key_source"] == "device"
    assert client.delete(f"{API}/{response.json()['session_id']}").status_code == 204
    response = begin(client)
    now[0] += TTL
    assert save(client, response.json()["session_id"]).status_code == 404
    assert client.get("/api/v1/devices").json() == []


def test_probe_budget_stops_before_next_attempt(client, monkeypatch):
    times = iter([0, 0, 31])
    attempts = []
    monkeypatch.setattr(
        client.app.state.controller,
        "verify_gateway_key",
        lambda device: attempts.append(device.version),
    )
    with pytest.raises(Exception) as error:
        discover(
            client.app.state.controller,
            DeviceCreate(**DRAFT),
            [("sensor", KEY)],
            clock=lambda: next(times),
        )
    assert error.value.status_code == 504
    assert attempts == ["3.5"]


@pytest.mark.parametrize("version", ["3.4", "3.5"])
@pytest.mark.parametrize("valid_hmac", [True, False])
def test_actual_tinytuya_handshake_proves_key_without_dps(client, monkeypatch, version, valid_hmac):
    """Exercise the installed library's authentication, not just stub attributes."""
    key = KEY.encode()

    def build(*args, **kwargs):
        target = tinytuya.Device(*args, **kwargs)

        def exchange(payload, receive):
            if not receive:
                return True
            digest = hmac.new(
                key if valid_hmac else OTHER.encode(), target.local_nonce, hashlib.sha256
            ).digest()
            response = b"r" * 16 + digest
            if version == "3.4":
                response = AESCipher(key).encrypt(response, False)
            return TuyaMessage(1, 4, 0, response, 0, True)

        target._send_receive_quick = exchange

        def status():
            assert target.disabledetect
            target._negotiate_session_key()
            return {"Err": "900", "Payload": "data unvalid"}

        target.status = status
        return target

    client.app.state.controller.device_factory = build
    target = Device(**{**DRAFT, "version": version, "local_key": KEY, "enabled": True})
    assert client.app.state.controller.verify_gateway_key(target) is valid_hmac


@pytest.mark.parametrize("payload", [b'{"dps":{"1":true}}', b"json obj data unvalid"])
@pytest.mark.parametrize("correct_key", [True, False])
def test_actual_tinytuya_33_decryption_and_31_plaintext_guard(client, payload, correct_key):
    def build(*args, **kwargs):
        target = tinytuya.Device(*args, **kwargs)
        encrypted = AESCipher(KEY.encode()).encrypt(payload, False)
        target.status = lambda: target._decode_payload(encrypted)
        return target

    client.app.state.controller.device_factory = build
    target = Device(
        **{**DRAFT, "version": "3.3", "local_key": KEY if correct_key else OTHER, "enabled": True}
    )
    assert client.app.state.controller.verify_gateway_key(target) is correct_key
    target.version = "3.1"
    assert client.app.state.controller.verify_gateway_key(target) is False
