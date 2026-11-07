"""Local aliases for cards. Registered devices reuse the inventory's aliases."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .auto_label_translations import cloud_labels, generate_missing
from .cloud_mappings import scope_for
from .device_translations import cloud_translations, promote_alias_translations, prune_translations
from .models import CloudDeviceAlias, Device
from .schemas import Alias, Identifier, Schema, unique_aliases
from .service import commit, replace_aliases

router = APIRouter(prefix="/api/v1/cloud", tags=["Cloud"], dependencies=[Depends(authenticate)])


class DeviceAliases(Schema):
    aliases: list[Alias] = Field(max_length=32)
    _unique = field_validator("aliases")(unique_aliases)


def aliases_for_devices(session, scope, device_ids):
    aliases = {identifier: [] for identifier in device_ids}
    if not aliases:
        return aliases
    # No placeholder inventory records are created for cloud-only devices.
    for device in session.scalars(select(Device).where(Device.device_id.in_(device_ids))):
        aliases[device.device_id].extend(entry.alias for entry in device.alias_entries)
    for row in session.scalars(select(CloudDeviceAlias).where(
        CloudDeviceAlias.scope == scope, CloudDeviceAlias.device_id.in_(device_ids)
    )):
        aliases[row.device_id].append(row.alias)
    return {identifier: sorted(set(values)) for identifier, values in aliases.items()}


def context(request, provider, device_id):
    from .cloud_api import cloud_bridge

    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        device = bridge.device(device_id)
        return scope_for(bridge, provider), getattr(device, "name", "") or ""


@router.get("/devices/{device_id}/aliases")
def read_aliases(device_id: Identifier, request: Request, response: Response,
                 provider: Literal["sharing", "developer"] = "sharing", session: Session = Depends(get_session)):
    scope, _ = context(request, provider, device_id)
    response.headers["Cache-Control"] = "no-store"
    return {"device_id": device_id, "aliases": aliases_for_devices(session, scope, [device_id])[device_id]}


@router.put("/devices/{device_id}/aliases")
def save_aliases(device_id: Identifier, body: DeviceAliases, request: Request, response: Response,
                 provider: Literal["sharing", "developer"] = "sharing", session: Session = Depends(get_session)):
    scope, name = context(request, provider, device_id)
    aliases = body.aliases
    conflict = session.scalar(select(CloudDeviceAlias).where(
        CloudDeviceAlias.scope == scope, CloudDeviceAlias.alias.in_(aliases),
        CloudDeviceAlias.device_id != device_id,
    ))
    if conflict is not None:
        raise HTTPException(409, "Alias is already assigned to another device")
    local = session.scalar(select(Device).where(Device.device_id == device_id))
    existing = list(session.scalars(select(CloudDeviceAlias).where(
        CloudDeviceAlias.scope == scope, CloudDeviceAlias.device_id == device_id
    )))
    if local:
        # Reuse the existing alias model and validation rather than copying aliases.
        replace_aliases(session, local, aliases)
        promote_alias_translations(session, scope, device_id, local, [entry.alias for entry in local.alias_entries])
        for row in existing:
            session.delete(row)
    else:
        # Keep the same uniqueness rule as inventory aliases without importing a device.
        others = session.scalars(select(Device).where(Device.device_id != device_id))
        if any(entry.alias in aliases for device in others for entry in device.alias_entries):
            raise HTTPException(409, "Alias is already assigned to another device")
        retained = {row.alias for row in existing}
        for row in existing:
            if row.alias not in aliases:
                session.delete(row)
        session.add_all(CloudDeviceAlias(scope=scope, device_id=device_id, alias=alias)
                        for alias in aliases if alias not in retained)
    prune_translations(session, scope, device_id, "alias", [] if local else aliases)
    commit(session)
    translator = request.app.state.settings.label_translator_url
    generate_missing(session, translator, lambda: cloud_labels(session, scope, device_id, name))
    response.headers["Cache-Control"] = "no-store"
    aliases = aliases_for_devices(session, scope, [device_id])
    result = {"device_id": device_id, "aliases": aliases[device_id]}
    if translator:
        row = {"id": device_id, "name": name}
        cloud_translations(session, scope, [row], aliases)
        result["translations"] = row["translations"]
    return result
