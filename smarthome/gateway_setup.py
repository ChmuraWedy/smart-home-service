"""Find/preview an authorized gateway, then persist only explicit confirmation."""

import threading
from dataclasses import dataclass, field
from ipaddress import IPv4Address, ip_address, ip_network
from time import monotonic, sleep
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field, ValidationError, field_validator
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .cloud_api import Provider, cloud_bridge
from .cloud_mappings import scope_for
from .device_aliases import aliases_for_devices
from .gateway_keys import GATEWAY_CATEGORIES, candidates, discover, validate_target
from .models import Device
from .network_discovery import network_interfaces
from .schemas import (
    DeviceCreate,
    DevicePatch,
    DeviceRead,
    Identifier,
    Name,
    PositiveID,
    Schema,
    Version,
)
from .service import commit, create_device, device_read, device_values, patch_device
from .topology import cached

router = APIRouter(
    prefix="/api/v1/gateways", tags=["Gateways"], dependencies=[Depends(authenticate)]
)


FINDING_TTL = 300


class GatewayFind(Schema):
    device_id: Identifier
    provider: Provider
    interface_address: IPv4Address
    discovery_seconds: int = Field(default=8, ge=3, le=12, strict=True)


class GatewaySaveResult(Schema):
    action: Literal["created", "updated", "unchanged"]
    device: DeviceRead
    verified: Literal[True] = True
    key_source: Literal["device", "child"]
    interface_address: IPv4Address


class GatewayPreview(Schema):
    device_id: Identifier
    existing_id: PositiveID | None
    name: Name
    aliases: list[str]
    building_id: PositiveID | None
    room_id: PositiveID | None
    ip: IPv4Address
    version: Version
    changed_fields: list[Literal["ip", "version", "local_key"]]


class GatewayFindResult(Schema):
    finding_id: str
    expires_in: int
    action: Literal["created", "updated", "unchanged"]
    device: GatewayPreview
    verified: Literal[True] = True
    key_source: Literal["device", "child"]
    interface_address: IPv4Address


class GatewaySave(Schema):
    finding_id: str = Field(min_length=32, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit confirmation is required")
        return value


@dataclass(repr=False)
class Finding:
    proposed: DeviceCreate
    provider: Provider
    scope: str
    source: str
    interface: dict
    before: tuple | None
    preview: GatewayPreview
    action: str
    expires: float
    lock: threading.Lock = field(default_factory=threading.Lock)


def selected_interface(address):
    interface = next((row for row in network_interfaces() if row["address"] == str(address)), None)
    if interface is None:
        raise HTTPException(409, "Выбранная сеть больше недоступна. Обновите список сетей.")
    return interface


def authorized_gateway(bridge, identifier):
    device = bridge.device(identifier)
    if device.id != identifier or getattr(device, "category", None) not in GATEWAY_CATEGORIES:
        raise HTTPException(422, "Выбранное устройство не подтверждено как шлюз в Tuya.")
    return device


def fingerprint(item):
    return (item.id, item.updated_at) if item else None


def validate_existing(item):
    if item and (
        not item.is_gateway
        or item.transport != "wifi"
        or item.parent_id
        or item.cid
        or not item.enabled
    ):
        raise HTTPException(409, "Существующая запись отключена или не является локальным шлюзом.")


def find_address(monitor, interface, identifier, seconds):
    """Observe a full bounded window; changes/duplicate identities are not IP guesses."""
    scan_id = monitor.start_scan(interface)["scan_id"]
    try:
        ready_by = monotonic() + 2
        while True:
            snapshot = monitor.read_scan(scan_id)
            if 7000 in snapshot["ports"]:
                break
            if 7000 in snapshot["failed_ports"] or monotonic() >= ready_by:
                raise HTTPException(503, "Приём объявлений Tuya недоступен. Проверьте порт 7000.")
            sleep(0.1)
        monitor.request_announcements(scan_id)
        deadline = monotonic() + seconds
        while monotonic() < deadline:
            sleep(min(0.2, max(0, deadline - monotonic())))
            snapshot = monitor.read_scan(scan_id)
        matches = [row for row in snapshot["devices"] if row.get("device_id") == identifier]
        if not matches:
            raise HTTPException(404, "Шлюз не найден в выбранной сети. Проверьте сеть и питание.")
        if len(matches) != 1 or matches[0].get("changes"):
            raise HTTPException(409, "Адрес шлюза неоднозначен или изменился. Повторите поиск.")
        row = matches[0]
        network = ip_network(interface["network"])
        address = ip_address(row["ip"])
        if address not in network or address in (
            network.network_address,
            network.broadcast_address,
            ip_address(interface["address"]),
        ):
            raise HTTPException(409, "Объявление шлюза не соответствует выбранной сети.")
        return row["ip"], row.get("version")
    finally:
        monitor.remove_scan(scan_id)


def connection_delta(item, proposed):
    return {
        name: value
        for name, value in {
            "ip": str(proposed.ip),
            "version": proposed.version,
            "local_key": proposed.local_key.get_secret_value(),
        }.items()
        if item is None or getattr(item, name) != value
    }


def proposal(session, scope, verified, item):
    if item:
        updates = {
            "name": item.name,
            "aliases": [row.alias for row in item.alias_entries],
            "building_id": item.building_id,
            "room_id": item.room_id,
        }
    else:
        placement = next(
            (
                row
                for row in cached(session, scope)["placements"]
                if row["device_id"] == verified.device_id
            ),
            {},
        )
        updates = {
            "aliases": aliases_for_devices(session, scope, [verified.device_id])[
                verified.device_id
            ],
            "building_id": placement.get("building_id"),
            "room_id": placement.get("room_id"),
        }
    return DeviceCreate.model_validate({**verified.model_dump(), **updates})


def check_finding(bridge, entry):
    if scope_for(bridge, entry.provider) != entry.scope:
        raise HTTPException(409, "Аккаунт изменился. Повторите поиск шлюза.")
    gateway = authorized_gateway(bridge, entry.proposed.device_id)
    key = entry.proposed.local_key.get_secret_value()
    if (entry.source, key) not in candidates(bridge.devices(), entry.proposed.device_id):
        raise HTTPException(409, "Ключ в Tuya изменился. Повторите поиск шлюза.")
    if selected_interface(entry.interface["address"]) != entry.interface:
        raise HTTPException(409, "Выбранная сеть изменилась. Повторите поиск.")
    return gateway


def find_gateway(body, session, bridge, controller, monitor, probe_lock, store):
    """Find and verify, retaining a short-lived proposal in server memory only."""
    if not probe_lock.acquire(blocking=False):
        raise HTTPException(409, "Проверка другого шлюза ещё выполняется. Дождитесь её завершения.")
    try:
        interface = selected_interface(body.interface_address)
        with bridge.lock:
            scope = scope_for(bridge, body.provider)
            gateway = authorized_gateway(bridge, body.device_id)
            pool = candidates(bridge.devices(), body.device_id)
            if not pool:
                raise HTTPException(409, "Tuya не передала подходящих ключей для проверки шлюза.")
            metadata = {
                "name": getattr(gateway, "name", None),
                "product_id": getattr(gateway, "product_id", None),
                "category": gateway.category,
            }
        existing = session.scalar(select(Device).where(Device.device_id == body.device_id))
        validate_existing(existing)
        before = fingerprint(existing)
        session.rollback()
        address, version = find_address(monitor, interface, body.device_id, body.discovery_seconds)
        try:
            draft = DeviceCreate.model_validate(
                {
                    **metadata,
                    "device_id": body.device_id,
                    "is_gateway": True,
                    "ip": address,
                    "version": version,
                }
            )
        except ValidationError:
            raise HTTPException(502, "Tuya вернула некорректные метаданные шлюза.") from None
        validate_target(draft)
        if selected_interface(body.interface_address) != interface:
            raise HTTPException(409, "Выбранная сеть изменилась. Повторите поиск.")
        verified, source = discover(controller, draft, pool)
        with bridge.lock:
            item = session.scalar(select(Device).where(Device.device_id == body.device_id))
            if fingerprint(item) != before:
                raise HTTPException(409, "Запись устройства изменилась. Повторите поиск.")
            validate_existing(item)
            proposed = proposal(session, scope, verified, item)
            delta = connection_delta(item, proposed)
            action = "created" if item is None else "updated" if delta else "unchanged"
            preview = GatewayPreview(
                **proposed.model_dump(
                    include={
                        "device_id",
                        "name",
                        "aliases",
                        "building_id",
                        "room_id",
                        "ip",
                        "version",
                    }
                ),
                existing_id=item.id if item else None,
                changed_fields=list(delta),
            )
            entry = Finding(
                proposed,
                body.provider,
                scope,
                source,
                interface,
                before,
                preview,
                action,
                store.clock() + FINDING_TTL,
            )
            check_finding(bridge, entry)
            token = store.add(entry)
            session.rollback()
            return GatewayFindResult(
                finding_id=token,
                expires_in=max(0, int(entry.expires - store.clock())),
                action=action,
                device=preview,
                key_source="device" if source == body.device_id else "child",
                interface_address=body.interface_address,
            )
    finally:
        session.rollback()
        probe_lock.release()


def save_gateway(body, session, bridge_for, controller, probe_lock, store):
    """Only this explicit confirmation path may change the SQLite inventory."""
    if not probe_lock.acquire(blocking=False):
        raise HTTPException(409, "Проверка другого шлюза ещё выполняется. Дождитесь её завершения.")
    try:
        with store.use(body.finding_id) as entry:
            bridge = bridge_for(entry.provider)
            with bridge.lock:
                check_finding(bridge, entry)
            values = device_values(entry.proposed)
            target = Device(**{key: value for key, value in values.items() if key != "aliases"})
            if not controller.verify_gateway_key(target):
                raise HTTPException(
                    409, "Шлюз больше не подтверждает подключение. Повторите поиск."
                )
            with bridge.lock:
                gateway = check_finding(bridge, entry)
                if entry.expires <= store.clock():
                    raise HTTPException(404, "Результат поиска истёк. Найдите шлюз снова.")
                session.execute(text("BEGIN IMMEDIATE"))
                if entry.expires <= store.clock():
                    raise HTTPException(404, "Результат поиска истёк. Найдите шлюз снова.")
                item = session.scalar(
                    select(Device).where(Device.device_id == entry.proposed.device_id)
                )
                if fingerprint(item) != entry.before:
                    raise HTTPException(409, "Запись устройства изменилась. Повторите поиск.")
                validate_existing(item)
                if item:
                    delta = connection_delta(item, entry.proposed)
                    if delta:
                        patch_device(session, item, DevicePatch.model_validate(delta))
                else:
                    current = proposal(session, entry.scope, entry.proposed, None)
                    fields = ("name", "product_id", "category")
                    if (
                        any(getattr(gateway, key, None) != getattr(current, key) for key in fields)
                        or current != entry.proposed
                    ):
                        raise HTTPException(
                            409, "Данные предварительного просмотра изменились. Повторите поиск."
                        )
                    item = create_device(session, entry.proposed)
                commit(session)
                result = GatewaySaveResult(
                    action=entry.action,
                    device=device_read(session, item),
                    key_source="device" if entry.source == entry.proposed.device_id else "child",
                    interface_address=entry.interface["address"],
                )
                store.remove(body.finding_id)
                return result
    except Exception:
        session.rollback()
        raise
    finally:
        probe_lock.release()


@router.post("/find", response_model=GatewayFindResult)
def find(
    body: GatewayFind, request: Request, response: Response, session: Session = Depends(get_session)
):
    response.headers["Cache-Control"] = "no-store"
    return find_gateway(
        body,
        session,
        cloud_bridge(request, body.provider),
        request.app.state.controller,
        request.app.state.network,
        request.app.state.observations.gateway_probe_lock,
        request.app.state.gateway_findings,
    )


@router.post(
    "/save",
    response_model=GatewaySaveResult,
    responses={201: {"model": GatewaySaveResult, "description": "Verified gateway created"}},
)
def save(
    body: GatewaySave, request: Request, response: Response, session: Session = Depends(get_session)
):
    response.headers["Cache-Control"] = "no-store"
    result = save_gateway(
        body,
        session,
        lambda provider: cloud_bridge(request, provider),
        request.app.state.controller,
        request.app.state.observations.gateway_probe_lock,
        request.app.state.gateway_findings,
    )
    response.status_code = 201 if result.action == "created" else 200
    return result
