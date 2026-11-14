import pytest

from tests.test_cloud import login
from tests.test_developer_cloud import connect

pytest_plugins = ("tests.test_cloud", "tests.test_developer_cloud")
PATH = "/api/v1/cloud/devices/gateway/stream/relay"
TICKET = "a" * 43
PUBLIC = "https://cameras.example.test"
PROVIDER_URL = "https://video.example.test/live.m3u8?sign=private"


def setup_camera(client, monkeypatch, *, native=False, developer=False):
    bridge = connect(client) if developer else (login(client) or client.app.state.cloud)
    bridge = client.app.state.developer_cloud if developer else client.app.state.cloud
    bridge.device("gateway").category = "sp"
    allocations = []
    def allocate(*args, **kwargs):
        allocations.append((args, kwargs))
        return {"url": PROVIDER_URL} if developer else PROVIDER_URL
    monkeypatch.setattr(bridge.client if developer else bridge.manager,
                        "request" if developer else "get_device_stream_allocate", allocate, raising=False)
    service = client.app.state.camera_service
    service.public = PUBLIC
    control_calls = []
    def control(method, path, body=None, **kwargs):
        control_calls.append((method, path, body))
        if path == "/v1/playbacks/local":
            return {"device_id": "gateway", "type": "webrtc", "url": PUBLIC + "/play/native/" + TICKET + "/ws"} if native else None
        if path == "/v1/playbacks/hls":
            assert body["url"] == PROVIDER_URL
            return {"device_id": "gateway", "type": "hls", "url": PUBLIC + "/play/hls/" + TICKET + "/index.m3u8"}
        return None
    monkeypatch.setattr(service, "request", control)
    return bridge, allocations, control_calls


def test_local_playback_returns_module_url_without_allocating_cloud_video(cloud_client, monkeypatch):
    _, allocations, calls = setup_camera(cloud_client, monkeypatch, native=True)
    response = cloud_client.post(PATH)
    assert response.status_code == 200
    assert response.json()["type"] == "webrtc"
    assert response.json()["url"].startswith(PUBLIC + "/play/native/")
    assert response.headers["cache-control"] == "no-store"
    assert not allocations
    assert [c[1] for c in calls] == ["/v1/playbacks/local"]
    assert cloud_client.post(PATH, headers={"X-API-Key": "wrong"}).status_code == 401
    assert cloud_client.get("/api/v1/camera/play/" + TICKET + "/index.m3u8").status_code == 404


def test_cloud_fallback_hands_upstream_to_module_without_exposing_it(cloud_client, monkeypatch):
    _, allocations, calls = setup_camera(cloud_client, monkeypatch)
    response = cloud_client.post(PATH)
    assert response.status_code == 200 and response.json()["type"] == "hls"
    assert len(allocations) == 1
    assert calls[1][2]["url"] == PROVIDER_URL
    assert "private" not in response.text
    assert response.json()["url"].startswith(PUBLIC)


def test_deprecated_allocation_also_returns_module_playback(cloud_client, monkeypatch):
    setup_camera(cloud_client, monkeypatch)
    response = cloud_client.post(PATH.removesuffix("/relay"))
    assert response.status_code == 200
    assert response.json()["url"].startswith(PUBLIC)
    assert PROVIDER_URL not in response.text


def test_membership_camera_type_and_privacy_checked_before_service(cloud_client, monkeypatch):
    bridge, _, calls = setup_camera(cloud_client, monkeypatch)
    assert cloud_client.post(PATH.replace("gateway", "unknown")).status_code == 404
    device = bridge.device("gateway")
    device.category = "kg"
    assert cloud_client.post(PATH).status_code == 409
    device.category = "sp"
    device.status["basic_private"] = True
    assert cloud_client.post(PATH).status_code == 409
    assert not calls


def test_scope_lease_stops_after_provider_disconnect(cloud_client, monkeypatch):
    bridge, _, _ = setup_camera(cloud_client, monkeypatch, native=True)
    assert cloud_client.post(PATH).status_code == 200
    service = cloud_client.app.state.camera_service
    valid = next(iter(service.scopes.values()))
    assert valid()
    bridge.manager = None
    assert not valid()


def test_unconfigured_module_reports_clear_error_without_cloud_allocation(cloud_client, monkeypatch):
    login(cloud_client)
    bridge = cloud_client.app.state.cloud
    bridge.device("gateway").category = "sp"
    def unexpected(*_):
        pytest.fail("Cloud video must not be allocated without a camera module")
    monkeypatch.setattr(bridge.manager, "get_device_stream_allocate", unexpected, raising=False)
    response = cloud_client.post(PATH)
    assert response.status_code == 503 and "camera service" in response.json()["detail"]


@pytest.mark.parametrize("url", ["https://attacker.test/play/native/" + TICKET + "/ws",
                               "javascript:alert(1)", PUBLIC + "/api/config"])
def test_invalid_module_playback_is_rejected(cloud_client, monkeypatch, url):
    setup_camera(cloud_client, monkeypatch)
    monkeypatch.setattr(cloud_client.app.state.camera_service, "request",
                        lambda *_args, **_kwargs: {"device_id":"gateway","type":"webrtc","url":url})
    assert cloud_client.post(PATH).status_code == 502


def test_developer_connection_cloud_fallback_is_kept_separate(developer, monkeypatch):
    _, allocations, _ = setup_camera(developer, monkeypatch, developer=True)
    result = developer.post(PATH + "?provider=developer")
    assert result.status_code == 200
    assert allocations[0][0] == ("POST", "/v1.0/devices/gateway/stream/actions/allocate")
    assert developer.app.state.cloud.manager is None


def test_owner_native_preview_does_not_require_cloud_login(cloud_client, monkeypatch):
    service = cloud_client.app.state.camera_service
    service.public = PUBLIC
    def control(method, path, body=None, **kwargs):
        if path == "/v1/cameras":
            return [{"id": "native", "connected": True, "device_id": "camera-bound-before-logout"}]
        if path.startswith("/v1/scopes/"):
            return None
        return {"device_id": body["device_id"], "type": "webrtc",
                "url": PUBLIC + "/play/native/" + TICKET + "/ws"}
    monkeypatch.setattr(service, "request", control)
    assert cloud_client.app.state.cloud.manager is None
    result = cloud_client.post("/api/v1/cameras/native/playback")
    assert result.status_code == 200
    assert result.json()["device_id"] == "local-camera:native"
    assert cloud_client.app.state.cloud.manager is None


def test_owner_native_preview_respects_cached_camera_privacy(cloud_client, monkeypatch):
    bridge, _, _ = setup_camera(cloud_client, monkeypatch)
    bridge.device("gateway").status["basic_private"] = True
    service = cloud_client.app.state.camera_service
    calls = []
    def control(method, path, body=None, **kwargs):
        calls.append(path)
        return [{"id": "native", "connected": True, "device_id": "gateway"}]
    monkeypatch.setattr(service, "request", control)
    assert cloud_client.post("/api/v1/cameras/native/playback").status_code == 409
    assert calls == ["/v1/cameras"]


def test_local_camera_controls_are_owner_only_and_do_not_initialize_cloud(cloud_client, monkeypatch):
    calls = []
    service = cloud_client.app.state.camera_service
    monkeypatch.setattr(service, 'request', lambda method, path, body=None, **kw: calls.append((method,path,body)) or {'transport':'local'})
    path = '/api/v1/cameras/camera-id/controls'
    assert cloud_client.get(path, headers={'X-API-Key':'wrong'}).status_code == 401
    assert cloud_client.get(path).json() == {'transport':'local'}
    assert cloud_client.post(path+'/move',json={'direction':'right'}).status_code == 200
    assert cloud_client.post(path+'/move',json={'direction':'forever'}).status_code == 422
    assert cloud_client.post(path+'/commands',json={'code':'basic_nightvision','value':'2'}).status_code == 200
    assert cloud_client.post(path+'/siren').status_code == 200
    assert cloud_client.post(path+'/stop').status_code == 200
    assert calls == [('GET','/v1/cameras/camera-id/controls',None),('POST','/v1/cameras/camera-id/controls/move',{'direction':'right'}),('POST','/v1/cameras/camera-id/controls/commands',{'code':'basic_nightvision','value':'2'}),('POST','/v1/cameras/camera-id/controls/siren',{}),('POST','/v1/cameras/camera-id/controls/stop',{})]
    assert cloud_client.app.state.cloud.manager is None


def test_native_camera_room_checks_existing_rooms_and_never_exposes_credentials(cloud_client, monkeypatch):
    building = cloud_client.post('/api/v1/buildings', json={'name': 'Home'}).json()
    room = cloud_client.post('/api/v1/rooms', json={'name': 'Study', 'building_id': building['id']}).json()
    calls = []
    monkeypatch.setattr(cloud_client.app.state.camera_service, 'request',
                        lambda method, path, body=None, **kw: calls.append((method, path, body)) or body)
    path = '/api/v1/cameras/native/room'
    assert cloud_client.put(path, json={'room_id': 999999}).status_code == 404
    assert not calls
    assert cloud_client.put(path, json={'room_id': None}).status_code == 200
    assert cloud_client.put(path, json={'room_id': room['id']}).status_code == 200
    assert calls[-1] == ('PUT', '/v1/cameras/native/room', {'room_id': room['id']})
    assert cloud_client.put(path, json={'room_id': room['id']}, headers={'X-API-Key': 'wrong'}).status_code == 401


def test_native_playback_uses_fresh_lan_privacy_when_cloud_privacy_is_stale(cloud_client, monkeypatch):
    bridge, _, _ = setup_camera(cloud_client, monkeypatch, native=True)
    bridge.manager.device_map['gateway'].status['basic_private'] = True
    calls = []
    def request(method, path, body=None, **kwargs):
        calls.append(path)
        if path == '/v1/cameras':
            return [{'id': 'native', 'device_id': 'gateway', 'connected': True, 'controls_available': True}]
        if path.endswith('/controls'):
            return {'transport': 'local', 'observed_at': 1, 'state': {'basic_private': False}}
        return {'device_id': 'gateway', 'type': 'webrtc', 'url': PUBLIC + '/play/native/' + TICKET + '/ws'}
    monkeypatch.setattr(cloud_client.app.state.camera_service, 'request', request)
    response = cloud_client.post('/api/v1/cameras/native/playback')
    assert response.status_code == 200
    assert response.json()['device_id'] == 'local-camera:native'
    assert calls == ['/v1/cameras', '/v1/cameras/native/controls', '/v1/playbacks/local']


def test_batch_status_is_owner_only_and_never_initializes_cloud(cloud_client, monkeypatch):
    service = cloud_client.app.state.camera_service
    monkeypatch.setattr(service, 'request', lambda method, path, **kw: [])
    response = cloud_client.get('/api/v1/cameras/status')
    assert response.status_code == 200
    assert response.json() == {'cameras': []}
    assert response.headers['cache-control'] == 'no-store'
    assert cloud_client.get('/api/v1/cameras/status', headers={'X-API-Key': 'wrong'}).status_code == 401
    assert cloud_client.app.state.cloud.manager is None


@pytest.mark.parametrize('privacy', [True, None])
def test_native_playback_does_not_open_media_when_fresh_lan_privacy_is_on_or_unknown(cloud_client, monkeypatch, privacy):
    service = cloud_client.app.state.camera_service
    calls = []
    def request(method, path, **kwargs):
        calls.append(path)
        if path == '/v1/cameras':
            return [{'id': 'native', 'device_id': 'camera', 'connected': True, 'controls_available': True}]
        return {'transport': 'local', 'observed_at': 1, 'state': {'basic_private': privacy}}
    monkeypatch.setattr(service, 'request', request)
    assert cloud_client.post('/api/v1/cameras/native/playback').status_code == 409
    assert calls == ['/v1/cameras', '/v1/cameras/native/controls']
