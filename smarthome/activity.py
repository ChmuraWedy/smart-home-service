"""Bounded durable device history, isolated by authorized account and transport."""
import json
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .models import ActivityValue, Device, DeviceActivity, utcnow
from .schemas import Identifier
from .service import get_by_ref

router = APIRouter(prefix="/api/v1/activity", dependencies=[Depends(authenticate)], tags=["Activity"])
LIMIT = 2000
PRIVATE = {"local_key", "key", "access_token", "refresh_token", "access_secret", "password", "token"}


def clean(value, secret=None):
    if secret is not None and value == secret:
        return None
    if isinstance(value, dict):
        return {k: clean(v, secret) for k, v in value.items() if str(k).lower() not in PRIVATE}
    if isinstance(value, list):
        return [clean(v, secret) for v in value[:64]]
    if isinstance(value, str) and len(value) > 512:
        return "[составные данные]"
    if isinstance(value, str):
        if value.lstrip().startswith(('{', '[')):
            try:
                return json.dumps(clean(json.loads(value), secret), ensure_ascii=False)
            except ValueError:
                pass
        if secret:
            value = value.replace(secret, "[скрыто]")
    return value


def trim(session, scope, device_id):
    keep = select(DeviceActivity.id).where(DeviceActivity.scope == scope, DeviceActivity.device_id == device_id).order_by(DeviceActivity.id.desc()).limit(LIMIT)
    session.execute(delete(DeviceActivity).where(DeviceActivity.scope == scope, DeviceActivity.device_id == device_id, DeviceActivity.id.not_in(keep)))


def record_values(session, scope, device_id, values, *, source="snapshot", observations=None, secret=None):
    at = utcnow().isoformat()
    for code, value in values.items():
        if code.lower() in PRIVATE or (secret is not None and value == secret):
            continue
        value = clean(value, secret)
        old = session.get(ActivityValue, (scope, device_id, code))
        observation = (observations or {}).get(code, {})
        if source == "snapshot" and old is not None and old.report_stamp:
            continue  # Cached HTTP state cannot reverse an actual device report.
        stamp = observation.get("received_at") if source == "report" else None
        if old is not None and source == "report" and old.report_stamp and stamp and stamp <= old.report_stamp:
            continue
        changed = old is None or old.value != value
        if changed or (source == "report" and stamp):
            session.add(DeviceActivity(scope=scope, device_id=device_id, at=stamp or at,
                observed_at=observation.get("observed_at"), kind=source, code=code, value=value, outcome=None))
        if old is None:
            old = ActivityValue(scope=scope, device_id=device_id, code=code, value=value)
            session.add(old)
        old.value = value
        if stamp:
            old.report_stamp = stamp
    session.flush()
    trim(session, scope, device_id)


def record_command(session, scope, device_id, values, outcome, secret=None):
    session.add(DeviceActivity(scope=scope, device_id=device_id, at=utcnow().isoformat(), observed_at=None,
        kind="command", code="command", value=clean(values, secret), outcome=outcome))
    session.flush()
    trim(session, scope, device_id)


@router.get("/devices/{device_id}")
def history(device_id: Identifier, request: Request, response: Response,
    provider: Literal["sharing", "developer", "local"] = "sharing",
    before: int | None = Query(None, ge=1), limit: int = Query(50, ge=1, le=100), session: Session = Depends(get_session)):
    if provider == "local":
        item = get_by_ref(session, Device, device_id)
        scope, identity = "local", item.device_id
    else:
        from .cloud_api import cloud_bridge
        from .cloud_scope import scope_for
        bridge = cloud_bridge(request, provider)
        with bridge.lock:
            bridge.device(device_id)  # Membership check without a status query.
            scope, identity = scope_for(bridge, provider), device_id
    query = select(DeviceActivity).where(DeviceActivity.scope == scope, DeviceActivity.device_id == identity)
    if before:
        query = query.where(DeviceActivity.id < before)
    rows = session.scalars(query.order_by(DeviceActivity.id.desc()).limit(limit + 1)).all()
    response.headers["Cache-Control"] = "no-store"
    return {"device_id": device_id, "events": [{"id": row.id, "at": row.at, "observed_at": row.observed_at,
        "kind": row.kind, "code": row.code, "value": row.value, "outcome": row.outcome} for row in rows[:limit]],
        "next_before": rows[limit - 1].id if len(rows) > limit else None, "retention_limit": LIMIT}
