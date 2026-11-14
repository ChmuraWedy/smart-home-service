import time
from types import SimpleNamespace
from threading import RLock

from fastapi import HTTPException

from smarthome.camera_status import CameraStatus


class Immediate:
    def submit(self, action, *args):
        action(*args)
    def shutdown(self, **kwargs):
        pass


def monitor():
    calls = []
    result = {'transport': 'local', 'observed_at': time.time(), 'state': {'basic_private': False}, 'functions': {}}
    def request(method, path, **kwargs):
        calls.append(path)
        if path == '/v1/cameras':
            return [{'id': 'cam', 'device_id': 'device', 'host': '192.168.1.20', 'connected': True, 'controls_available': True},
                    {'id': 'video-only', 'host': '192.168.1.21', 'connected': True}]
        return result
    instance = CameraStatus(SimpleNamespace(request=request))
    instance.pool.shutdown()
    instance.pool = Immediate()
    instance.lock = RLock()
    return instance, calls, result


def test_batch_deduplicates_authenticated_lan_probes_and_does_not_open_media():
    status, calls, _ = monitor()
    status.snapshot()
    rows = status.snapshot()['cameras']
    assert rows[0]['lan']['online'] is True
    assert rows[0]['lan']['controls']['state']['basic_private'] is False
    assert rows[1]['lan'] == {}
    assert calls == ['/v1/cameras', '/v1/cameras/cam/controls']
    status.close()


def test_late_probe_failure_cannot_replace_a_successful_command_and_busy_is_not_offline():
    status, _, result = monitor()
    status.update('cam', result)
    def fail(*args, **kwargs):
        raise HTTPException(503)
    status.service.request = fail
    status._probe('cam', 0)
    assert status.entries['cam']['online'] is True
    status._probe('cam', 1)
    assert status.entries['cam']['online'] is False
    status.update('cam', {**result, 'observed_at': result['observed_at'] + 1})
    status.service.request = lambda *args, **kwargs: (_ for _ in ()).throw(HTTPException(409))
    status._probe('cam', 2)
    assert status.entries['cam']['online'] is True
    status.close()


def test_announcements_do_not_make_a_camera_available_and_probes_repeat_after_five_seconds(monkeypatch):
    status, calls, result = monitor()
    clock = [100.0]
    monkeypatch.setattr('smarthome.camera_status.time.monotonic', lambda: clock[0])
    discovery = SimpleNamespace(observation=lambda *args: {'observed_ip': '192.168.1.20', 'last_seen': '2026-11-14T10:00:00Z'})
    first = status.snapshot(discovery)['cameras']
    assert first[1]['announcement']['observed_ip'] == '192.168.1.20'
    assert first[1]['lan'] == {}
    clock[0] += 5.01
    result['observed_at'] += 5
    status.snapshot(discovery)
    assert calls.count('/v1/cameras/cam/controls') == 2
    assert not any('video-only/controls' in path for path in calls)
    status.close()
