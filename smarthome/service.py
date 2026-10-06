from datetime import timezone

from fastapi import HTTPException
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import (
    Building,
    BuildingAlias,
    Device,
    DeviceAlias,
    DeviceObservation,
    DeviceType,
    Room,
    RoomAlias,
    utcnow,
)
from .schemas import Alias, Capability, CapabilityState, DeviceRead, DeviceState
from .search import fold_name, get_by_alias, get_by_name


def get_or_404(session: Session, model, item_id: int):
    item = session.get(model, item_id)
    if item is None:
        raise HTTPException(404, f"{model.__name__} not found")
    return item


ALIAS_MODELS = {
    Building: (BuildingAlias, "building_id"),
    Room: (RoomAlias, "room_id"),
    Device: (DeviceAlias, "device_id"),
}


def get_by_ref(session: Session, model, reference: str):
    if reference.startswith("name:"):
        return get_by_name(session, model, reference[5:])
    if reference.isascii() and reference.isdecimal():
        return get_or_404(session, model, int(reference))
    return get_by_alias(session, model, reference)


def replace_aliases(session: Session, item, aliases: list[str]):
    # Clients may round-trip the read representation, including the human name.
    aliases = [alias for alias in aliases if fold_name(alias) != fold_name(item.name)]
    try:
        aliases = [TypeAdapter(Alias).validate_python(alias) for alias in aliases]
    except ValidationError:
        raise HTTPException(
            422,
            "Custom aliases require 1..64 ASCII letters/digits/._- and must start with a letter; the current name is automatic",
        ) from None
    if len(aliases) > 32 or len(aliases) != len(set(aliases)):
        raise HTTPException(422, "At most 32 unique custom aliases are allowed")
    alias_model, owner_field = ALIAS_MODELS[type(item)]
    with session.no_autoflush:
        query = select(alias_model).where(alias_model.alias.in_(aliases))
        if item.id is not None:
            query = query.where(getattr(alias_model, owner_field) != item.id)
        if session.scalar(query) is not None:
            raise HTTPException(409, "Alias is already assigned to another object of this type")
        existing = {entry.alias: entry for entry in item.alias_entries}
        if isinstance(item, Device) and set(existing) != set(aliases):
            item.updated_at = utcnow()
        item.alias_entries = [
            existing[alias] if alias in existing else alias_model(alias=alias)
            for alias in sorted(aliases)
        ]


def create_aliased(session: Session, model, body):
    values = body.model_dump(mode="json")
    aliases = values.pop("aliases")
    item = model(**values)
    replace_aliases(session, item, aliases)
    session.add(item)
    return item


def commit(session: Session):
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            409, "Duplicate identifier/name/cid or a referenced object still exists"
        ) from None


def device_values(body, *, patch=False):
    values = body.model_dump(mode="json", exclude_unset=patch, exclude={"node_id", "local_key"})
    if not patch or "local_key" in body.model_fields_set:
        values["local_key"] = body.local_key.get_secret_value() if body.local_key else None
    return values


def validate_device(session: Session, values: dict, item_id: int | None = None):
    """Validate the full merged state, before mutating an ORM object."""
    room_id, building_id = values.get("room_id"), values.get("building_id")
    if room_id is not None:
        room = get_or_404(session, Room, room_id)
        if building_id is not None and building_id != room.building_id:
            raise HTTPException(422, "room_id does not belong to building_id")
        values["building_id"] = building_id = room.building_id
    if building_id is not None:
        get_or_404(session, Building, building_id)
    if values.get("device_type_id") is not None:
        get_or_404(session, DeviceType, values["device_type_id"])
    parent_id = values.get("parent_id")
    if values["transport"] == "zigbee":
        if values["is_gateway"] or parent_id is None or not values.get("cid"):
            raise HTTPException(
                422, "Zigbee child requires parent_id + cid and cannot be a gateway"
            )
        if parent_id == item_id:
            raise HTTPException(422, "Device cannot be its own parent")
        parent = get_or_404(session, Device, parent_id)
        if not parent.is_gateway or parent.transport != "wifi" or parent.parent_id is not None:
            raise HTTPException(422, "Parent must be a direct Wi-Fi Tuya gateway")
        if (
            building_id is not None
            and parent.building_id is not None
            and building_id != parent.building_id
        ):
            raise HTTPException(422, "Child and gateway must belong to the same building")
    elif parent_id is not None or values.get("cid") is not None:
        raise HTTPException(422, "Wi-Fi device cannot have parent_id or cid")
    if item_id is not None:
        from .dashboard import validate_device_move

        validate_device_move(session, item_id, values.get("room_id"))
        children = session.scalars(select(Device).where(Device.parent_id == item_id)).all()
        if children and (not values["is_gateway"] or values["transport"] != "wifi"):
            raise HTTPException(409, "Gateway has children; detach them before changing its role")
        if building_id is not None and any(
            c.building_id is not None and c.building_id != building_id for c in children
        ):
            raise HTTPException(409, "Gateway move would put children in a different building")
    return values


def create_device(session: Session, body):
    values = device_values(body)
    aliases = values.pop("aliases")
    item = Device(**validate_device(session, values))
    replace_aliases(session, item, aliases)
    session.add(item)
    return item


def patch_device(session: Session, item: Device, body):
    delta = device_values(body, patch=True)
    aliases = delta.pop("aliases", None)
    values = {column.name: getattr(item, column.name) for column in Device.__table__.columns}
    # A room change without an explicit building change follows the new room's building.
    if delta.get("room_id") is not None and "building_id" not in delta:
        values["building_id"] = None
    values.update(delta)
    validate_device(session, values, item.id)
    for key in delta:
        setattr(item, key, values[key])
    item.building_id = values["building_id"]
    if aliases is not None:
        replace_aliases(session, item, aliases)
    return item


def effective_capabilities(session: Session, item: Device):
    kind = session.get(DeviceType, item.device_type_id) if item.device_type_id else None
    return {**(kind.capabilities if kind else {}), **item.capabilities}


def device_read(session: Session, item: Device):
    # Explicit whitelist: never serialize the ORM object's __dict__ or local_key.
    fields = {name: getattr(item, name) for name in DeviceRead.model_fields if hasattr(item, name)}
    fields.update(
        node_id=item.cid,
        has_local_key=bool(item.local_key),
        capabilities=effective_capabilities(session, item),
    )
    for key in ("created_at", "updated_at", "last_seen_at"):
        if fields[key] is not None and fields[key].tzinfo is None:
            fields[key] = fields[key].replace(tzinfo=timezone.utc)
    return DeviceRead.model_validate(fields)


def capability_dps(session: Session, item: Device, name: str, value):
    definition = effective_capabilities(session, item).get(name)
    if definition is None:
        raise HTTPException(
            409, "Capability is not mapped; configure device/type capabilities or use set_dps"
        )
    spec = Capability.model_validate(definition)
    from .capabilities import command_dps

    return command_dps(spec, value)


def capability_values_dps(session, item, values):
    from .capabilities import merge_commands

    return merge_commands(
        capability_dps(session, item, name, value) for name, value in values.items()
    )


def record_observations(session, item, observed, observed_at):
    if observed:
        item.last_dps = {**(item.last_dps or {}), **observed}
    for dp, value in observed.items():
        observation = session.get(DeviceObservation, (item.id, dp))
        if observation is None:
            observation = DeviceObservation(device_id=item.id, dp=dp)
            session.add(observation)
        observation.value, observation.observed_at = value, observed_at
    item.last_seen_at = observed_at


def device_state(session, item, *, max_age=60, now=None):
    from .capabilities import decode

    now = now or utcnow()
    observations = {
        row.dp: row
        for row in session.scalars(
            select(DeviceObservation).where(DeviceObservation.device_id == item.id)
        ).all()
    }
    values = {}
    for name, definition in effective_capabilities(session, item).items():
        spec = Capability.model_validate(definition)
        if not spec.readable:
            continue
        row = observations.get(spec.read_dp or spec.dp)
        state = CapabilityState()
        if row is not None:
            timestamp = (
                row.observed_at.replace(tzinfo=timezone.utc)
                if row.observed_at.tzinfo is None
                else row.observed_at
            )
            state.observed_at = timestamp
            state.stale = (now - timestamp).total_seconds() > max_age
            try:
                state.value = decode(spec, row.value)
                state.known = True
            except (ValueError, TypeError, OverflowError):
                state.stale = True
        values[name] = state
    parent = session.get(Device, item.parent_id) if item.parent_id else None
    enabled = item.enabled and (parent is None or parent.enabled)
    return DeviceState(
        device_id=item.id,
        name=item.name,
        enabled=enabled,
        available=enabled and any(v.known and not v.stale for v in values.values()),
        values=values,
    )
