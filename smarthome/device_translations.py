"""Explicit display translations for the current device name and custom aliases."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .db import lock_writes, upsert
from .models import Device, DeviceTranslation
from .schemas import DisplayText, EntityRef, Identifier, Locale, Schema

LOCAL_SCOPE = "local"
router = APIRouter(prefix="/api/v1", tags=["Devices"], dependencies=[Depends(authenticate)])


class TranslationEdit(Schema):
    kind: Literal["name", "alias"]
    original: str = Field(min_length=1, max_length=256)
    values: dict[Locale, DisplayText]


class TranslationSaved(TranslationEdit):
    shared: bool


class TranslationWrite(TranslationEdit):
    edited: set[Locale] | None = None


def translations_for(session, scope, identifiers):
    result = {}
    if identifiers:
        rows = session.scalars(select(DeviceTranslation).where(
            DeviceTranslation.scope == scope, DeviceTranslation.device_id.in_(identifiers)
        ))
        for row in rows:
            result.setdefault(row.device_id, {"name": {}, "alias": {}})[row.kind][row.original] = row.values
    return result


def display_translations(values, name, aliases):
    return {
        "name": {name: values.get("name", {})[name]} if name in values.get("name", {}) else {},
        "alias": {key: text for key, text in values.get("alias", {}).items() if key in aliases},
    }


def omit_empty(values):
    return {kind: {key: text for key, text in entries.items() if text} for kind, entries in values.items()}


def local_translations(session, device, values=None):
    if values is None:
        values = translations_for(session, LOCAL_SCOPE, [str(device.id)]).get(str(device.id), {})
    return omit_empty(display_translations(values, device.name, {entry.alias for entry in device.alias_entries}))


def cloud_translations(session, scope, rows, aliases):
    identifiers = [row["id"] for row in rows]
    locals_by_id = {device.device_id: device for device in session.scalars(
        select(Device).where(Device.device_id.in_(identifiers))
    )}
    local_values = translations_for(session, LOCAL_SCOPE, [str(device.id) for device in locals_by_id.values()])
    cloud_values = translations_for(session, scope, identifiers)
    for row in rows:
        identifier = row["id"]
        device = locals_by_id.get(identifier)
        custom_aliases = aliases[identifier]
        values = display_translations(cloud_values.get(identifier, {}), row["name"], custom_aliases)
        if device is not None:
            shared = local_values.get(str(device.id), {})
            local_aliases = {entry.alias for entry in device.alias_entries}
            local = display_translations(shared, device.name, local_aliases)
            for kind in ("name", "alias"):
                # A blank saved local entry explicitly restores the original text.
                values[kind].update(local[kind])
        row["translations"] = omit_empty(values)


def prune_translations(session, scope, identifier, kind, keep):
    session.execute(delete(DeviceTranslation).where(
        DeviceTranslation.scope == scope,
        DeviceTranslation.device_id == identifier,
        DeviceTranslation.kind == kind,
        DeviceTranslation.original.not_in(keep),
    ))


def save_values(session, scope, identifier, kind, original, values, *, promote=False):
    match = {
        "scope": scope, "device_id": identifier, "kind": kind, "original": original,
    }
    statement = upsert(session.get_bind(), DeviceTranslation).values(**match, values=values)
    keys = list(match)
    if promote:
        statement = statement.on_conflict_do_nothing(index_elements=keys)
    else:
        statement = statement.on_conflict_do_update(index_elements=keys, set_={"values": values})
    session.execute(statement)


def promote_alias_translations(session, scope, device_id, device, aliases):
    values = translations_for(session, scope, [device_id]).get(device_id, {}).get("alias", {})
    for original in aliases:
        if original in values:
            save_values(session, LOCAL_SCOPE, str(device.id), "alias", original, values[original], promote=True)


def save_edit(session, scope, identifier, body, *, previous_cloud_key=None):
    values = body.values
    if body.edited is not None:
        row = session.get(DeviceTranslation, (scope, identifier, body.kind, body.original))
        if row is None and previous_cloud_key is not None:
            row = session.get(DeviceTranslation, (*previous_cloud_key, body.kind, body.original))
        values = dict(row.values) if row else {}
        for language in body.edited:
            if language in body.values:
                values[language] = body.values[language]
            else:
                values.pop(language, None)
    save_values(session, scope, identifier, body.kind, body.original, values)
    return TranslationSaved(kind=body.kind, original=body.original, values=values, shared=scope == LOCAL_SCOPE)


@router.put("/devices/{item_id}/translations", response_model=TranslationSaved)
def save_local_translations(item_id: EntityRef, body: TranslationWrite, response: Response, session: Session = Depends(get_session)):
    from .service import commit, get_by_ref

    lock_writes(session)
    device = get_by_ref(session, Device, item_id)
    valid = body.original == device.name if body.kind == "name" else any(
        entry.alias == body.original for entry in device.alias_entries
    )
    if not valid:
        raise HTTPException(409, "This name or alias has changed. Reload the device and try again.")
    saved = save_edit(session, LOCAL_SCOPE, str(device.id), body)
    commit(session)
    response.headers["Cache-Control"] = "no-store"
    return saved


@router.put("/cloud/devices/{device_id}/translations", response_model=TranslationSaved, tags=["Cloud"])
def save_cloud_translations(
    device_id: Identifier, body: TranslationWrite, request: Request, response: Response,
    provider: Literal["sharing", "developer"] = "sharing", session: Session = Depends(get_session),
):
    from .cloud_api import cloud_bridge
    from .cloud_scope import scope_for
    from .models import CloudDeviceAlias
    from .service import commit

    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        cloud = bridge.device(device_id)
        scope = scope_for(bridge, provider)
        lock_writes(session)
        device = session.scalar(select(Device).where(Device.device_id == device_id))
        if body.kind == "name":
            shared = device is not None and body.original == device.name
            valid = shared or body.original == cloud.name
        else:
            shared = device is not None and any(entry.alias == body.original for entry in device.alias_entries)
            valid = shared or session.scalar(select(CloudDeviceAlias).filter_by(
                scope=scope, device_id=device_id, alias=body.original
            )) is not None
        if not valid:
            raise HTTPException(409, "This name or alias has changed. Reload the device and try again.")
        identifier = str(device.id) if shared else device_id
        saved = save_edit(
            session, LOCAL_SCOPE if shared else scope, identifier, body,
            previous_cloud_key=(scope, device_id) if shared else None,
        )
        if shared:
            # An earlier account-specific variant may predate local registration.
            session.execute(delete(DeviceTranslation).filter_by(
                scope=scope, device_id=device_id, kind=body.kind, original=body.original
            ))
        commit(session)
    response.headers["Cache-Control"] = "no-store"
    return saved
