import pytest

from tests.test_cloud import login
from tests.test_developer_cloud import connect

pytest_plugins = ("tests.test_cloud", "tests.test_developer_cloud")

PATH = '/api/v1/cloud/devices/gateway/stream'
URL = 'https://video.example.test/live.m3u8?sign=ephemeral'


def camera(client, monkeypatch):
    login(client)
    bridge = client.app.state.cloud
    bridge.device('gateway').category = 'sp'
    calls = []
    def allocate(device_id, protocol):
        calls.append((device_id, protocol))
        return URL
    monkeypatch.setattr(bridge.manager, 'get_device_stream_allocate', allocate, raising=False)
    return bridge, calls


def test_stream_is_explicit_authenticated_and_not_cached(cloud_client, monkeypatch):
    bridge, calls = camera(cloud_client, monkeypatch)
    cloud_client.get('/api/v1/cloud/devices')
    assert calls == []
    response = cloud_client.post(PATH)
    assert response.status_code == 200
    assert response.json() == {'device_id':'gateway', 'type':'hls', 'url':URL}
    assert response.headers['cache-control'] == 'no-store'
    assert calls == [('gateway','hls')]
    assert 'ephemeral' not in bridge.path.read_text()
    assert cloud_client.post(PATH, headers={'X-API-Key':'wrong'}).status_code == 401
    assert len(calls) == 1


def test_membership_and_camera_type_are_checked_before_allocation(cloud_client, monkeypatch):
    bridge, calls = camera(cloud_client, monkeypatch)
    assert cloud_client.post(PATH.replace('gateway','unknown')).status_code == 404
    bridge.device('gateway').category = 'kg'
    assert cloud_client.post(PATH).status_code == 409
    assert calls == []


@pytest.mark.parametrize('url', [None, '', 'rtsp://video.test/live', 'http://video.test/live', 'https://user:password@video.test/live', 'https://video.test:bad/live', 'https://video.test/live\nsecret'])
def test_rejects_invalid_stream_addresses_without_exposing_them(cloud_client, monkeypatch, url):
    bridge, _ = camera(cloud_client, monkeypatch)
    monkeypatch.setattr(bridge.manager, 'get_device_stream_allocate', lambda *_: url)
    response = cloud_client.post(PATH)
    assert response.status_code == 502
    assert 'password' not in response.text and 'secret' not in response.text


def test_stream_error_is_sanitized_without_retry(cloud_client, monkeypatch):
    bridge, _ = camera(cloud_client, monkeypatch)
    calls = []
    def fail(*args):
        calls.append(args)
        raise RuntimeError('private token and signed URL')
    monkeypatch.setattr(bridge.manager, 'get_device_stream_allocate', fail)
    response = cloud_client.post(PATH)
    assert response.status_code == 502 and 'private' not in response.text
    assert len(calls) == 1


def test_developer_stream_uses_only_selected_connection(developer, monkeypatch):
    bridge = connect(developer)
    bridge.device('gateway').category = 'sp'
    calls = []
    def request(method, path, body):
        calls.append((method,path,body))
        return {'url':URL}
    monkeypatch.setattr(bridge.client, 'request', request)
    result = developer.post(PATH + '?provider=developer')
    assert result.status_code == 200 and result.json()['url'] == URL
    assert calls == [('POST','/v1.0/devices/gateway/stream/actions/allocate',{'type':'hls'})]
    assert developer.app.state.cloud.manager is None
