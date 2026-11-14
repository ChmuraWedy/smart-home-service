"""Control-plane client for the independently deployed camera module."""
import hashlib
import json
import secrets
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi import Request as APIRequest
from pydantic import Field, SecretStr
from sqlalchemy.orm import Session

from .api_dependencies import get_session, require_owner
from .schemas import Schema


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class CameraService:
    def __init__(self, settings):
        self.url = settings.camera_service_url.rstrip("/")
        self.token = settings.camera_service_token or settings.api_token
        self.public = settings.camera_public_url.rstrip("/")
        self.scopes = {}
        self.lock = threading.Lock()
        self.salt = secrets.token_hex(16)
        self.stop = threading.Event()
        self.thread = None
        from .camera_status import CameraStatus
        self.status = CameraStatus(self)
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        if self.url:
            parsed = urlsplit(self.url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
                raise ValueError("Invalid camera service URL")
            self.thread = threading.Thread(target=self._heartbeat, name="camera-scope-leases", daemon=True)
            self.thread.start()

    def request(self, method, path, body=None, *, missing=False, timeout=8):
        if not self.url:
            raise HTTPException(503, "Configure the separate camera service to use camera video")
        data = json.dumps(body).encode() if body is not None else None
        request = Request(self.url + path, data=data, method=method,
                          headers={"X-API-Key": self.token, "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise ValueError()
                return json.loads(raw) if raw else None
        except HTTPError as error:
            if missing and error.code == 404:
                return None
            status = error.code if error.code in {400, 404, 409, 422, 429, 503} else 502
            raise HTTPException(status, "Camera service could not complete the request") from None
        except (URLError, OSError, ValueError):
            raise HTTPException(502, "Camera service is unavailable") from None

    def scope(self, provider, account_scope, connection, valid):
        value = hashlib.sha256(f"{self.salt}:{provider}:{account_scope}:{id(connection)}".encode()).hexdigest()
        with self.lock:
            self.scopes[value] = valid
        return value

    def _heartbeat(self):
        while not self.stop.wait(5):
            with self.lock:
                scopes = list(self.scopes.items())
            for value, valid in scopes:
                try:
                    current = valid()
                except Exception:
                    current = False
                try:
                    self.request("PUT" if current else "DELETE", "/v1/scopes/" + value, timeout=2)
                except HTTPException:
                    pass  # Media service leases fail closed after 30 seconds.
                if not current:
                    with self.lock:
                        self.scopes.pop(value, None)

    def validate_playback(self, value, device_id):
        try:
            if value["device_id"] != device_id or value["type"] not in {"hls", "webrtc"}:
                raise ValueError()
            source = urlsplit(value["url"])
            expected = urlsplit(self.public)
            if source.scheme not in {"http", "https"} or source.netloc != expected.netloc or source.scheme != expected.scheme or source.username or source.query or source.fragment:
                raise ValueError()
            import re
            pattern = r"/play/hls/[A-Za-z0-9_-]{43}/index\.m3u8" if value["type"] == "hls" else r"/play/native/[A-Za-z0-9_-]{43}/ws"
            if not re.fullmatch(pattern, source.path):
                raise ValueError()
            return value
        except (KeyError, TypeError, ValueError):
            raise HTTPException(502, "Camera service returned an invalid playback URL") from None

    def close(self):
        self.status.close()
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=5)
        with self.lock:
            scopes = list(self.scopes)
            self.scopes.clear()
        for value in scopes:
            try:
                self.request("DELETE", "/v1/scopes/" + value, timeout=2)
            except HTTPException:
                pass


router = APIRouter(prefix="/api/v1/cameras", tags=["Cameras"], dependencies=[Depends(require_owner)])


class CameraConnection(Schema):
    device_id: str | None = Field(default=None, min_length=1, max_length=128)
    username: str = Field(default="", max_length=128)
    password: SecretStr = SecretStr("")
    profile: str | None = None
    transcode: bool = True


@router.get("/service")
def service_status(request: APIRequest):
    return {"configured": bool(request.app.state.camera_service.url)}


@router.get("")
def cameras(request: APIRequest, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.camera_service.request("GET", "/v1/cameras")


@router.get("/status")
def camera_status(request: APIRequest, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.camera_service.status.snapshot(request.app.state.network)


@router.post("/discovery")
def discover(request: APIRequest, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.camera_service.request("POST", "/v1/discovery", {}, timeout=45)


@router.put("/{camera_id}/connection")
def connect_camera(camera_id: str, body: CameraConnection, request: APIRequest, response: Response):
    from .cloud_api import cloud_bridge
    if body.device_id:
        bridge = cloud_bridge(request, "sharing")
        with bridge.lock:
            if bridge.device(body.device_id).category not in {"sp", "dghsxj"}:
                raise HTTPException(409, "Select a camera from the Smart Life inventory")
    response.headers["Cache-Control"] = "no-store"
    value = body.model_dump()
    value["device_id"] = body.device_id or "local-camera:" + camera_id
    value["password"] = body.password.get_secret_value()
    return request.app.state.camera_service.request("PUT", "/v1/cameras/" + quote(camera_id, safe="") + "/connection", value, timeout=35)


@router.delete("/{camera_id}/connection")
def disconnect_camera(camera_id: str, request: APIRequest):
    return request.app.state.camera_service.request("DELETE", "/v1/cameras/" + quote(camera_id, safe="") + "/connection")


class CameraCommand(Schema):
    code: str = Field(min_length=1, max_length=64)
    value: bool | int | str


class CameraMove(Schema):
    direction: str = Field(pattern="^(up|right|down|left)$")


class CameraRoom(Schema):
    room_id: int | None = Field(ge=1)


@router.put("/{camera_id}/room")
def camera_room(camera_id: str, body: CameraRoom, request: APIRequest, response: Response, session: Session = Depends(get_session)):
    from .models import Room
    if body.room_id is not None and session.get(Room, body.room_id) is None:
        raise HTTPException(404, "Room not found")
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.camera_service.request("PUT", "/v1/cameras/" + quote(camera_id, safe="") + "/room", body.model_dump())


def control_request(camera_id, request, response, method="GET", action="", body=None):
    response.headers["Cache-Control"] = "no-store"
    service = request.app.state.camera_service
    result = service.request(method, "/v1/cameras/" + quote(camera_id, safe="") + "/controls" + action, body, timeout=25)
    service.status.update(camera_id, result)
    return result


@router.get("/{camera_id}/controls")
def camera_controls(camera_id: str, request: APIRequest, response: Response):
    return control_request(camera_id, request, response)


@router.post("/{camera_id}/controls/activate")
def camera_activate(camera_id: str, request: APIRequest, response: Response):
    # Saved credentials are reused; no cloud login, re-pairing or key rotation.
    return control_request(camera_id, request, response)


@router.post("/{camera_id}/controls/commands")
def camera_command(camera_id: str, body: CameraCommand, request: APIRequest, response: Response):
    return control_request(camera_id, request, response, "POST", "/commands", body.model_dump())


@router.post("/{camera_id}/controls/move")
def camera_move(camera_id: str, body: CameraMove, request: APIRequest, response: Response):
    return control_request(camera_id, request, response, "POST", "/move", body.model_dump())


@router.post("/{camera_id}/controls/stop")
def camera_stop(camera_id: str, request: APIRequest, response: Response):
    return control_request(camera_id, request, response, "POST", "/stop", {})


@router.post("/{camera_id}/controls/siren")
def camera_siren(camera_id: str, request: APIRequest, response: Response):
    return control_request(camera_id, request, response, "POST", "/siren", {})


@router.post("/{camera_id}/playback")
def local_camera_playback(camera_id: str, request: APIRequest, response: Response):
    service = request.app.state.camera_service
    row = next((r for r in service.request("GET", "/v1/cameras") if r["id"] == camera_id and r.get("connected")), None)
    if not row:
        raise HTTPException(404, "Connected camera not found")
    # The owner manages native cameras independently of cloud availability.
    # Respect an already-known privacy state without initializing a cloud session.
    if row.get("controls_available"):
        controls = service.request("GET", "/v1/cameras/" + quote(camera_id, safe="") + "/controls", timeout=12)
        service.status.update(camera_id, controls)
        privacy = controls.get("state", {}).get("basic_private")
        if privacy is not False:
            raise HTTPException(409, "Camera privacy mode is enabled" if privacy is True else "Camera privacy state is unknown")
    else:
        bridge = request.app.state.cloud
        with bridge.lock:
            manager = bridge.manager
            device = manager.device_map.get(row["device_id"]) if manager is not None else None
            if device is not None and getattr(device, "status", {}).get("basic_private") is True:
                raise HTTPException(409, "Camera privacy mode is enabled")
    scope = service.scope("local", "owner", service, lambda: not service.stop.is_set())
    result = service.request("POST", "/v1/playbacks/local", {"device_id": row["device_id"], "scope": scope})
    service.validate_playback(result, row["device_id"])
    response.headers["Cache-Control"] = "no-store"
    return {**result, "device_id": "local-camera:" + camera_id}
