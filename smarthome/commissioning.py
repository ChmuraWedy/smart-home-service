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
from pydantic import Field, SecretStr, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .cloud_api import Provider, cloud_bridge, safe_spec
from .cloud_mappings import scope_for
from .models import Device
from .schemas import Capability, DeviceCreate, DeviceRead, Name, PositiveID, Schema
from .service import (
    commit,
    create_device,
    device_read,
    device_values,
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


class SampleObservation(Schema):
    action: Action = "observe"


class RegisterObservation(Schema):
    name: Name
    aliases: list[Name] = Field(default_factory=list, max_length=32)
    building_id: PositiveID | None = None
    room_id: PositiveID | None = None
    reviewed: Literal[True]
    writable: list[str] = Field(default_factory=list, max_length=64)


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
    lock: threading.Lock = field(default_factory=threading.Lock)


class Observations:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.entries = {}
        self.lock = threading.Lock()

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
    bridge = cloud_bridge(request, body.provider) if body.provider else None
    if body.mode == "cloud" and bridge is None:
        raise HTTPException(422, "Для облачного опроса выберите подключённый аккаунт.")
    draft, specs, functions, scope = body.draft, {}, set(), None
    if bridge:
        with bridge.lock:
            scope = scope_for(bridge, body.provider)
            device = bridge.writable_device(draft.device_id)
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
    return view(store, token, entry)


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
        bridge = checked_scope(request, entry)
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
        entry.sample_count += 1
        return view(store, token, entry)


@router.delete("/{token}", status_code=204)
def cancel(token: str, request: Request):
    store = request.app.state.observations
    with store.use(token):
        store.remove(token)
    return Response(status_code=204)


@router.post("/{token}/register", status_code=201, response_model=DeviceRead)
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
        checked_scope(request, entry)
        if not entry.sample_count or not entry.readings:
            raise HTTPException(409, "Сначала получите показания устройства.")
        if session.scalar(select(Device.id).where(Device.device_id == entry.draft.device_id)):
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
        result = device_read(session, item)
        store.remove(token)
        return result
