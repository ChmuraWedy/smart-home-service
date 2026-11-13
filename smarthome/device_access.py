"""Owner-only device internet policies via a narrow host Unix socket."""
import http.client
import ipaddress
import json
import os
import socket
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import StrictBool
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import get_session, require_owner
from .models import Device
from .schemas import Schema
from .service import effective_capabilities

router = APIRouter(prefix="/api/v1/device-access", tags=["Device access"], dependencies=[Depends(require_owner)])
Route = Literal["local", "sharing", "developer", "native"]


class Internet(Schema):
    blocked: StrictBool


class HostConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(8)
        self.sock.connect(os.environ["SMART_HOME_DEVICE_NETWORK_SOCKET"])


def host_request(host, blocked=None):
    if not os.getenv("SMART_HOME_DEVICE_NETWORK_SOCKET"):
        raise HTTPException(503, "Device internet policy service is not configured")
    client = HostConnection("device-network", timeout=8)
    try:
        body = None if blocked is None else json.dumps({"blocked": blocked})
        client.request("GET" if blocked is None else "PUT", "/devices/" + host, body=body,
                       headers={"Content-Type": "application/json"})
        response = client.getresponse()
        if response.status != 200:
            raise HTTPException(409 if response.status == 404 else 503, "Device MAC policy is not configured or could not be verified")
        result = json.loads(response.read(4096))
        if not isinstance(result, dict) or type(result.get("blocked")) is not bool or result.get("verified") is not True:
            raise ValueError()
        return {"available": True, "blocked": result["blocked"], "verified": True, **({"mac": result["mac"]} if result.get("mac") else {})}
    except (OSError, ValueError, http.client.HTTPException):
        raise HTTPException(503, "Device internet policy could not be verified") from None
    finally:
        client.close()


def target(request, session, route, device_id):
    camera = None
    local = None
    reported_host = None
    if route == "native":
        camera = next((r for r in request.app.state.camera_service.request("GET", "/v1/cameras")
                       if r.get("id") == device_id and r.get("connected")), None)
        if not camera:
            raise HTTPException(404, "Connected device not found")
        local = session.scalar(select(Device).where(Device.device_id == camera.get("device_id")))
    elif route == "local":
        local = session.get(Device, int(device_id)) if device_id.isdecimal() else None
        if not local:
            raise HTTPException(404, "Device not found")
    else:
        from .cloud_api import cloud_bridge
        bridge = cloud_bridge(request, route)
        with bridge.lock:
            cloud = bridge.device(device_id)
            local = session.scalar(select(Device).where(Device.device_id == device_id))
            if getattr(cloud, "sub", False):
                return None, local, None
            reported_host = getattr(cloud, "ip", None)
        observed = request.app.state.network.observation(device_id, device_id, "direct", local.ip if local else None)
        reported_host = observed.get("observed_ip") or reported_host
        # A camera can have a standalone module binding without a DB record.
        if request.app.state.camera_service.url and getattr(cloud, "category", None) in {"sp", "dghsxj"}:
            camera = next((r for r in request.app.state.camera_service.request("GET", "/v1/cameras")
                           if r.get("device_id") == device_id and r.get("connected")), None)
    if local and (local.parent_id or local.is_gateway):
        return None, local, camera  # Never block a shared gateway as a child device.
    host = camera.get("host") if camera else local.ip if local else reported_host
    if not host:
        return None, None, None
    try:
        address = ipaddress.ip_address(host)
        if address.version != 4 or not any(address in ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
            raise ValueError()
    except ValueError:
        return None, None, None
    return str(address), local, camera


@router.get("/{route}/{device_id}")
def status(route: Route, device_id: str, request: Request, response: Response, session: Session = Depends(get_session)):
    host, local, camera = target(request, session, route, device_id)
    response.headers["Cache-Control"] = "no-store"
    internet = {"available": False, "blocked": None, "verified": False}
    if host:
        try:
            internet = host_request(host)
        except HTTPException:
            pass
    endpoint = session.get(Device, local.parent_id) if local and local.parent_id else local
    local_ready = bool(local and local.enabled and endpoint and endpoint.enabled and endpoint.ip
                       and endpoint.local_key and endpoint.version and effective_capabilities(session, local))
    return {"host": host, "mac": internet.get("mac") or (local.mac if local else None), "internet": internet,
            "local_available": bool(camera and camera.get("controls_available")) or local_ready,
            "control": "local" if route in {"local", "native"} else "remote"}


@router.put("/{route}/{device_id}/internet")
def internet(route: Route, device_id: str, body: Internet, request: Request, response: Response, session: Session = Depends(get_session)):
    host, _, _ = target(request, session, route, device_id)
    if not host:
        raise HTTPException(409, "This device has no separate configured LAN endpoint; a shared gateway cannot be blocked for one device")
    response.headers["Cache-Control"] = "no-store"
    return host_request(host, body.blocked)
