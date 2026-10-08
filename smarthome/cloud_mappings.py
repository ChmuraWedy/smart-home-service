"""Explicit local records for remote, group and multi-control device maps.

No guesses about the mobile app's private association APIs or physical bindings.
"""

import hashlib
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Request, Response
from pydantic import Field
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .api_dependencies import get_session
from .cloud_api import Provider, cloud_bridge, router, safe_spec
from .models import CloudDeviceMapping
from .schemas import Identifier, PositiveID, Schema

Code = Annotated[str, Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_]{0,127}$")]
DP = Annotated[int, Field(strict=True, ge=1, le=255)]


class MappingInput(Schema):
    kind: Literal["remote", "zigbee_group", "multi_control"]
    source_code: Code
    source_dp_id: DP | None = None
    target_device_id: Identifier
    target_code: Code
    target_dp_id: DP | None = None


def scope_for(bridge, provider):
    bridge.require_enabled()
    identity = (
        bridge.credentials.get("access_id")
        if provider == "developer" and bridge.credentials
        else bridge.auth.get("token_info", {}).get("uid")
        if provider == "sharing" and isinstance(bridge.auth, dict)
        else None
    )
    if not identity:
        raise HTTPException(409, "Connect the selected Tuya account first")
    return hashlib.sha256((provider + ":" + identity).encode()).hexdigest()


def view(entry):
    return {
        "id": entry.id,
        "kind": entry.kind,
        "source_device_id": entry.source_device_id,
        "source_code": entry.source_code,
        "source_dp_id": entry.source_dp_id,
        "target_device_id": entry.target_device_id,
        "target_code": entry.target_code,
        "target_dp_id": entry.target_dp_id,
        "origin": "manual",
        "applied_to_tuya": False,
    }


def checked_dp(device, code, supplied, writable):
    entries = dict(getattr(device, "status_range", {})) if not writable else {}
    entries.update(device.function)
    spec = entries.get(code)
    if spec is None:
        raise HTTPException(422, "Mapping code is not available on the selected device")
    known = safe_spec(device, spec).get("dp_ids", [])
    if known and supplied is not None and supplied not in known:
        raise HTTPException(422, "Mapping DP does not match the advertised device code")
    return supplied if supplied is not None else known[0] if len(known) == 1 else None


@router.get("/devices/{device_id}/mappings")
def list_mappings(
    device_id: Identifier,
    request: Request,
    response: Response,
    provider: Provider = "sharing",
    session: Session = Depends(get_session),
):
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        scope = scope_for(bridge, provider)
        bridge.device(device_id)
        entries = session.scalars(
            select(CloudDeviceMapping)
            .where(
                CloudDeviceMapping.scope == scope,
                or_(
                    CloudDeviceMapping.source_device_id == device_id,
                    CloudDeviceMapping.target_device_id == device_id,
                ),
            )
            .order_by(CloudDeviceMapping.id)
        ).all()
        response.headers["Cache-Control"] = "no-store"
        return {
            "device_id": device_id,
            "provider": provider,
            "tuya_bindings_available": False,
            "mappings": [view(e) for e in entries],
        }


@router.post("/devices/{device_id}/mappings", status_code=201)
def create_mapping(
    device_id: Identifier,
    body: MappingInput,
    request: Request,
    provider: Provider = "sharing",
    session: Session = Depends(get_session),
):
    return save_mapping(device_id, None, body, request, provider, session)


@router.put("/devices/{device_id}/mappings/{mapping_id}")
def update_mapping(
    device_id: Identifier,
    mapping_id: PositiveID,
    body: MappingInput,
    request: Request,
    provider: Provider = "sharing",
    session: Session = Depends(get_session),
):
    return save_mapping(device_id, mapping_id, body, request, provider, session)


def save_mapping(device_id, mapping_id, body, request, provider, session):
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        scope = scope_for(bridge, provider)
        source = (
            bridge.writable_device(device_id)
            if provider == "developer"
            else bridge.device(device_id)
        )
        target = (
            bridge.writable_device(body.target_device_id)
            if provider == "developer"
            else bridge.device(body.target_device_id)
        )
        if device_id == body.target_device_id and body.source_code == body.target_code:
            raise HTTPException(422, "A device parameter cannot map to itself")
        entry = session.get(CloudDeviceMapping, mapping_id) if mapping_id else CloudDeviceMapping()
        if mapping_id and (
            entry is None or entry.scope != scope or entry.source_device_id != device_id
        ):
            raise HTTPException(404, "Mapping not found")
        entry.scope, entry.source_device_id = scope, device_id
        entry.kind, entry.source_code = body.kind, body.source_code
        entry.source_dp_id = checked_dp(source, body.source_code, body.source_dp_id, False)
        entry.target_device_id, entry.target_code = body.target_device_id, body.target_code
        entry.target_dp_id = checked_dp(target, body.target_code, body.target_dp_id, True)
        session.add(entry)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "This mapping already exists") from None
        session.refresh(entry)
        return view(entry)


@router.delete("/devices/{device_id}/mappings/{mapping_id}", status_code=204)
def delete_mapping(
    device_id: Identifier,
    mapping_id: PositiveID,
    request: Request,
    provider: Provider = "sharing",
    session: Session = Depends(get_session),
):
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        scope = scope_for(bridge, provider)
        bridge.device(device_id)
        entry = session.get(CloudDeviceMapping, mapping_id)
        if entry is None or entry.scope != scope or entry.source_device_id != device_id:
            raise HTTPException(404, "Mapping not found")
        session.delete(entry)
        session.commit()
