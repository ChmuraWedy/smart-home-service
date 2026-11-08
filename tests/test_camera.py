import re

import pytest

from tests.test_cloud import login
from tests.test_developer_cloud import connect

pytest_plugins = ("tests.test_cloud", "tests.test_developer_cloud")

PATH = '/api/v1/cloud/devices/gateway/stream/relay'
URL = 'https://video.example.test/live.m3u8?sign=ephemeral'


def camera(client, monkeypatch, url=URL):
    login(client)
    bridge = client.app.state.cloud
    bridge.device('gateway').category = 'sp'
    calls = []
    def allocate(device_id, protocol):
        calls.append((device_id, protocol))
        return url
    monkeypatch.setattr(bridge.manager, 'get_device_stream_allocate', allocate, raising=False)
    return bridge, calls


@pytest.mark.parametrize("url", [URL, URL.replace("video.example.test", "video.example.test:8080")])
def test_stream_is_explicit_authenticated_and_not_cached(cloud_client, monkeypatch, url):
    bridge, calls = camera(cloud_client, monkeypatch, url)
    cloud_client.get('/api/v1/cloud/devices')
    assert calls == []
    response = cloud_client.post(PATH)
    assert response.status_code == 200
    playback = response.json()["url"]
    assert response.json() == {"device_id": "gateway", "type": "hls", "url": playback}
    assert re.fullmatch(r"/api/v1/camera/play/[A-Za-z0-9_-]{43}/index\.m3u8", playback)
    assert "ephemeral" not in response.text
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
    assert result.status_code == 200 and result.json()['url'].startswith('/api/v1/camera/play/')
    assert calls == [('POST','/v1.0/devices/gateway/stream/actions/allocate',{'type':'hls'})]
    assert developer.app.state.cloud.manager is None


def media_client(client):
    """Native HLS fetches the allocated path without the API key."""
    from fastapi.testclient import TestClient

    return TestClient(client.app)


class UpstreamFixture:
    def __init__(self, url, body, content_type, status=200, **headers):
        self.url = url
        self.response = self
        self.body = body
        self.headers = {"Content-Type": content_type, **headers}
        self.status = status
        self.closed = False
        self.read_limits = []

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def chunks(self, limit):
        self.read_limits.append(limit)
        yield from (self.body[:5], self.body[5:])

    def close(self):
        self.closed = True


def test_relays_master_and_media_with_keys_maps_parts_ranges_and_redirect_base(cloud_client, monkeypatch):
    from smarthome import camera_hls

    camera(cloud_client, monkeypatch)
    player = media_client(cloud_client)
    ticket = cloud_client.post(PATH).json()["url"]
    upstream = {
        URL: UpstreamFixture("https://edge.example.test:554/new/master.m3u8", b"""#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English, US",URI="//audio.example.test/track.m3u8?sig=secret"
#EXT-X-CONTENT-STEERING:SERVER-URI="https://edge.example.test/steering.json"
#EXT-X-STREAM-INF:BANDWIDTH=64000,AUDIO="a"
variant/index.m3u8?token=ephemeral
""", "application/x-mpegURL"),
        "https://edge.example.test:554/new/variant/index.m3u8?token=ephemeral&_HLS_msn=12&_HLS_part=3":
            UpstreamFixture("https://edge.example.test:554/new/variant/index.m3u8?token=ephemeral", b"""#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="keys/aes?sign=secret"
#EXT-X-MAP:URI="init.mp4",BYTERANGE="12@0"
#EXT-X-PART:DURATION=0.333,URI="parts/chunk.m4s"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="parts/next.m4s"
#EXT-X-RENDITION-REPORT:URI="../low.m3u8",LAST-MSN=12
#EXT-X-DATERANGE:ID="ad",CLASS="com.apple.hls.interstitial",X-ASSET-LIST="https://edge.example.test/assets.json"
#EXTINF:4.0,https://edge.example.test/metadata?sign=secret
segment.ts?sign=secret
""", "application/octet-stream"),
        "https://edge.example.test:554/new/variant/segment.ts?sign=secret":
            UpstreamFixture("segment", b"portion", "video/mp2t", 206, **{
                "Content-Range": "bytes 2-8/20", "Content-Length": "7", "Accept-Ranges": "bytes",
                "Set-Cookie": "provider-private", "Location": "https://edge.example.test/private",
            }),
        "https://edge.example.test:554/new/variant/keys/aes?sign=secret":
            UpstreamFixture("key", b"key-bytes", "application/octet-stream"),
    }
    calls = []

    def open_media(url, method, byte_range):
        calls.append((url, method, byte_range))
        return upstream[url]

    monkeypatch.setattr(camera_hls, "open_upstream", open_media)
    master = player.get(ticket)
    assert master.status_code == 200
    assert master.headers["content-type"] == camera_hls.MANIFEST_TYPE
    assert "no-store" in master.headers["cache-control"]
    assert master.headers["referrer-policy"] == "no-referrer"
    assert "ephemeral" not in master.text and "secret" not in master.text
    assert "CONTENT-STEERING" not in master.text
    assert 'NAME="English, US"' in master.text
    assert all(resource.startswith(ticket.rsplit("/", 1)[0]) for resource in re.findall(r"(/api/v1/camera/play/[^\s\"]+)", master.text))
    variant_url = master.text.splitlines()[-1]
    assert variant_url.endswith(".m3u8")
    variant = player.get(variant_url + "?_HLS_msn=12&_HLS_part=3")
    assert variant.status_code == 200 and variant.headers["content-type"] == camera_hls.MANIFEST_TYPE
    assert "X-ASSET-LIST" not in variant.text and "secret" not in variant.text and "https://" not in variant.text
    assert 'BYTERANGE="12@0"' in variant.text
    references = re.findall(r'URI="([^"]+)"', variant.text)
    assert len(references) == 5
    assert all(uri.startswith(ticket.rsplit("/", 1)[0] + "/") for uri in references)
    assert references[-1].endswith(".m3u8")
    assert player.get(references[0]).content == b"key-bytes"

    segment = variant.text.splitlines()[-1]
    response = player.get(segment, headers={"Range": "bytes=2-8", "Authorization": "client-secret"})
    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 2-8/20"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.content == b"portion"
    assert "set-cookie" not in response.headers and "location" not in response.headers
    assert calls[-1] == ("https://edge.example.test:554/new/variant/segment.ts?sign=secret", "GET", "bytes=2-8")
    assert player.head(segment, headers={"Range": "bytes=2-8"}).content == b""
    assert calls[-1][1:] == ("HEAD", "bytes=2-8")
    assert all(resource.closed for resource in upstream.values())
    assert upstream[URL].read_limits == [camera_hls.MANIFEST_LIMIT]
    assert upstream[calls[-1][0]].read_limits == [camera_hls.MEDIA_LIMIT]


@pytest.mark.parametrize("query", ["?url=https://public.example/", "?_HLS_part=3", "?_HLS_msn=-1", "?_HLS_skip=true", "?_HLS_msn=1&_HLS_msn=2"])
def test_rejects_client_supplied_upstream_parameters(cloud_client, monkeypatch, query):
    from smarthome import camera_hls

    camera(cloud_client, monkeypatch)
    ticket = cloud_client.post(PATH).json()["url"]

    def unexpected(*_):
        pytest.fail("invalid ticket parameters should not trigger an outbound request")

    monkeypatch.setattr(camera_hls, "open_upstream", unexpected)
    player = media_client(cloud_client)
    assert player.get(ticket + query).status_code == 400
    assert player.get(ticket.rsplit("/", 1)[0] + "/" + "0" * 32 + ".media").status_code == 404


@pytest.mark.parametrize("unsafe", [
    "http://provider.example/segment",
    "https://localhost@media.example/segment",
    "https://127.0.0.1/segment",
    "https://127.0.0.1:8080/segment",
    "https://169.254.169.254/metadata",
    "https://[::1]/metadata",
    "https://[::ffff:127.0.0.1]/metadata",
    "https://[64:ff9b::a9fe:a9fe]/metadata",
    "https://public.example:8000/segment",
    "data:text/html,private",
    "https://valid.example/segment#hidden",
])
def test_rejects_unsafe_playlist_references_without_leaking_them(cloud_client, monkeypatch, unsafe):
    from smarthome import camera_hls

    camera(cloud_client, monkeypatch)
    ticket = cloud_client.post(PATH).json()["url"]
    upstream = UpstreamFixture(URL, f'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="{unsafe}"\n'.encode(), "application/x-mpegurl")
    monkeypatch.setattr(camera_hls, "open_upstream", lambda *_: upstream)
    response = media_client(cloud_client).get(ticket)
    assert response.status_code == 502 and not response.content
    assert upstream.closed


def test_ticket_expires_after_idle_and_is_revoked_when_account_reconnects(cloud_client, monkeypatch):
    from smarthome import camera_hls, camera_playback

    bridge, _ = camera(cloud_client, monkeypatch)
    now = 100
    monkeypatch.setattr(camera_playback, "monotonic", lambda: now)
    first = cloud_client.post(PATH).json()["url"]
    player = media_client(cloud_client)
    upstream = UpstreamFixture(URL, b"#EXTM3U\n#EXTINF:2,\nsegment.ts\n", "application/x-mpegurl")
    monkeypatch.setattr(camera_hls, "open_upstream", lambda *_: upstream)
    now += camera_playback.IDLE_SECONDS - 1
    assert player.get(first).status_code == 200
    now += camera_playback.IDLE_SECONDS - 1
    assert player.get(first).status_code == 200
    now += camera_playback.IDLE_SECONDS
    assert player.get(first).status_code == 404
    second = cloud_client.post(PATH).json()["url"]
    bridge.manager = type(bridge.manager)(None, None, None, None, None, None)
    assert player.get(second).status_code == 404


def test_playback_releases_capacity_after_upstream_failure(cloud_client, monkeypatch):
    from smarthome import camera_hls

    camera(cloud_client, monkeypatch)
    ticket = cloud_client.post(PATH).json()["url"]

    def fail(*_):
        raise OSError("signed stream data")

    monkeypatch.setattr(camera_hls, "open_upstream", fail)
    player = media_client(cloud_client)
    for _ in range(8):
        response = player.get(ticket)
        assert response.status_code == 502 and not response.content


def test_access_logger_skips_playback_credentials():
    import logging

    from smarthome.camera_playback import PlaybackAccessLogFilter

    def request_log(path):
        return logging.LogRecord(
            "uvicorn.access", logging.INFO, __file__, 0,
            '%s - "%s %s HTTP/%s" %d', ("local", "GET", path, "1.1", 200), None,
        )

    relay_filter = PlaybackAccessLogFilter()
    assert not relay_filter.filter(request_log("/api/v1/camera/play/ticket/index.m3u8"))
    assert relay_filter.filter(request_log(PATH))


def test_legacy_frontend_can_still_use_the_direct_stream(cloud_client, monkeypatch):
    _, calls = camera(cloud_client, monkeypatch)
    response = cloud_client.post(PATH.removesuffix("/relay"))
    assert response.status_code == 200
    assert response.json() == {"device_id": "gateway", "type": "hls", "url": URL}
    assert response.headers["cache-control"] == "no-store"
    assert calls == [("gateway", "hls")]


def test_relay_exposes_byte_range_headers_to_configured_frontends(tmp_path):
    from fastapi.testclient import TestClient

    from smarthome.config import Settings
    from smarthome.main import create_app

    origin = "http://frontend.test"
    settings = Settings(database_path=str(tmp_path / "inventory.db"), cors_origins=(origin,))
    with TestClient(create_app(settings)) as client:
        url = "/api/v1/camera/play/" + "x" * 43 + "/index.m3u8"
        preflight = client.options(url, headers={
            "Origin": origin, "Access-Control-Request-Method": "HEAD",
            "Access-Control-Request-Headers": "range",
        })
        response = client.get(url, headers={"Origin": origin})
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == origin
    assert "Range" in preflight.headers["access-control-allow-headers"]
    assert response.status_code == 404
    assert "Content-Range" in response.headers["access-control-expose-headers"]
