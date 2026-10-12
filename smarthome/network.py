"""Bounded LAN observations shared by device cards and the network page."""

import copy
import json
import re
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
from pydantic import BaseModel, ConfigDict, IPvAnyAddress
from sqlalchemy import select as sql_select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .cloud_api import cloud_bridge
from .gateway_keys import GATEWAY_CATEGORIES
from .models import Device
from .network_discovery import (
    MAX_DEVICES,
    MAX_EVENTS,
    MULTICAST,
    mdns,
    neighbors,
    network_interfaces,
    private_ip,
    request_tuya_announcements,
    ssdp,
)
from .schemas import Identifier

PORTS = (6666, 6667, 7000)
LEASE_SECONDS = 15
MAX_SECONDS = 900
PRIVATE_NETWORKS = tuple(
    ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
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
        if not isinstance(identifier, str) or not re.fullmatch(
            r"[a-zA-Z0-9_.:-]{1,128}", identifier
        ):
            return None
        version = payload.get("version")
        return (
            identifier,
            str(address),
            version if version in ("3.1", "3.2", "3.3", "3.4", "3.5") else None,
        )
    except Exception:
        return None


class NetworkMonitor:
    def __init__(self):
        self.lock = threading.RLock()
        self.watches = {}
        self.scans = {}
        self.last_discovery_request = None
        self.thread = None
        self.closed = False
        self.ports = []
        self.failed_ports = []

    def start(self, device_id, target_id, route, configured_ip):
        with self.lock:
            self._expire()
            if self.closed or len(self.watches) + len(self.scans) >= 32:
                raise HTTPException(503, "Network listener is unavailable or busy")
            now = time.monotonic()
            watch_id = uuid.uuid4().hex
            self.watches[watch_id] = {
                "device_id": device_id,
                "target_id": target_id,
                "route": route,
                "configured_ip": configured_ip,
                "observed_ip": None,
                "version": None,
                "last_seen": None,
                "packets": 0,
                "changes": [],
                "expires": now + LEASE_SECONDS,
                "deadline": now + MAX_SECONDS,
            }
            if not self.thread or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._listen, daemon=True)
                self.thread.start()
            return {"watch_id": watch_id, **self._snapshot(self.watches[watch_id])}

    def start_scan(self, interface=None):
        with self.lock:
            self._expire()
            if self.closed or len(self.scans) >= 4 or len(self.scans) + len(self.watches) >= 32:
                raise HTTPException(
                    503, "Слишком много наблюдений за сетью. Закройте предыдущую страницу."
                )
            now = time.monotonic()
            scan_id = uuid.uuid4().hex
            self.scans[scan_id] = {
                "interface": copy.deepcopy(interface),
                "devices": {},
                "events": [],
                "packets": 0,
                "recognized_packets": 0,
                "neighbors_available": None,
                "discovery_requests": 0,
                "truncated": False,
                "expires": now + LEASE_SECONDS,
                "deadline": now + MAX_SECONDS,
            }
            if not self.thread or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._listen, daemon=True)
                self.thread.start()
            return self.read_scan(scan_id)

    def _scan(self, scan_id):
        with self.lock:
            self._expire()
            row = self.scans.get(scan_id)
            if row is None:
                raise HTTPException(404, "Наблюдение за сетью завершено. Можно запустить снова.")
            return row

    def read_scan(self, scan_id):
        with self.lock:
            row = self._scan(scan_id)
            row["expires"] = time.monotonic() + LEASE_SECONDS
            result = {
                "scan_id": scan_id,
                "interface": row["interface"],
                "devices": list(row["devices"].values()),
                "events": row["events"],
                **{
                    key: row[key]
                    for key in (
                        "packets",
                        "recognized_packets",
                        "neighbors_available",
                        "discovery_requests",
                        "truncated",
                    )
                },
                "listening": bool(self.ports),
                "ports": list(self.ports),
                "failed_ports": list(self.failed_ports),
                "remaining_seconds": max(0, int(row["deadline"] - time.monotonic())),
            }
            return copy.deepcopy(result)

    def remove_scan(self, scan_id):
        with self.lock:
            self.scans.pop(scan_id, None)

    def request_announcements(self, scan_id):
        with self.lock:
            self.read_scan(scan_id)
            now = time.monotonic()
            if 7000 not in self.ports:
                raise HTTPException(409, "Приём Tuya 7000 ещё не готов или порт занят.")
            if self.last_discovery_request is not None and now - self.last_discovery_request < 10:
                raise HTTPException(429, "Повторить запрос объявлений можно через 10 секунд.")
            self.last_discovery_request = now
            interface = copy.deepcopy(self.scans[scan_id]["interface"])
        sent = request_tuya_announcements(interface) if interface else request_tuya_announcements()
        if not sent:
            raise HTTPException(503, "Не удалось отправить запрос объявлений в домашнюю сеть.")
        with self.lock:
            self.read_scan(scan_id)
            self.scans[scan_id]["discovery_requests"] += 1
            return self.read_scan(scan_id)

    def _expire(self):
        now = time.monotonic()
        self.watches = {
            key: row
            for key, row in self.watches.items()
            if min(row["expires"], row["deadline"]) > now
        }

        self.scans = {
            key: row
            for key, row in self.scans.items()
            if min(row["expires"], row["deadline"]) > now
        }

    def _snapshot(self, row):
        return {
            **{key: value for key, value in row.items() if key not in ("expires", "deadline")},
            "listening": bool(self.ports),
            "ports": list(self.ports),
            "failed_ports": list(self.failed_ports),
            "remaining_seconds": max(0, int(row["deadline"] - time.monotonic())),
        }

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

    def _record(self, scan, key, address, protocol, now=None, **updates):
        devices = scan["devices"]
        # Merge protocol announcements only when exactly one Tuya identity has
        # been observed at this IP. Neighbor addresses alone never identify Tuya.
        if key.startswith("ip:"):
            matches = [
                item
                for item, row in devices.items()
                if row.get("device_id") and row["ip"] == address
            ]
            if len(matches) == 1:
                key = matches[0]
        if key not in devices and len(devices) >= MAX_DEVICES:
            if not key.startswith("tuya:") or "ip:" + address not in devices:
                scan["truncated"] = True
                return
        row = devices.setdefault(
            key,
            {
                "ip": address,
                "device_id": None,
                "version": None,
                "hostname": None,
                "mac": None,
                "protocols": [],
                "services": [],
                "packets": 0,
                "first_seen": None,
                "last_seen": None,
                "changes": [],
            },
        )
        if row["ip"] != address:
            row["changes"].append({"at": now, "previous_ip": row["ip"], "ip": address})
            row["changes"] = row["changes"][-20:]
            row["mac"], row["hostname"] = None, None
            row["services"], row["protocols"] = [], []
        if key.startswith("tuya:"):
            other = devices.pop("ip:" + address, None)
            if other:
                row["services"] = sorted(set(row["services"] + other["services"]))[:32]
                row["protocols"] = sorted(set(row["protocols"] + other["protocols"]))
                row["mac"], row["hostname"] = other["mac"], other["hostname"]
                row["packets"] += other["packets"]
                row["first_seen"] = row["first_seen"] or other["first_seen"]
        row["ip"] = address
        row["protocols"] = sorted(set(row["protocols"] + [protocol]))
        row["services"] = sorted(set(row["services"] + updates.pop("services", [])))[:32]
        row.update({field: value for field, value in updates.items() if value is not None})
        if now:
            row["first_seen"] = row["first_seen"] or now
            row["last_seen"] = now
            row["packets"] += 1

    def ingest(self, data, source_ip, port=6667):
        if not private_ip(source_ip) or len(data) > 16384:
            return
        decoded = discovery(data, source_ip) if port in PORTS else None
        details = mdns(data, source_ip) if port == 5353 else ssdp(data) if port == 1900 else None
        now = datetime.now(timezone.utc).isoformat()
        with self.lock:
            self._expire()
            if decoded:
                identifier, address, version = decoded
                for row in self.watches.values():
                    if identifier != row["target_id"]:
                        continue
                    if row["observed_ip"] != address:
                        row["changes"].append(
                            {"at": now, "previous_ip": row["observed_ip"], "ip": address}
                        )
                        row["changes"] = row["changes"][-20:]
                    row.update(
                        observed_ip=address,
                        version=version,
                        last_seen=now,
                        packets=row["packets"] + 1,
                    )
            for scan in self.scans.values():
                if scan["interface"] and ip_address(source_ip) not in ip_network(
                    scan["interface"]["network"]
                ):
                    continue
                scan["packets"] += 1
                protocol = (
                    "tuya"
                    if decoded
                    else "mdns"
                    if port == 5353 and details
                    else "ssdp"
                    if details
                    else "unknown"
                )
                scan["events"].append(
                    {
                        "at": now,
                        "ip": source_ip,
                        "port": port,
                        "protocol": protocol,
                        "device_id": decoded[0] if decoded else None,
                    }
                )
                scan["events"] = scan["events"][-MAX_EVENTS:]
                if decoded:
                    scan["recognized_packets"] += 1
                    self._record(
                        scan,
                        "tuya:" + identifier,
                        address,
                        "tuya",
                        now,
                        device_id=identifier,
                        version=version,
                    )
                elif details:
                    scan["recognized_packets"] += 1
                    self._record(scan, "ip:" + source_ip, source_ip, protocol, now, **details)

    def ingest_neighbors(self, rows, available):
        with self.lock:
            self._expire()
            for scan in self.scans.values():
                scan["neighbors_available"] = available
                for row in rows[:MAX_DEVICES]:
                    if scan["interface"] and ip_address(row["ip"]) not in ip_network(
                        scan["interface"]["network"]
                    ):
                        continue
                    self._record(scan, "ip:" + row["ip"], row["ip"], "arp", mac=row["mac"])

    def _listen(self):
        listeners, attempted, neighbor_at = {}, set(), 0
        memberships = {}
        try:
            while True:
                with self.lock:
                    self._expire()
                    if self.closed:
                        break
                    wanted = set(PORTS) if self.watches or self.scans else set()
                    if self.scans:
                        wanted.update(MULTICAST)
                    for port in list(listeners):
                        if port not in wanted:
                            listeners.pop(port).close()
                            memberships.pop(port, None)
                    attempted.intersection_update(wanted)
                    self.failed_ports = [port for port in self.failed_ports if port in wanted]
                    for port in sorted(wanted - attempted):
                        attempted.add(port)
                        listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                        try:
                            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                            if port in MULTICAST and hasattr(socket, "SO_REUSEPORT"):
                                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
                            listener.bind(("", port))
                            listeners[port] = listener
                        except OSError:
                            listener.close()
                            self.failed_ports.append(port)
                    addresses = {
                        scan["interface"]["address"] if scan["interface"] else "0.0.0.0"
                        for scan in self.scans.values()
                    }
                    for port in MULTICAST:
                        if port not in listeners:
                            continue
                        joined = memberships.setdefault(port, set())
                        for address in joined - addresses:
                            group = socket.inet_aton(MULTICAST[port]) + socket.inet_aton(address)
                            try:
                                listeners[port].setsockopt(
                                    socket.IPPROTO_IP, socket.IP_DROP_MEMBERSHIP, group
                                )
                            except OSError:
                                pass
                        joined.intersection_update(addresses)
                        for address in addresses - joined:
                            group = socket.inet_aton(MULTICAST[port]) + socket.inet_aton(address)
                            try:
                                listeners[port].setsockopt(
                                    socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, group
                                )
                                joined.add(address)
                            except OSError:
                                if port not in self.failed_ports:
                                    self.failed_ports.append(port)
                    self.ports = sorted(listeners)
                    scan_active = bool(self.scans)
                if scan_active and time.monotonic() >= neighbor_at:
                    rows, available = neighbors()
                    self.ingest_neighbors(rows, available)
                    neighbor_at = time.monotonic() + 10
                if not listeners:
                    time.sleep(0.5)
                    continue
                ready, _, _ = select.select(list(listeners.values()), [], [], 0.5)
                for listener in ready:
                    data, peer = listener.recvfrom(65535)
                    port = next(port for port, value in listeners.items() if value is listener)
                    self.ingest(data, peer[0], port)
        except OSError:
            with self.lock:
                self.failed_ports = sorted(attempted)
        finally:
            with self.lock:
                for listener in listeners.values():
                    listener.close()
                self.ports = []

    def close(self):
        with self.lock:
            self.closed = True
            self.watches.clear()
            self.scans.clear()
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
        child = (
            bool(getattr(cloud, "sub", False))
            and getattr(cloud, "category", None) not in GATEWAY_CATEGORIES
        )
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
def start_watch(
    device_id: Identifier,
    request: Request,
    response: Response,
    provider: Literal["sharing", "developer", "local"] = "sharing",
    session: Session = Depends(get_session),
):
    target_id, route, configured_ip = resolve_target(session, request, device_id, provider)
    response.headers["Cache-Control"] = "no-store"
    if target_id is None:
        raise HTTPException(
            409, "Gateway is not known. Select the device's gateway in the local inventory first."
        )
    return request.app.state.network.start(device_id, target_id, route, configured_ip)


@router.get("/watches/{watch_id}")
def read_watch(watch_id: str, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.network.read(watch_id)


@router.delete("/watches/{watch_id}", status_code=204)
def stop_watch(watch_id: str, request: Request):
    request.app.state.network.remove(watch_id)
    return Response(status_code=204)


class StartNetworkScan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    interface_address: IPvAnyAddress


@router.get("/interfaces")
def list_interfaces(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return network_interfaces()


@router.post("/scans", status_code=201)
def start_scan(body: StartNetworkScan, request: Request, response: Response):
    interface = next(
        (row for row in network_interfaces() if row["address"] == str(body.interface_address)), None
    )
    if not interface:
        raise HTTPException(409, "Выбранная сеть больше недоступна. Обновите список сетей.")
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.network.start_scan(interface)


@router.get("/scans/{scan_id}")
def read_scan(scan_id: str, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.network.read_scan(scan_id)


@router.post("/scans/{scan_id}/discover")
def discover_scan(scan_id: str, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.network.request_announcements(scan_id)


@router.delete("/scans/{scan_id}", status_code=204)
def stop_scan(scan_id: str, request: Request):
    request.app.state.network.remove_scan(scan_id)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
