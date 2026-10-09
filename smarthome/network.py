"""Card-scoped passive Tuya discovery; no probes, commands or raw packet storage."""

import json
import select
import socket
import threading
import time
import uuid
from datetime import datetime, timezone
from ipaddress import ip_address, ip_network
from typing import Literal

import tinytuya
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select as sql_select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .cloud_api import cloud_bridge
from .models import Device
from .schemas import Identifier

PORTS = (6666, 6667, 7000)
LEASE_SECONDS = 15
MAX_SECONDS = 900
PRIVATE_NETWORKS = tuple(ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
router = APIRouter(prefix="/api/v1/network", tags=["Network"], dependencies=[Depends(authenticate)])


def discovery(data, source_ip):
    try:
        address = ip_address(source_ip)
        if not any(address in network for network in PRIVATE_NETWORKS):
            return None
        payload = json.loads(tinytuya.decrypt_udp(data))
        if not isinstance(payload, dict):
            return None
        identifier = payload.get("gwId") or payload.get("devId")
        if not isinstance(identifier, str) or not 1 <= len(identifier) <= 128:
            return None
        version = payload.get("version")
        return identifier, str(address), version if version in ("3.1", "3.2", "3.3", "3.4", "3.5") else None
    except Exception:
        return None


class NetworkMonitor:
    def __init__(self):
        self.lock = threading.RLock()
        self.watches = {}
        self.thread = None
        self.closed = False
        self.ports = []
        self.failed_ports = []

    def start(self, device_id, target_id, route, configured_ip):
        with self.lock:
            self._expire()
            if self.closed or len(self.watches) >= 32:
                raise HTTPException(503, "Network listener is unavailable or busy")
            now = time.monotonic()
            watch_id = uuid.uuid4().hex
            self.watches[watch_id] = {
                "device_id": device_id, "target_id": target_id, "route": route,
                "configured_ip": configured_ip, "observed_ip": None, "version": None,
                "last_seen": None, "packets": 0, "changes": [],
                "expires": now + LEASE_SECONDS, "deadline": now + MAX_SECONDS,
            }
            if not self.thread or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._listen, daemon=True)
                self.thread.start()
            return {"watch_id": watch_id, **self._snapshot(self.watches[watch_id])}

    def _expire(self):
        now = time.monotonic()
        self.watches = {key: row for key, row in self.watches.items() if min(row["expires"], row["deadline"]) > now}

    def _snapshot(self, row):
        return {**{key: value for key, value in row.items() if key not in ("expires", "deadline")},
                "listening": bool(self.ports), "ports": list(self.ports),
                "failed_ports": list(self.failed_ports),
                "remaining_seconds": max(0, int(row["deadline"] - time.monotonic()))}

    def read(self, watch_id):
        with self.lock:
            self._expire()
            row = self.watches.get(watch_id)
            if row is None:
                raise HTTPException(404, "Network observation has ended")
            row["expires"] = time.monotonic() + LEASE_SECONDS
            return {"watch_id": watch_id, **self._snapshot(row)}

    def remove(self, watch_id):
        with self.lock:
            self.watches.pop(watch_id, None)

    def ingest(self, data, source_ip):
        decoded = discovery(data, source_ip)
        if decoded is None:
            return
        identifier, address, version = decoded
        with self.lock:
            self._expire()
            for row in self.watches.values():
                if identifier != row["target_id"]:
                    continue
                now = datetime.now(timezone.utc).isoformat()
                if row["observed_ip"] != address:
                    row["changes"].append({"at": now, "previous_ip": row["observed_ip"], "ip": address})
                    row["changes"] = row["changes"][-20:]
                row.update(observed_ip=address, version=version, last_seen=now, packets=row["packets"] + 1)

    def _listen(self):
        listeners = []
        attempted = False
        try:
            while True:
                with self.lock:
                    self._expire()
                    if self.closed:
                        break
                    active = bool(self.watches)
                    if not active:
                        for listener in listeners:
                            listener.close()
                        listeners = []
                        self.ports, self.failed_ports = [], []
                        attempted = False
                    elif not attempted:
                        attempted = True
                        self.ports, self.failed_ports = [], []
                        for port in PORTS:
                            listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                            try:
                                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                                listener.bind(("", port))
                                listeners.append(listener)
                                self.ports.append(port)
                            except OSError:
                                listener.close()
                                self.failed_ports.append(port)
                if not listeners:
                    time.sleep(0.5)
                    continue
                ready, _, _ = select.select(listeners, [], [], 0.5)
                for listener in ready:
                    data, peer = listener.recvfrom(65535)
                    self.ingest(data, peer[0])
        except OSError:
            with self.lock:
                self.failed_ports = list(PORTS)
        finally:
            with self.lock:
                for listener in listeners:
                    listener.close()
                self.ports = []

    def close(self):
        with self.lock:
            self.closed = True
            self.watches.clear()
            worker = self.thread
        if worker:
            worker.join(timeout=2)


def resolve_target(session, request, device_id, provider):
    local = session.scalar(sql_select(Device).where(Device.device_id == device_id))
    if provider == "local":
        if local is None:
            raise HTTPException(404, "Device not found")
        child = local.transport == "zigbee"
        gateway_id = None
    else:
        cloud = cloud_bridge(request, provider).device(device_id)
        child = bool(getattr(cloud, "sub", False))
        gateway_id = getattr(cloud, "gateway_id", None)
    if not child:
        return device_id, "direct", local.ip if local else None
    parent = session.get(Device, local.parent_id) if local and local.parent_id else None
    if parent:
        return parent.device_id, "gateway", parent.ip
    if isinstance(gateway_id, str) and gateway_id and gateway_id != device_id:
        gateway = session.scalar(sql_select(Device).where(Device.device_id == gateway_id))
        return gateway_id, "gateway", gateway.ip if gateway else None
    return None, "gateway_unknown", None


@router.post("/devices/{device_id}/watch")
def start_watch(device_id: Identifier, request: Request, response: Response,
                provider: Literal["sharing", "developer", "local"] = "sharing",
                session: Session = Depends(get_session)):
    target_id, route, configured_ip = resolve_target(session, request, device_id, provider)
    response.headers["Cache-Control"] = "no-store"
    if target_id is None:
        raise HTTPException(409, "Gateway is not known. Select the device's gateway in the local inventory first.")
    return request.app.state.network.start(device_id, target_id, route, configured_ip)


@router.get("/watches/{watch_id}")
def read_watch(watch_id: str, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.network.read(watch_id)


@router.delete("/watches/{watch_id}", status_code=204)
def stop_watch(watch_id: str, request: Request):
    request.app.state.network.remove(watch_id)
    return Response(status_code=204)
