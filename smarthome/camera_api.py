"""On-demand camera URLs; cloud credentials and stream addresses are never persisted."""

from urllib.parse import quote, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .api_dependencies import authenticate
from .cloud_api import Provider, cloud_bridge
from .schemas import Identifier

router = APIRouter(prefix="/api/v1/cloud", tags=["Camera"], dependencies=[Depends(authenticate)])
CAMERA_CATEGORIES = {"sp", "dghsxj"}


def valid_stream_url(value):
    try:
        url = urlsplit(value)
        valid = (
            isinstance(value, str) and len(value) <= 8192
            and not any(c.isspace() or not c.isprintable() for c in value)
            and url.scheme == "https" and bool(url.hostname)
            and url.username is None and url.password is None and not url.fragment
        )
        _ = url.port
        return valid
    except (ValueError, TypeError, AttributeError):
        return False


@router.post("/devices/{device_id}/stream")
def camera_stream(device_id: Identifier, request: Request, response: Response, provider: Provider = "sharing"):
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
        if not valid_stream_url(url):
            raise HTTPException(502, "Tuya не предоставила доступный HTTPS-видеопоток этой камеры.")
        response.headers["Cache-Control"] = "no-store"
        return {"device_id": device_id, "type": "hls", "url": url}
