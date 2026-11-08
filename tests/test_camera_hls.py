import socket
from io import BytesIO

import pytest

from smarthome import camera_hls


def record(address):
    return (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 554))


@pytest.mark.parametrize("host", ["127.0.0.1", "169.254.169.254", "192.168.0.1", "100.64.0.1", "224.0.0.1"])
def test_mixed_dns_answers_are_rejected_before_connecting(monkeypatch, host):
    def unexpected_socket(*_):
        pytest.fail("unsafe DNS answers should prevent a socket connection")

    monkeypatch.setattr(socket, "getaddrinfo", lambda *_, **__: [record("8.8.8.8"), record(host)])
    monkeypatch.setattr(socket, "socket", unexpected_socket)
    with pytest.raises(camera_hls.RelayError):
        camera_hls.open_upstream("https://media.example:554/index.m3u8", "GET")


def test_public_https_uses_a_pinned_address_and_checks_each_redirect(monkeypatch):
    class MockSocket:
        def __init__(self, reply):
            self.reply = reply
            self.request = b""
            self.closed = False

        def connect(self, address):
            self.address = address

        def settimeout(self, _):
            pass

        def sendall(self, data):
            self.request += data

        def makefile(self, *_):
            return BytesIO(self.reply)

        def close(self):
            self.closed = True

    class MockTLS:
        def __init__(self):
            self.hostnames = []

        def wrap_socket(self, raw, *, server_hostname):
            self.hostnames.append(server_hostname)
            return raw

    tls = MockTLS()
    dns = []

    def resolve(hostname, port, **_):
        dns.append((hostname, port))
        return [record("8.8.8.8" if hostname == "media.example" else "1.1.1.1")]

    first = MockSocket(b"HTTP/1.1 302 Found\r\nLocation: //edge.example:554/playlist?sign=secret\r\nContent-Length: 0\r\n\r\n")
    second = MockSocket(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n#EXTM3U\n")
    raw_sockets = iter((first, second))
    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(socket, "socket", lambda *_: next(raw_sockets))
    monkeypatch.setattr(camera_hls, "TLS_CONTEXT", tls)

    upstream = camera_hls.open_upstream("https://media.example:554/live.m3u8?start=secret", "GET")
    assert dns == [("media.example", 554), ("edge.example", 554)]
    assert tls.hostnames == ["media.example", "edge.example"]
    assert first.address == ("8.8.8.8", 554) and first.closed
    assert second.address == ("1.1.1.1", 554)
    assert b"Host: edge.example:554\r\n" in second.request
    assert b"GET /playlist?sign=secret HTTP/1.1\r\n" in second.request
    assert upstream.url == "https://edge.example:554/playlist?sign=secret"
    assert b"".join(upstream.chunks(1024)) == b"#EXTM3U\n"
    upstream.close()
    assert second.closed

    redirect = MockSocket(b"HTTP/1.1 302 Found\r\nLocation: https://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\n\r\n")
    monkeypatch.setattr(socket, "socket", lambda *_: redirect)
    with pytest.raises(camera_hls.RelayError):
        camera_hls.open_upstream("https://media.example:554/live.m3u8", "GET")
    assert redirect.closed
    assert dns[-1] == ("media.example", 554)


def test_rejects_hls_variables_and_unquoted_uri():
    def unexpected(*_):
        pytest.fail("unsupported syntax should be rejected before registering a resource")

    for playlist in (
        b'#EXTM3U\n#EXT-X-DEFINE:NAME="path",VALUE="https://provider.example"\n{$path}/live.m3u8\n',
        b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=https://provider.example/secret\n",
    ):
        with pytest.raises(camera_hls.RelayError):
            camera_hls.rewrite_playlist(playlist, unexpected)


def test_stream_releases_resources_if_client_disconnects_before_first_chunk():
    import asyncio

    from starlette.requests import ClientDisconnect

    from smarthome.camera_playback import CameraMediaResponse

    class Media:
        def chunks(self, _):
            pytest.fail("the upstream body should never be read")

    async def disconnected_send(_):
        raise OSError("disconnected")

    async def unexpected_receive():
        pytest.fail("ASGI 2.4 handles disconnects through send")

    releases = []
    response = CameraMediaResponse(Media(), lambda: releases.append(True))
    scope = {"type": "http", "asgi": {"spec_version": "2.4"}}
    with pytest.raises(ClientDisconnect):
        asyncio.run(response(scope, unexpected_receive, disconnected_send))
    assert releases == [True]
