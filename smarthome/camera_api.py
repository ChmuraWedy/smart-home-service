"""Authorize a camera, then return a direct camera-module playback URL."""
from urllib.parse import quote
from weakref import ref

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .api_dependencies import authenticate
from .cloud_api import Provider, cloud_bridge
from .cloud_scope import scope_for
from .schemas import Identifier

router = APIRouter(prefix="/api/v1/cloud", tags=["Camera"], dependencies=[Depends(authenticate)])
CAMERA_CATEGORIES = {"sp", "dghsxj"}


def allocate_camera_stream(device_id, request, response, provider):
    bridge = cloud_bridge(request, provider)
    service = request.app.state.camera_service
    with bridge.lock:
        device = bridge.device(device_id)
        if getattr(device, "category", None) not in CAMERA_CATEGORIES:
            raise HTTPException(409, "This device is not a camera")
        if getattr(device, "status", {}).get("basic_private") is True:
            raise HTTPException(409, "Camera privacy mode is enabled")
        connection = bridge._client() if provider == "developer" else bridge._manager()
        account_scope = scope_for(bridge, provider)
        weak = ref(connection)

    def valid():
        with bridge.lock:
            current = bridge.client if provider == "developer" else bridge.manager
            return weak() is not None and current is weak() and scope_for(bridge, provider) == account_scope

    scope = service.scope(provider, account_scope, connection, valid)
    body = {"device_id": device_id, "scope": scope}
    result = service.request("POST", "/v1/playbacks/local", body, missing=True)
    if result is None:
        with bridge.lock:
            if not valid():
                raise HTTPException(409, "Camera connection changed; reconnect the video")
            try:
                if provider == "sharing":
                    url = connection.get_device_stream_allocate(device_id, "hls")
                else:
                    allocated = connection.request(
                        "POST", "/v1.0/devices/" + quote(device_id, safe="") + "/stream/actions/allocate",
                        body={"type": "hls"},
                    )
                    url = allocated.get("url") if isinstance(allocated, dict) else None
            except Exception:
                raise HTTPException(502, "Tuya could not allocate this camera stream") from None
        result = service.request("POST", "/v1/playbacks/hls", {**body, "url": url})
    response.headers["Cache-Control"] = "no-store"
    return service.validate_playback(result, device_id)


@router.post("/devices/{device_id}/stream", deprecated=True)
@router.post("/devices/{device_id}/stream/relay")
def camera_stream(device_id: Identifier, request: Request, response: Response, provider: Provider = "sharing"):
    return allocate_camera_stream(device_id, request, response, provider)
