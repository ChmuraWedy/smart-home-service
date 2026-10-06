"""Room groups and compact, persisted display dashboards."""

from fastapi import HTTPException
from sqlalchemy import select

from .models import Device, DeviceGroup, Display, DisplayWidget, GroupMember, Room
from .schemas import Capability, DisplayRead, GroupRead, WidgetSelection
from .service import device_state, effective_capabilities, get_or_404


def group_read(group):
    return GroupRead(
        id=group.id,
        name=group.name,
        room_id=group.room_id,
        device_ids=[member.device_id for member in group.members],
    )


def validate_group(session, room_id, device_ids):
    get_or_404(session, Room, room_id)
    for identifier in device_ids:
        item = get_or_404(session, Device, identifier)
        if item.room_id != room_id:
            raise HTTPException(422, "All group members must belong to the group room")
        switch = effective_capabilities(session, item).get("switch")
        if not switch or switch["type"] != "boolean" or not switch.get("writable", True):
            raise HTTPException(
                422, "Light group members require a writable boolean switch capability"
            )


def display_read(display):
    return DisplayRead(
        id=display.id,
        name=display.name,
        room_id=display.room_id,
        widgets=[
            WidgetSelection(
                kind="group" if w.group_id else "device",
                id=w.group_id or w.device_id,
                capabilities=w.capabilities,
            )
            for w in display.widgets
        ],
    )


def selected_devices(session, room_id, widgets):
    get_or_404(session, Room, room_id)
    selected = set()
    for widget in widgets:
        model = DeviceGroup if widget.kind == "group" else Device
        item = get_or_404(session, model, widget.id)
        if item.room_id != room_id:
            raise HTTPException(422, "Display widgets must belong to its selected room")
        if widget.kind == "group":
            selected.update(member.device_id for member in item.members)
            # Revalidate room relationships after editing inventory.
            if any(
                get_or_404(session, Device, m.device_id).room_id != room_id for m in item.members
            ):
                raise HTTPException(409, "Group member is outside the selected room")
        else:
            selected.add(item.id)
            if set(widget.capabilities) - set(effective_capabilities(session, item)):
                raise HTTPException(422, "A selected capability is not mapped")
    if len(selected) > 12:
        raise HTTPException(422, "A small MCU dashboard supports at most 12 distinct devices")
    return selected


def validate_group_change(session, group, room_id, device_ids):
    validate_group(session, room_id, device_ids)
    references = session.scalars(
        select(DisplayWidget).where(DisplayWidget.group_id == group.id)
    ).all()
    for reference in references:
        display = session.get(Display, reference.display_id)
        if display.room_id != room_id:
            raise HTTPException(409, "Group is selected by a display in another room")
        targets = []
        for w in display.widgets:
            if w.group_id == group.id:
                continue
            targets.append(
                WidgetSelection(
                    kind="group" if w.group_id else "device", id=w.group_id or w.device_id
                )
            )
        existing = selected_devices(session, room_id, targets)
        if len(existing | set(device_ids)) > 12:
            raise HTTPException(409, "Changing group members would exceed a display device limit")


def validate_device_move(session, item_id, room_id):
    # Keep selections and groups coherent rather than silently controlling another room.
    if (
        session.scalar(select(GroupMember).where(GroupMember.device_id == item_id).limit(1))
        is not None
    ):
        item = session.get(Device, item_id)
        if item.room_id != room_id:
            raise HTTPException(409, "Remove device from groups before changing its room")
    refs = session.scalars(select(DisplayWidget).where(DisplayWidget.device_id == item_id)).all()
    if any(session.get(Display, ref.display_id).room_id != room_id for ref in refs):
        raise HTTPException(409, "Remove device from display selections before changing its room")


def group_state(session, group, *, max_age=60):
    members = [
        device_state(session, get_or_404(session, Device, m.device_id), max_age=max_age)
        for m in group.members
    ]
    states = [m.values.get("switch") for m in members]
    known = [
        s
        for m, s in zip(members, states, strict=True)
        if m.enabled and s and s.known and not s.stale and type(s.value) is bool
    ]
    on = sum(s.value is True for s in known)
    off = sum(s.value is False for s in known)
    state = "unknown"
    if len(known) == len(members) and members:
        state = "on" if on == len(members) else "off" if off == len(members) else "mixed"
    return {
        "group_id": group.id,
        "name": group.name,
        "state": state,
        "on_count": on,
        "off_count": off,
        "unknown_count": len(members) - len(known),
        "members": [m.model_dump(mode="json") for m in members],
    }


def device_card(session, item, selected=None):
    definitions = effective_capabilities(session, item)
    # Bound JSON size/RAM on boards without PSRAM; configuration can choose up to 8.
    names = selected or list(definitions)[:8]
    state = device_state(session, item)
    capabilities = {}
    fields = (
        "type",
        "readable",
        "writable",
        "minimum",
        "maximum",
        "step",
        "unit",
        "enum",
        "encoding",
    )
    for name in names:
        if name not in definitions:
            continue
        spec = Capability.model_validate(definitions[name]).model_dump(mode="json")
        capabilities[name] = {key: spec[key] for key in fields if spec[key] is not None}
    return {
        "kind": "device",
        "id": item.id,
        "name": item.name,
        "enabled": state.enabled,
        "available": state.available,
        "capabilities": capabilities,
        "values": {
            name: value.model_dump(mode="json")
            for name, value in state.values.items()
            if name in names
        },
    }


def dashboard(session, display):
    selected_devices(session, display.room_id, display_read(display).widgets)
    widgets = []
    for widget in display.widgets:
        if widget.device_id:
            widgets.append(
                device_card(
                    session, get_or_404(session, Device, widget.device_id), widget.capabilities
                )
            )
        else:
            group = get_or_404(session, DeviceGroup, widget.group_id)
            state = group_state(session, group)
            widgets.append(
                {
                    "kind": "group",
                    "id": group.id,
                    "name": group.name,
                    "state": state["state"],
                    "on_count": state["on_count"],
                    "off_count": state["off_count"],
                    "unknown_count": state["unknown_count"],
                    "members": [
                        device_card(session, get_or_404(session, Device, m.device_id))
                        for m in group.members
                    ],
                }
            )
    return {
        "id": display.id,
        "name": display.name,
        "room_id": display.room_id,
        "room_name": get_or_404(session, Room, display.room_id).name,
        "widgets": widgets,
    }
