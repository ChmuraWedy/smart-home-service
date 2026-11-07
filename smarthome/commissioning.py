"""Bounded, read-only observation sessions before a device enters the inventory."""

import json
import math
import re
import secrets
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field, SecretStr, ValidationError, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .auto_label_translations import translate_local_device
from .cloud_api import Provider, cloud_bridge, safe_spec
from .cloud_mappings import scope_for
from .gateway_keys import GATEWAY_CATEGORIES, candidates, discover, validate_target
from .local_lighting import color_capability
from .models import Device
from .schemas import Capability, DeviceCreate, DeviceRead, Name, PositiveID, Schema
from .service import (
    commit,
    create_device,
    device_read,
    device_values,
    effective_capabilities,
    get_or_404,
    record_observations,
    validate_device,
)

router = APIRouter(
    prefix="/api/v1/commissioning", tags=["Commissioning"], dependencies=[Depends(authenticate)]
)
TTL = 900
MAX_SESSIONS = 16
Action = Literal["observe", "power", "brightness", "temperature", "color", "sensor", "button"]
PRIVATE = {
    "key",
    "local_key",
    "access_token",
    "refresh_token",
    "access_secret",
    "user_code",
    "password",
}


class StartObservation(Schema):
    draft: DeviceCreate
    provider: Provider | None = None
    mode: Literal["local", "cloud"] = "local"
    discover_gateway_key: bool = False


class SampleObservation(Schema):
    action: Action = "observe"


class StartExistingObservation(Schema):
    provider: Provider | None = None


class RegisterObservation(Schema):
    name: Name
    aliases: list[Name] = Field(default_factory=list, max_length=32)
    building_id: PositiveID | None = None
    room_id: PositiveID | None = None
    reviewed: Literal[True]
    writable: list[str] = Field(default_factory=list, max_length=64)

    @field_validator("reviewed", mode="before")
    @classmethod
    def explicit_review(cls, value):
        if value is not True:
            raise ValueError("Explicit review is required")
        return value


@dataclass(repr=False)
class Observation:
    draft: DeviceCreate
    provider: Provider | None
    scope: str | None
    mode: str
    expires: float
    specs: dict = field(default_factory=dict)
    functions: set = field(default_factory=set)
    readings: dict = field(default_factory=dict)
    changes: list = field(default_factory=list)
    sample_count: int = 0
    last_poll: float | None = None
    last_cloud_refresh: float | None = None
    verified_key_source: str | None = None
    existing_id: int | None = None
    existing_context: tuple | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


class Observations:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.entries = {}
        self.lock = threading.Lock()
        self.gateway_probe_lock = threading.Lock()

    def prune(self):
        for token, entry in list(self.entries.items()):
            if entry.expires <= self.clock():
                del self.entries[token]

    def add(self, entry):
        with self.lock:
            self.prune()
            if len(self.entries) >= MAX_SESSIONS:
                raise HTTPException(429, "Слишком много открытых опросов. Закройте предыдущий.")
            token = secrets.token_urlsafe(24)
            self.entries[token] = entry
            return token

    @contextmanager
    def use(self, token):
        with self.lock:
            self.prune()
            entry = self.entries.get(token)
            if entry is None:
                raise HTTPException(404, "Опрос завершён или истёк. Начните новый.")
            if not entry.lock.acquire(blocking=False):
                raise HTTPException(409, "Предыдущий запрос опроса ещё выполняется.")
        try:
            yield entry
        finally:
            entry.lock.release()

    def remove(self, token):
        with self.lock:
            self.entries.pop(token, None)

    def clear(self):
        with self.lock:
            self.entries.clear()


def checked_scope(request, entry):
    if entry.provider is None:
        return None
    bridge = cloud_bridge(request, entry.provider)
    if scope_for(bridge, entry.provider) != entry.scope:
        raise HTTPException(409, "Аккаунт изменился. Начните новый опрос.")
    return bridge


def safe_value(value, key, depth=0, budget=None):
    """Do not return credential fields, even inside device-supplied JSON."""
    budget = [128, 4096] if budget is None else budget
    budget[0] -= 1
    if depth > 4 or budget[0] < 0 or budget[1] <= 0:
        return "[too deep]"
    if isinstance(value, str):
        if key and key in value:
            return "[hidden]"
        text = value[: min(2048, budget[1])]
        budget[1] -= len(text)
        return text
    if value is None or type(value) in (bool, int):
        return value
    if type(value) is float:
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {
            str(k)[:128]: safe_value(v, key, depth + 1, budget)
            for k, v in list(value.items())[:32]
            if str(k).lower() not in PRIVATE and not (key and key in str(k))
        }
    if isinstance(value, list):
        return [safe_value(v, key, depth + 1, budget) for v in value[:32]]
    return None


def definitions(device):
    specs, functions = {}, set()
    for writable, items in (
        (False, getattr(device, "status_range", {})),
        (True, getattr(device, "function", {})),
    ):
        for spec in items.values():
            row = safe_spec(device, spec)
            code = row.get("code")
            if (
                not isinstance(code, str)
                or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code)
                or code in PRIVATE
            ):
                continue
            raw = row.get("values")
            try:
                limits = json.loads(raw) if isinstance(raw, str) else raw
            except (ValueError, TypeError):
                limits = {}
            limits = limits if isinstance(limits, dict) else {}
            # Only public schema information is needed, never strategy/config blobs.
            row["values"] = safe_value(
                {
                    k: v
                    for k, v in limits.items()
                    if k in {"min", "max", "step", "scale", "unit", "range"}
                },
                getattr(device, "local_key", None),
            )
            specs[code] = row
            if writable:
                functions.add(code)
    return specs, functions


def view(store, token, entry):
    return {
        "session_id": token,
        "device_id": entry.draft.device_id,
        "mode": entry.mode,
        "expires_in": max(0, int(entry.expires - store.clock())),
        "interval_seconds": 3 if entry.mode == "local" else 5,
        "sample_count": entry.sample_count,
        "readings": list(entry.readings.values()),
        "changes": entry.changes,
        "has_local_key": bool(entry.draft.local_key),
        **(
            {
                "gateway_verification": {
                    "ip": str(entry.draft.ip),
                    "version": entry.draft.version,
                    "key_source": "device"
                    if entry.verified_key_source == entry.draft.device_id
                    else "child",
                }
            }
            if entry.verified_key_source
            else {}
        ),
    }


def proposed_capability(entry, row):
    dp, value, code = row["dp"], row["value"], row["code"]
    if (
        entry.mode != "local"
        or dp is None
        or value is None
        or any(marker in json.dumps(value) for marker in ("[hidden]", "[too deep]"))
    ):
        return None, False
    kind = (
        "boolean"
        if type(value) is bool
        else "integer"
        if type(value) is int
        else "number"
        if type(value) is float
        else "string"
        if type(value) is str
        else "object"
        if isinstance(value, dict)
        else None
    )
    if kind is None:
        return None, False
    color = color_capability(entry.specs, entry.functions, entry.readings.values(), code, dp, value)
    if color:
        return color, True
    cap = Capability(dp=dp, type=kind, writable=False)
    spec = entry.specs.get(code, {})
    limits = spec.get("values", {})
    writable = code in entry.functions and spec.get("dp_id") == int(dp)
    if kind == "boolean":
        writable &= spec.get("type") == "Boolean"
    elif kind == "integer" and spec.get("type") == "Integer":
        lo, hi, step, scale = (
            limits.get(k, default)
            for k, default in (("min", None), ("max", None), ("step", 1), ("scale", 0))
        )
        valid_bounds = (
            all(type(v) is int for v in (lo, hi, step, scale))
            and lo <= hi
            and step > 0
            and 0 <= scale <= 9
        )
        writable &= valid_bounds
        if valid_bounds:
            cap.scale = 10**-scale
            if scale:
                cap.type = "number"
            cap.minimum, cap.maximum, cap.step = lo * cap.scale, hi * cap.scale, step * cap.scale
            cap.raw_type = "integer"
            unit = limits.get("unit")
            cap.unit = unit[:40] if isinstance(unit, str) else None
    elif kind == "string" and spec.get("type") == "Enum":
        choices = limits.get("range")
        valid_choices = (
            isinstance(choices, list)
            and 0 < len(choices) <= 64
            and all(isinstance(v, str) for v in choices)
        )
        writable &= valid_choices
        if valid_choices:
            cap.enum = choices
    else:
        writable = False
    return cap, bool(writable)


@router.post("", status_code=201)
def start(
    body: StartObservation,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    response.headers["Cache-Control"] = "no-store"
    if session.scalar(select(Device.id).where(Device.device_id == body.draft.device_id)):
        raise HTTPException(409, "Устройство уже добавлено в дом.")
    if body.draft.capabilities:
        raise HTTPException(
            422, "Сначала опросите устройство; capabilities формируются при сохранении."
        )
    if body.discover_gateway_key:
        validate_target(body.draft)
        if body.mode != "local" or not body.provider or body.draft.local_key:
            raise HTTPException(
                422,
                "Поиск ключа требует выбранного аккаунта и локального режима без введённого ключа.",
            )
    bridge = cloud_bridge(request, body.provider) if body.provider else None
    if body.mode == "cloud" and bridge is None:
        raise HTTPException(422, "Для облачного опроса выберите подключённый аккаунт.")
    draft, specs, functions, scope = body.draft, {}, set(), None
    pool = []
    if bridge:
        with bridge.lock:
            scope = scope_for(bridge, body.provider)
            device = bridge.writable_device(draft.device_id)
            if body.discover_gateway_key:
                if getattr(device, "category", None) not in GATEWAY_CATEGORIES:
                    raise HTTPException(
                        422, "Smart Life не определяет выбранное устройство как шлюз."
                    )
                pool = candidates(bridge.devices(), draft.device_id)
            specs, functions = definitions(device)
            updates = {
                k: getattr(device, k)
                for k in ("product_id", "category")
                if getattr(device, k, None)
            }
            if not draft.local_key and getattr(device, "local_key", None):
                updates["local_key"] = SecretStr(device.local_key)
            # Revalidate cloud-supplied fields rather than bypassing SecretStr rules.
            try:
                draft = DeviceCreate.model_validate({**draft.model_dump(), **updates})
            except ValidationError:
                raise HTTPException(
                    502, "Tuya вернула некорректные метаданные устройства."
                ) from None
    if body.mode == "local":
        values = validate_device(session, device_values(draft))
    if body.mode == "local" and not body.discover_gateway_key:
        parent = session.get(Device, draft.parent_id) if draft.parent_id else None
        root = parent or Device(**{k: v for k, v in values.items() if k != "aliases"})
        if not root.enabled or not root.ip or not root.local_key or not root.version:
            raise HTTPException(
                409, "Для локального опроса нужны IP, local_key и версия устройства или шлюза."
            )
    store = request.app.state.observations
    entry = Observation(
        draft, body.provider, scope, body.mode, store.clock() + TTL, specs, functions
    )
    token = store.add(entry)
    if body.discover_gateway_key:
        try:
            if not store.gateway_probe_lock.acquire(blocking=False):
                raise HTTPException(
                    409, "Проверка другого шлюза ещё выполняется. Дождитесь её завершения."
                )
            try:
                entry.draft, entry.verified_key_source = discover(
                    request.app.state.controller, draft, pool
                )
            finally:
                store.gateway_probe_lock.release()
            checked_gateway_key(request, entry)
        except Exception:
            store.remove(token)
            raise
    return view(store, token, entry)


def configuration_context(session, item):
    root = session.get(Device, item.parent_id) if item.parent_id else item
    fields = (
        "id",
        "device_id",
        "transport",
        "is_gateway",
        "enabled",
        "ip",
        "version",
        "local_key",
        "parent_id",
        "cid",
        "device_type_id",
    )
    return (
        tuple(getattr(item, name) for name in fields),
        tuple(getattr(root, name) for name in fields) if root else None,
        json.dumps(effective_capabilities(session, item), sort_keys=True),
    )


def checked_existing(session, entry):
    if entry.existing_id is None:
        return None
    session.expire_all()
    item = get_or_404(session, Device, entry.existing_id)
    if configuration_context(session, item) != entry.existing_context:
        raise HTTPException(
            409, "Подключение или функции устройства изменились. Начните настройку заново."
        )
    return item


def existing_definitions(bridge, identifier):
    device = bridge.writable_device(identifier)
    if getattr(device, "id", None) != identifier:
        raise HTTPException(409, "Tuya вернула схему другого устройства.")
    return definitions(device)


@router.post("/devices/{device_id}", status_code=201)
def start_existing(
    device_id: int,
    body: StartExistingObservation,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    """Observe functions of a saved connection without exposing or replacing its key."""
    response.headers["Cache-Control"] = "no-store"
    item = get_or_404(session, Device, device_id)
    if item.is_gateway or effective_capabilities(session, item):
        raise HTTPException(
            409, "Этот сценарий предназначен для устройства с ещё не настроенными функциями."
        )
    source = device_read(session, item).model_dump()
    draft = DeviceCreate.model_validate(
        {
            **{key: value for key, value in source.items() if key in DeviceCreate.model_fields},
            "local_key": SecretStr(item.local_key) if item.local_key else None,
            "capabilities": {},
        }
    )
    validate_device(session, device_values(draft), item.id)
    root = session.get(Device, item.parent_id) if item.parent_id else item
    if (
        not item.enabled
        or not root
        or not root.enabled
        or not root.ip
        or not root.version
        or not root.local_key
    ):
        raise HTTPException(
            409, "Сначала настройте и включите локальное подключение устройства или шлюза."
        )
    specs, functions, scope = {}, set(), None
    if body.provider:
        bridge = cloud_bridge(request, body.provider)
        with bridge.lock:
            scope = scope_for(bridge, body.provider)
            specs, functions = existing_definitions(bridge, item.device_id)
    store = request.app.state.observations
    entry = Observation(
        draft,
        body.provider,
        scope,
        "local",
        store.clock() + TTL,
        specs,
        functions,
        existing_id=item.id,
        existing_context=configuration_context(session, item),
    )
    token = store.add(entry)
    return view(store, token, entry)


def checked_gateway_key(request, entry):
    bridge = checked_scope(request, entry)
    if entry.verified_key_source:
        with bridge.lock:
            checked_scope(request, entry)
            key = entry.draft.local_key.get_secret_value()
            devices = bridge.devices()
            gateway = next(
                (device for device in devices if device.id == entry.draft.device_id), None
            )
            if (
                gateway is None
                or getattr(gateway, "category", None) not in GATEWAY_CATEGORIES
                or (entry.verified_key_source, key)
                not in candidates(devices, entry.draft.device_id)
            ):
                raise HTTPException(409, "Ключ в Smart Life изменился. Повторите проверку шлюза.")
    return bridge


@router.post("/{token}/samples")
def sample(
    token: str,
    body: SampleObservation,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    response.headers["Cache-Control"] = "no-store"
    store = request.app.state.observations
    with store.use(token) as entry:
        if entry.verified_key_source:
            raise HTTPException(
                409, "Связь со шлюзом уже проверена. Сохраните подключение или начните новый опрос."
            )
        bridge = checked_scope(request, entry)
        checked_existing(session, entry)
        now = store.clock()
        interval = 3 if entry.mode == "local" else 5
        if entry.last_poll is not None and now - entry.last_poll < interval:
            raise HTTPException(429, "Дождитесь следующего опроса.")
        entry.last_poll = now
        stamp = datetime.now(timezone.utc).isoformat()
        key = entry.draft.local_key.get_secret_value() if entry.draft.local_key else None
        rows = []
        if entry.mode == "local":
            values = validate_device(session, device_values(entry.draft))
            device = Device(**{k: v for k, v in values.items() if k != "aliases"})
            parent = session.get(Device, device.parent_id) if device.parent_id else None
            raw = request.app.state.controller.execute(
                device, parent
            )  # Status only: no DPS writes.
            checked_existing(session, entry)
            dp_codes = {}
            for code, spec in entry.specs.items():
                if "dp_id" in spec:
                    dp_codes.setdefault(str(spec["dp_id"]), []).append(code)
            if parent:
                key = parent.local_key
            for dp, value in raw.items():
                dp = str(dp)
                if not re.fullmatch(r"[1-9][0-9]{0,4}", dp):
                    continue
                codes = dp_codes.get(dp, [])
                code = codes[0] if len(codes) == 1 else None
                rows.append(
                    {
                        "key": "dp_" + dp,
                        "dp": dp,
                        "code": code,
                        "value": safe_value(value, key),
                        "received_at": stamp,
                        "source": "local",
                    }
                )
        else:
            with bridge.lock:
                refresh = entry.last_cloud_refresh is None or now - entry.last_cloud_refresh >= 10
                device = bridge.device_status(entry.draft.device_id, refresh)
                if refresh:
                    entry.last_cloud_refresh = now
                for code, value in device.status.items():
                    if (
                        not isinstance(code, str)
                        or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code)
                        or code in PRIVATE
                    ):
                        continue
                    spec = entry.specs.get(code, {})
                    observed = getattr(device, "status_observations", {}).get(code, {})
                    rows.append(
                        {
                            "key": code,
                            "dp": str(spec["dp_id"]) if "dp_id" in spec else None,
                            "code": code,
                            "value": safe_value(value, key),
                            "received_at": observed.get("received_at")
                            or getattr(device, "snapshot_received_at", None),
                            "source": "cloud",
                        }
                    )
        for row in rows[:64]:
            if row["key"] not in entry.readings and len(entry.readings) >= 64:
                continue
            previous = entry.readings.get(row["key"])
            cap, can_write = proposed_capability(entry, row)
            row["can_write"] = can_write
            if previous is not None and (
                type(previous["value"]) is not type(row["value"])
                or previous["value"] != row["value"]
            ):
                entry.changes.append(
                    {
                        **row,
                        "previous": previous["value"],
                        "detected_at": stamp,
                        "action": body.action,
                    }
                )
                entry.changes = entry.changes[-100:]
            entry.readings[row["key"]] = row
        # Re-evaluate after all rows are present: color depends on a confirmed
        # mode DP, irrespective of the order of DPS in a LAN response.
        for row in entry.readings.values():
            _, row["can_write"] = proposed_capability(entry, row)
        entry.sample_count += 1
        return view(store, token, entry)


@router.delete("/{token}", status_code=204)
def cancel(token: str, request: Request):
    store = request.app.state.observations
    with store.use(token):
        store.remove(token)
    return Response(status_code=204)


@router.post(
    "/{token}/register",
    status_code=201,
    response_model=DeviceRead,
    responses={200: {"model": DeviceRead}},
)
def register(
    token: str,
    body: RegisterObservation,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
):
    response.headers["Cache-Control"] = "no-store"
    store = request.app.state.observations
    with store.use(token) as entry:
        bridge = checked_gateway_key(request, entry)
        if entry.existing_id is not None and bridge:
            with bridge.lock:
                specs, functions = existing_definitions(bridge, entry.draft.device_id)
                if (specs, functions) != (entry.specs, entry.functions):
                    raise HTTPException(
                        409, "Схема функций Tuya изменилась. Начните настройку заново."
                    )
        if not entry.verified_key_source and (not entry.sample_count or not entry.readings):
            raise HTTPException(409, "Сначала получите показания устройства.")
        if entry.existing_id is None and session.scalar(
            select(Device.id).where(Device.device_id == entry.draft.device_id)
        ):
            raise HTTPException(409, "Устройство уже добавлено в дом.")
        capabilities, allowed = {}, set()
        for row in entry.readings.values():
            cap, can_write = proposed_capability(entry, row)
            if cap is None:
                continue
            name = row["code"] or row["key"]
            if can_write:
                allowed.add(row["key"])
                cap.writable = row["key"] in body.writable
            capabilities[name] = cap.model_dump(mode="json")
        if set(body.writable) - allowed:
            raise HTTPException(
                422, "Управление доступно только для однозначно подтверждённых Tuya DP."
            )
        draft = DeviceCreate.model_validate(
            {
                **entry.draft.model_dump(),
                **body.model_dump(exclude_unset=True, exclude={"reviewed", "writable"}),
                "capabilities": capabilities,
            }
        )
        if entry.existing_id is not None:
            session.rollback()
            session.connection().exec_driver_sql("BEGIN IMMEDIATE")
            item = checked_existing(session, entry)
            if not capabilities:
                raise HTTPException(409, "Поддерживаемые локальные параметры не найдены.")
            # Only functions change; existing name, aliases, placement and connection survive.
            validate_device(
                session,
                {
                    **device_values(entry.draft),
                    "capabilities": capabilities,
                    "name": item.name,
                    "room_id": item.room_id,
                    "building_id": item.building_id,
                },
                item.id,
            )
            item.capabilities = capabilities
            response.status_code = 200
        else:
            item = create_device(session, draft)
        session.flush()
        # Only a real LAN sample proves local reachability. Cloud codes/values can
        # have a different representation and must never seed the local DPS cache.
        if entry.mode == "local":
            for row in sorted(entry.readings.values(), key=lambda row: row["received_at"]):
                if row["dp"] and "[hidden]" not in json.dumps(row["value"]):
                    record_observations(
                        session,
                        item,
                        {row["dp"]: row["value"]},
                        datetime.fromisoformat(row["received_at"]),
                    )
        commit(session)
        newly_registered = entry.existing_id is None
        store.remove(token)
    if newly_registered:
        translate_local_device(session, request, item)
    return device_read(session, item)
