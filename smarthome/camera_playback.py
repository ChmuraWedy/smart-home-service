"""Short-lived, in-memory playback sessions for authenticated camera allocations."""

import hashlib
import hmac
import http.client
import logging
import re
import secrets
from collections import OrderedDict
from dataclasses import dataclass, field
from posixpath import splitext
from threading import BoundedSemaphore, Lock
from time import monotonic
from urllib.parse import unquote_plus, urlsplit
from weakref import ReferenceType, ref

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.responses import StreamingResponse

from . import camera_hls
from .camera_hls import RelayError
from .cloud_api import Provider, cloud_bridge
from .cloud_scope import scope_for

PREFIX = "/api/v1/camera/play"
router = APIRouter(prefix=PREFIX, tags=["Camera"])
IDLE_SECONDS = 180
SESSION_SECONDS = 7200
MAX_SESSIONS = 32
MAX_RESOURCES = 1024
MAX_RESOURCE_URL_BYTES = 1024 * 1024
MAX_TRANSFERS = 16
MAX_SESSION_TRANSFERS = 6
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
RESOURCE = re.compile(
    r"index\.m3u8|[a-f0-9]{32}(?:\.m3u8|\.media|"
    + "|".join(map(re.escape, camera_hls.MEDIA_EXTENSIONS))
    + ")"
)
RANGE = re.compile(r"bytes=(?:[0-9]{1,19}-[0-9]{0,19}|-[0-9]{1,19})")
CONTENT_RANGE = re.compile(r"bytes (?:[0-9]{1,19}-[0-9]{1,19}|\*)/(?:[0-9]{1,19}|\*)")
PRIVATE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}


class PlaybackAccessLogFilter(logging.Filter):
    def filter(self, record):
        # Uvicorn access records carry the request target as the third argument.
        return not (
            isinstance(record.args, tuple) and len(record.args) == 5
            and str(record.args[2]).startswith(PREFIX + "/")
        )


def install_access_log_filter():
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(existing, PlaybackAccessLogFilter) for existing in logger.filters):
        logger.addFilter(PlaybackAccessLogFilter())


def playback_connection(bridge, provider):
    return bridge.client if provider == "developer" else bridge.manager


@dataclass(frozen=True)
class Resource:
    url: str = field(repr=False)
    kind: str


@dataclass
class Playback:
    provider: Provider
    scope: str
    connection: ReferenceType
    expires: float
    idle_until: float
    resources: OrderedDict = field(default_factory=OrderedDict)
    resource_bytes: int = 0
    transfers: BoundedSemaphore = field(default_factory=lambda: BoundedSemaphore(MAX_SESSION_TRANSFERS))


class PlaybackStore:
    def __init__(self):
        self.lock = Lock()
        self.sessions = {}
        self.transfers = BoundedSemaphore(MAX_TRANSFERS)

    def _expire(self, now):
        for token, playback in list(self.sessions.items()):
            if now >= min(playback.idle_until, playback.expires):
                del self.sessions[token]

    def create(self, provider, scope, connection, url):
        now = monotonic()
        with self.lock:
            self._expire(now)
            if len(self.sessions) >= MAX_SESSIONS:
                raise HTTPException(503, "Camera playback is busy", headers=PRIVATE_HEADERS)
            token = secrets.token_urlsafe(32)
            playback = Playback(provider, scope, ref(connection), now + SESSION_SECONDS, now + IDLE_SECONDS)
            playback.resources["index.m3u8"] = Resource(url, "playlist")
            playback.resource_bytes = len(url)
            self.sessions[token] = playback
        return f"{PREFIX}/{token}/index.m3u8"

    def find(self, token, name):
        with self.lock:
            self._expire(monotonic())
            playback = self.sessions.get(token)
            return (playback, playback.resources.get(name)) if playback else (None, None)

    def touch(self, token, playback, name):
        with self.lock:
            now = monotonic()
            self._expire(now)
            if self.sessions.get(token) is not playback or name not in playback.resources:
                raise HTTPException(404, "Camera playback has expired", headers=PRIVATE_HEADERS)
            playback.resources.move_to_end(name)
            playback.idle_until = now + IDLE_SECONDS

    def resource_url(self, token, playback, base, reference, kind):
        url = camera_hls.join_stream_url(base, reference)
        suffix = ".m3u8"
        if kind == "media":
            ext = splitext(urlsplit(url).path)[1].lower()
            suffix = ext if ext in camera_hls.MEDIA_EXTENSIONS else ".media"
        digest = hmac.new(token.encode(), (kind + ":" + url).encode(), hashlib.sha256)
        name = digest.hexdigest()[:32] + suffix
        with self.lock:
            if name not in playback.resources:
                playback.resources[name] = Resource(url, kind)
                playback.resource_bytes += len(url)
            playback.resources.move_to_end(name)
            # Keep the allocated entry point available for the full session.
            playback.resources.move_to_end("index.m3u8")
            while len(playback.resources) > MAX_RESOURCES or playback.resource_bytes > MAX_RESOURCE_URL_BYTES:
                _, evicted = playback.resources.popitem(last=False)
                playback.resource_bytes -= len(evicted.url)
        return f"{PREFIX}/{token}/{name}"


def reload_url(request, resource):
    directives = []
    seen = set()
    for key, value in request.query_params.multi_items():
        if resource.kind != "playlist" or key in seen:
            raise RelayError()
        if key in {"_HLS_msn", "_HLS_part"}:
            if not re.fullmatch(r"[0-9]{1,16}", value):
                raise RelayError()
        elif key != "_HLS_skip" or value not in {"YES", "v2"}:
            raise RelayError()
        seen.add(key)
        directives.append(f"{key}={value}")
    if "_HLS_part" in seen and "_HLS_msn" not in seen:
        raise RelayError()
    if not directives:
        return resource.url
    url = urlsplit(resource.url)
    # Keep existing signed query bytes intact and never overwrite a provider parameter.
    if any(unquote_plus(field.partition("=")[0]) in seen for field in url.query.split("&")):
        raise RelayError()
    query = "&".join(filter(None, (url.query, *directives)))
    return url._replace(query=query).geturl()


class CameraMediaResponse(StreamingResponse):
    def __init__(self, upstream, release, **kwargs):
        def chunks():
            try:
                yield from upstream.chunks(camera_hls.MEDIA_LIMIT)
            except (RelayError, OSError, http.client.HTTPException):
                raise RuntimeError("Camera media transfer interrupted") from None

        super().__init__(chunks(), **kwargs)
        self.release = release

    async def __call__(self, scope, receive, send):
        # This also runs when the browser disconnects before reading a body chunk.
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.release()


def prepare_response(request, store, token, playback, resource, upstream, release):
    response = upstream.response
    upstream_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    is_playlist = resource.kind == "playlist" or upstream_type in camera_hls.MANIFEST_TYPES
    encoding = response.getheader("Content-Encoding")
    if encoding and encoding.strip().lower() != "identity":
        raise RelayError()
    headers = PRIVATE_HEADERS.copy()
    if response.status == 416:
        value = response.getheader("Content-Range", "")
        if CONTENT_RANGE.fullmatch(value):
            headers["Content-Range"] = value
        return Response(status_code=416, headers=headers)
    if response.status not in (200, 206):
        # Empty error bodies keep signed URLs and provider details private.
        status = response.status if response.status in {403, 404, 410, 429, 503} else 502
        return Response(status_code=status, headers=headers)
    if is_playlist:
        if response.status != 200:
            raise RelayError()
        if request.method == "HEAD":
            headers["Content-Type"] = camera_hls.MANIFEST_TYPE
            result = Response(headers=headers)
            del result.headers["Content-Length"]
            return result
        body = b"".join(upstream.chunks(camera_hls.MANIFEST_LIMIT))
        body = camera_hls.rewrite_playlist(
            body,
            lambda ref, kind: store.resource_url(token, playback, upstream.url, ref, kind),
        )
        return Response(body, headers=headers, media_type=camera_hls.MANIFEST_TYPE)
    suffix = splitext(urlsplit(resource.url).path)[1].lower()
    media_type = camera_hls.MEDIA_EXTENSIONS.get(suffix, "application/octet-stream")
    if upstream_type in camera_hls.MEDIA_TYPES:
        media_type = upstream_type
    size = response.getheader("Content-Length")
    if size is not None:
        if not re.fullmatch(r"[0-9]{1,10}", size) or int(size) > camera_hls.MEDIA_LIMIT:
            raise RelayError()
        headers["Content-Length"] = size
    if response.status == 206:
        value = response.getheader("Content-Range", "")
        if not CONTENT_RANGE.fullmatch(value) or "*" in value.split("/")[0]:
            raise RelayError()
        headers["Content-Range"] = value
    if response.getheader("Accept-Ranges") == "bytes":
        headers["Accept-Ranges"] = "bytes"
    if request.method == "HEAD":
        result = Response(status_code=response.status, headers=headers, media_type=media_type)
        if size is None:
            del result.headers["Content-Length"]
        return result
    return CameraMediaResponse(upstream, release, status_code=response.status, headers=headers, media_type=media_type)


@router.api_route("/{token}/{name}", methods=["GET", "HEAD"], include_in_schema=False)
def play(request: Request, token: str, name: str):
    if not TOKEN.fullmatch(token) or not RESOURCE.fullmatch(name):
        raise HTTPException(404, "Camera playback unavailable", headers=PRIVATE_HEADERS)
    store = request.app.state.camera_playback
    playback, resource = store.find(token, name)
    if not resource:
        raise HTTPException(404, "Camera playback unavailable", headers=PRIVATE_HEADERS)
    try:
        bridge = cloud_bridge(request, playback.provider)
        scope = scope_for(bridge, playback.provider)
        connection = playback_connection(bridge, playback.provider)
    except HTTPException:
        scope, connection = None, None
    if scope != playback.scope or connection is None or playback.connection() is not connection:
        raise HTTPException(404, "Camera playback unavailable", headers=PRIVATE_HEADERS)
    try:
        url = reload_url(request, resource)
        byte_range = request.headers.get("Range") if resource.kind == "media" else None
        if byte_range is not None and not RANGE.fullmatch(byte_range):
            raise RelayError()
    except RelayError:
        return Response(status_code=400, headers=PRIVATE_HEADERS)
    if not store.transfers.acquire(blocking=False):
        return Response(status_code=503, headers=PRIVATE_HEADERS)
    if not playback.transfers.acquire(blocking=False):
        store.transfers.release()
        return Response(status_code=503, headers=PRIVATE_HEADERS)
    upstream = None
    streaming = False

    def release():
        try:
            if upstream is not None:
                upstream.close()
        finally:
            playback.transfers.release()
            store.transfers.release()

    try:
        store.touch(token, playback, name)
        upstream = camera_hls.open_upstream(url, request.method, byte_range)
        result = prepare_response(request, store, token, playback, resource, upstream, release)
        streaming = isinstance(result, CameraMediaResponse)
        return result
    except (RelayError, OSError, http.client.HTTPException):
        return Response(status_code=502, headers=PRIVATE_HEADERS)
    finally:
        if not streaming:
            release()
