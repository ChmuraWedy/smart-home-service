import threading
import time
from datetime import timedelta

import pytest

from smarthome.models import utcnow
from smarthome.visible_status import MAX_WATCHES, VisibleStatusPoller


@pytest.fixture
def visible(client, monkeypatch):
    client.app.state.visible_status.stop()
    clock = [0.0]
    start = utcnow()
    monkeypatch.setattr(
        "smarthome.visible_status.utcnow", lambda: start + timedelta(seconds=clock[0])
    )
    poller = VisibleStatusPoller(client.app, clock=lambda: clock[0])
    client.app.state.visible_status = poller
    return poller, clock


def settle(poller):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        with poller.lock:
            if not poller.inflight:
                return
        threading.Event().wait(0.005)
    pytest.fail("Status reader did not finish")


def heartbeat(client, poller, clock, id, seconds=5):
    for _ in range(seconds):
        clock[0] += 1
        response = client.get(f"/api/v1/devices/{id}/state?watch=true")
        assert response.status_code == 200
        poller.tick()
    settle(poller)


def test_cache_heartbeat_reads_lan_only_in_background_every_five_seconds(
    client, direct, factory, visible
):
    poller, clock = visible
    id = direct["id"]
    for _ in range(2):  # Multiple browsers share this same watch.
        response = client.get(f"/api/v1/devices/{id}/state?watch=true")
        assert response.status_code == 200 and not response.json()["available"]
    assert factory.commands == []
    heartbeat(client, poller, clock, id, 4)
    assert factory.commands == []
    heartbeat(client, poller, clock, id, 1)
    assert factory.commands == [("wifi-1", "status", None)]
    cached = client.get(f"/api/v1/devices/{id}/state").json()
    assert cached["values"]["switch"]["value"] is True
    assert len(factory.commands) == 1
    heartbeat(client, poller, clock, id, 5)
    assert len(factory.commands) == 2
    # Closing, hiding or scrolling away stops heartbeats. The lease expires.
    clock[0] += 5
    poller.tick()
    settle(poller)
    assert len(factory.commands) == 2 and not poller.watches


def test_cache_reads_without_watch_never_schedule_network_io(client, direct, factory, visible):
    poller, clock = visible
    client.get(f"/api/v1/devices/{direct['id']}/state")
    clock[0] = 20
    poller.tick()
    settle(poller)
    assert not poller.watches and not factory.commands


def test_slow_read_never_overlaps_or_queues_duplicates(client, direct, visible, monkeypatch):
    poller, clock = visible
    started, release = threading.Event(), threading.Event()
    calls = []

    def read(*args):
        calls.append(args[0].id)
        started.set()
        release.wait(timeout=2)
        return {"1": False}

    monkeypatch.setattr(client.app.state.controller, "execute", read)
    poller.touch(direct["id"])
    for moment in [2, 4, 5]:
        clock[0] = moment
        poller.touch(direct["id"])
    poller.tick()
    try:
        assert started.wait(timeout=1)
        clock[0] = 10
        poller.touch(direct["id"])
        poller.tick()
        assert calls == [direct["id"]]
    finally:
        release.set()
        settle(poller)


def test_failed_poll_preserves_observation_and_disabled_devices_are_skipped(
    client, direct, factory, visible
):
    poller, clock = visible
    factory.result = TimeoutError()
    poller.touch(direct["id"])
    heartbeat(client, poller, clock, direct["id"])
    state = client.get(f"/api/v1/devices/{direct['id']}/state").json()
    assert not state["available"] and not state["values"]["switch"]["known"]
    assert client.get(f"/api/v1/devices/{direct['id']}").json()["last_seen_at"] is None
    assert (
        client.patch(f"/api/v1/devices/{direct['id']}", json={"enabled": False}).status_code == 200
    )
    heartbeat(client, poller, clock, direct["id"])
    assert factory.commands == [("wifi-1", "status", None)]


def test_visible_child_uses_its_saved_gateway(client, child, factory, visible):
    poller, clock = visible
    poller.touch(child["id"])
    heartbeat(client, poller, clock, child["id"])
    assert factory.commands == [("child-1", "status", None)]
    assert factory.instances[-1].kwargs["parent"].id == "gateway-1"


def test_visible_watches_are_bounded_and_expire(visible):
    poller, clock = visible
    for id in range(MAX_WATCHES):
        poller.touch(id)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as failure:
        poller.touch(MAX_WATCHES)
    assert failure.value.status_code == 503
    clock[0] += 4
    poller.touch(MAX_WATCHES)
    assert list(poller.watches) == [MAX_WATCHES]


def test_response_from_replaced_connection_does_not_enter_new_configuration_cache(
    client, direct, visible, monkeypatch
):
    poller, clock = visible
    started, release = threading.Event(), threading.Event()

    def read(*args):
        started.set()
        release.wait(timeout=2)
        return {"1": True}

    monkeypatch.setattr(client.app.state.controller, "execute", read)
    for moment in [0, 2, 4, 5]:
        clock[0] = moment
        poller.touch(direct["id"])
    poller.tick()
    try:
        assert started.wait(timeout=1)
        assert (
            client.patch(f"/api/v1/devices/{direct['id']}", json={"ip": "192.168.1.41"}).status_code
            == 200
        )
    finally:
        release.set()
        settle(poller)
    state = client.get(f"/api/v1/devices/{direct['id']}/state").json()
    assert not state["values"]["switch"]["known"]
