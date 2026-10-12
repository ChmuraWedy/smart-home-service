"""Find, verify and persist an authorized gateway without inferring its children."""

from ipaddress import IPv4Address, ip_address, ip_network
from time import monotonic, sleep
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field, ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .cloud_api import Provider, cloud_bridge
from .cloud_mappings import scope_for
from .device_aliases import aliases_for_devices
from .gateway_keys import GATEWAY_CATEGORIES, candidates, discover, validate_target
from .models import Device
from .network_discovery import network_interfaces
from .schemas import DeviceCreate, DevicePatch, DeviceRead, Identifier, Schema
from .service import commit, create_device, device_read, patch_device
from .topology import cached

router = APIRouter(
    prefix="/api/v1/gateways", tags=["Gateways"], dependencies=[Depends(authenticate)]
)


class GatewaySetup(Schema):
    device_id: Identifier
    provider: Provider
    interface_address: IPv4Address
    discovery_seconds: int = Field(default=8, ge=3, le=12, strict=True)


class GatewaySetupResult(Schema):
    action: Literal["created", "updated", "unchanged"]
    device: DeviceRead
    verified: Literal[True] = True
    key_source: Literal["device", "child"]
    interface_address: IPv4Address


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


def setup_gateway(body, session, bridge, controller, monitor, probe_lock):
    """Synchronous, explicit setup. Only verified connection fields are updated on retry."""
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
        # Release the read transaction during discovery and hardware I/O.
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
            if scope_for(bridge, body.provider) != scope:
                raise HTTPException(409, "Аккаунт изменился. Повторите настройку шлюза.")
            authorized_gateway(bridge, body.device_id)
            key = verified.local_key.get_secret_value()
            if (source, key) not in candidates(bridge.devices(), body.device_id):
                raise HTTPException(409, "Ключ в Tuya изменился. Повторите проверку шлюза.")
            if selected_interface(body.interface_address) != interface:
                raise HTTPException(409, "Выбранная сеть изменилась. Повторите поиск.")
            # Serialize the short comparison/write transaction with other inventory writers.
            session.execute(text("BEGIN IMMEDIATE"))
            item = session.scalar(select(Device).where(Device.device_id == body.device_id))
            if fingerprint(item) != before:
                raise HTTPException(409, "Запись устройства изменилась. Повторите настройку.")
            validate_existing(item)
            if item:
                delta = {
                    field: value
                    for field, value in {
                        "ip": address,
                        "version": verified.version,
                        "local_key": key,
                    }.items()
                    if getattr(item, field) != value
                }
                action = "updated" if delta else "unchanged"
                if delta:
                    patch_device(session, item, DevicePatch.model_validate(delta))
            else:
                placement = next(
                    (
                        row
                        for row in cached(session, scope)["placements"]
                        if row["device_id"] == body.device_id
                    ),
                    {},
                )
                item = create_device(
                    session,
                    DeviceCreate.model_validate(
                        {
                            **verified.model_dump(),
                            "aliases": aliases_for_devices(session, scope, [body.device_id])[
                                body.device_id
                            ],
                            "building_id": placement.get("building_id"),
                            "room_id": placement.get("room_id"),
                        }
                    ),
                )
                action = "created"
            commit(session)
            return GatewaySetupResult(
                action=action,
                device=device_read(session, item),
                key_source="device" if source == body.device_id else "child",
                interface_address=body.interface_address,
            )
    except Exception:
        session.rollback()
        raise
    finally:
        probe_lock.release()


@router.post(
    "/setup",
    response_model=GatewaySetupResult,
    responses={201: {"model": GatewaySetupResult, "description": "Verified gateway created"}},
)
def setup(
    body: GatewaySetup,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    response.headers["Cache-Control"] = "no-store"
    result = setup_gateway(
        body,
        session,
        cloud_bridge(request, body.provider),
        request.app.state.controller,
        request.app.state.network,
        request.app.state.observations.gateway_probe_lock,
    )
    response.status_code = 201 if result.action == "created" else 200
    return result
