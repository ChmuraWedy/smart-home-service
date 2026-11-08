"""Allocate a provider camera stream and issue a relay playback ticket."""

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .api_dependencies import authenticate
from .camera_hls import RelayError, stream_url
from .camera_playback import playback_connection
from .cloud_api import Provider, cloud_bridge
from .cloud_scope import scope_for
from .schemas import Identifier

router = APIRouter(prefix="/api/v1/cloud", tags=["Camera"], dependencies=[Depends(authenticate)])
CAMERA_CATEGORIES = {"sp", "dghsxj"}


def allocate_camera_stream(device_id, request, response, provider, relay):
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        device = bridge.device(device_id)
        if getattr(device, "category", None) not in CAMERA_CATEGORIES:
            raise HTTPException(409, "Устройство не определено Tuya как камера.")
        try:
            if provider == "sharing":
                url = bridge._manager().get_device_stream_allocate(device_id, "hls")
            else:
                result = bridge._client().request(
                    "POST", "/v1.0/devices/" + quote(device_id, safe="") + "/stream/actions/allocate",
                    body={"type": "hls"},
                )
                url = result.get("url") if isinstance(result, dict) else None
        except Exception:
            raise HTTPException(502, "Tuya не выдала видеопоток. Проверьте связь камеры и доступ к видео у выбранного подключения.") from None
        try:
            stream_url(url)
        except RelayError:
            raise HTTPException(502, "Tuya не предоставила доступный HTTPS-видеопоток этой камеры.") from None
        if relay:
            url = request.app.state.camera_playback.create(
                provider, scope_for(bridge, provider), playback_connection(bridge, provider), url,
            )
        response.headers["Cache-Control"] = "no-store"
        return {"device_id": device_id, "type": "hls", "url": url}


@router.post("/devices/{device_id}/stream", deprecated=True)
def camera_stream(device_id: Identifier, request: Request, response: Response, provider: Provider = "sharing"):
    return allocate_camera_stream(device_id, request, response, provider, relay=False)


@router.post("/devices/{device_id}/stream/relay")
def camera_relay(device_id: Identifier, request: Request, response: Response, provider: Provider = "sharing"):
    return allocate_camera_stream(device_id, request, response, provider, relay=True)
