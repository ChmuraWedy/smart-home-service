from dataclasses import replace
import importlib.util
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from smarthome import device_access

spec = importlib.util.spec_from_file_location("device_network", Path(__file__).parents[1] / "deploy/device-network.py")
host_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_agent)
CONFIG = {"192.168.40.12": {"host": "192.168.40.12", "mac": "00:11:22:33:44:55", "interface": "br40"}}


def test_mac_rules_target_one_device_and_keep_lan():
    host_agent.validate(CONFIG)
    text = host_agent.rules(CONFIG, {"192.168.40.12": True}, True)
    assert "priority -30" in text
    assert "ether saddr 00:11:22:33:44:55 ip daddr != " + host_agent.PRIVATE in text
    assert "ip daddr 192.168.40.12 ip saddr != " + host_agent.PRIVATE in text
    assert text.count("drop comment") == 3 and "meta nfproto ipv6" in text
    assert "delete table inet netmgr" not in text
    assert "00:11:22:33:44:55" not in host_agent.rules(CONFIG, {}, True)


@pytest.mark.parametrize("field,value", [("host", "1.1.1.1"), ("mac", "bad"), ("interface", 'br40"; flush ruleset')])
def test_host_agent_rejects_invalid_allowlist(field, value):
    with pytest.raises(ValueError):
        host_agent.validate({"192.168.40.12": {**CONFIG["192.168.40.12"], field: value}})


def test_firewall_failure_does_not_save_state(tmp_path, monkeypatch):
    policy = object.__new__(host_agent.Policy)
    policy.config, policy.path, policy.blocked = CONFIG, tmp_path / "state.json", {}
    monkeypatch.setattr(policy, "apply", lambda _: (_ for _ in ()).throw(RuntimeError()))
    with pytest.raises(RuntimeError):
        policy.set("192.168.40.12", True)
    assert not policy.path.exists() and policy.blocked == {}


def test_disk_failure_rolls_back_firewall(tmp_path, monkeypatch):
    policy = object.__new__(host_agent.Policy)
    policy.config, policy.path, policy.blocked = CONFIG, tmp_path / "state.json", {}
    applied = []
    monkeypatch.setattr(policy, "apply", lambda value: applied.append(value))
    monkeypatch.setattr(host_agent.os, "replace", lambda *_: (_ for _ in ()).throw(OSError()))
    with pytest.raises(OSError):
        policy.set("192.168.40.12", True)
    assert applied == [{"192.168.40.12": True}, {}] and policy.blocked == {}


def test_device_access_requires_owner_and_uses_saved_address(client, direct, monkeypatch):
    client.app.state.settings = replace(client.app.state.settings, api_token="owner-test-key")
    client.headers["X-API-Key"] = "owner-test-key"
    calls = []
    def request(address, blocked=None):
        calls.append((address, blocked))
        return {"available": True, "blocked": bool(blocked), "verified": True}
    monkeypatch.setattr(device_access, "host_request", request)
    path = f'/api/v1/device-access/local/{direct["id"]}'
    response = client.get(path)
    assert response.status_code == 200, response.text
    assert response.json()["host"] == "192.168.1.40"
    assert response.json()["local_available"] is True
    assert "0123456789abcdef" not in response.text
    assert client.put(path + "/internet", json={"blocked": True}).json()["blocked"] is True
    assert calls == [("192.168.1.40", None), ("192.168.1.40", True)]
    assert client.put(path + "/internet", json={"blocked": "false"}).status_code == 422
    assert client.put(path + "/internet", json={"blocked": True, "host": "1.1.1.1"}).status_code == 422
    assert client.get(path, headers={"X-API-Key": "wrong"}).status_code == 401


def test_unavailable_policy_does_not_claim_allowed(client, direct, monkeypatch):
    client.app.state.settings = replace(client.app.state.settings, api_token="owner-test-key")
    client.headers["X-API-Key"] = "owner-test-key"
    monkeypatch.setattr(device_access, "host_request", lambda *_: (_ for _ in ()).throw(HTTPException(503, "offline")))
    path = f'/api/v1/device-access/local/{direct["id"]}'
    result = client.get(path).json()
    assert result["internet"] == {"available": False, "blocked": None, "verified": False}
    assert client.put(path + "/internet", json={"blocked": True}).status_code == 503


def test_shared_gateway_is_not_blocked_for_one_child(client, gateway, child, monkeypatch):
    client.app.state.settings = replace(client.app.state.settings, api_token="owner-test-key")
    client.headers["X-API-Key"] = "owner-test-key"
    monkeypatch.setattr(device_access, "host_request", lambda *_: pytest.fail("Gateway must not be blocked"))
    path = f'/api/v1/device-access/local/{child["id"]}'
    assert client.get(path).json()["internet"]["available"] is False
    assert client.put(path + "/internet", json={"blocked": True}).status_code == 409
