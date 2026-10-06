from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .control import run_command
from .dashboard import (
    dashboard,
    device_card,
    display_read,
    group_read,
    group_state,
    selected_devices,
    validate_group,
    validate_group_change,
)
from .models import Device, DeviceGroup, Display, DisplayWidget, GroupMember, Room
from .schemas import DisplayConfig, DisplayID, DisplayRead, GroupCreate, GroupPatch, GroupRead
from .service import capability_dps, commit, get_or_404

router = APIRouter(prefix="/api/v1", dependencies=[Depends(authenticate)])


@router.post("/groups", response_model=GroupRead, status_code=201, tags=["Groups"])
def create_group(body: GroupCreate, session: Session = Depends(get_session)):
    validate_group(session, body.room_id, body.device_ids)
    group = DeviceGroup(
        name=body.name,
        room_id=body.room_id,
        members=[GroupMember(device_id=id, position=i) for i, id in enumerate(body.device_ids)],
    )
    session.add(group)
    commit(session)
    return group_read(group)


@router.get("/groups", response_model=list[GroupRead], tags=["Groups"])
def list_groups(
    room_id: int | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    query = select(DeviceGroup)
    if room_id is not None:
        query = query.where(DeviceGroup.room_id == room_id)
    return [
        group_read(g)
        for g in session.scalars(query.order_by(DeviceGroup.id).offset(offset).limit(limit)).all()
    ]


@router.get("/groups/{group_id}", response_model=GroupRead, tags=["Groups"])
def read_group(group_id: int, session: Session = Depends(get_session)):
    return group_read(get_or_404(session, DeviceGroup, group_id))


@router.patch("/groups/{group_id}", response_model=GroupRead, tags=["Groups"])
def edit_group(group_id: int, body: GroupPatch, session: Session = Depends(get_session)):
    group = get_or_404(session, DeviceGroup, group_id)
    room_id = body.room_id if body.room_id is not None else group.room_id
    ids = body.device_ids if body.device_ids is not None else [m.device_id for m in group.members]
    validate_group_change(session, group, room_id, ids)
    group.room_id = room_id
    if body.name is not None:
        group.name = body.name
    if body.device_ids is not None:
        existing = {m.device_id: m for m in group.members}
        group.members = [existing.get(id) or GroupMember(device_id=id) for id in ids]
        for i, member in enumerate(group.members):
            member.position = i
    commit(session)
    return group_read(group)


@router.delete("/groups/{group_id}", status_code=204, tags=["Groups"])
def delete_group(group_id: int, session: Session = Depends(get_session)):
    session.delete(get_or_404(session, DeviceGroup, group_id))
    commit(session)
    return Response(status_code=204)


@router.get("/groups/{group_id}/state", tags=["Groups"])
def read_group_state(group_id: int, session: Session = Depends(get_session)):
    return group_state(session, get_or_404(session, DeviceGroup, group_id))


@router.post("/groups/{group_id}/commands/{command}", tags=["Groups"])
def group_command(
    group_id: int, command: str, request: Request, session: Session = Depends(get_session)
):
    if command not in {"on", "off"}:
        raise HTTPException(422, "Group command must be on or off")
    group = get_or_404(session, DeviceGroup, group_id)
    # Validate every member before sending the first command. Runtime failures are per-device.
    commands = [(get_or_404(session, Device, m.device_id), None) for m in group.members]
    prepared = [
        (item, capability_dps(session, item, "switch", command == "on")) for item, _ in commands
    ]
    results = []
    for item, dps in prepared:
        try:
            result = run_command(request, session, item, command, dps)
            results.append(
                {
                    "device_id": item.id,
                    "acknowledged": True,
                    "result": result.model_dump(mode="json"),
                }
            )
        except HTTPException as exc:
            session.rollback()
            results.append(
                {
                    "device_id": item.id,
                    "acknowledged": False,
                    "error_status": exc.status_code,
                    "error": "Command failed; physical outcome may be unknown",
                }
            )
    return {
        "group_id": group.id,
        "command": command,
        "all_acknowledged": all(r["acknowledged"] for r in results),
        "results": results,
    }


@router.get("/displays", response_model=list[DisplayRead], tags=["Displays"])
def list_displays(session: Session = Depends(get_session)):
    return [display_read(d) for d in session.scalars(select(Display).order_by(Display.id)).all()]


@router.get("/displays/{display_id}", response_model=DisplayRead, tags=["Displays"])
def read_display(display_id: DisplayID, session: Session = Depends(get_session)):
    return display_read(get_or_404(session, Display, display_id))


@router.put("/displays/{display_id}", response_model=DisplayRead, tags=["Displays"])
def save_display(
    display_id: DisplayID, body: DisplayConfig, session: Session = Depends(get_session)
):
    selected_devices(session, body.room_id, body.widgets)
    item = session.get(Display, display_id)
    if item is None:
        item = Display(id=display_id)
        session.add(item)
    # Reuse positions to avoid INSERT-before-DELETE conflicts with SQLAlchemy flush order.
    existing = {w.position: w for w in item.widgets}
    widgets = []
    for i, w in enumerate(body.widgets):
        row = existing.get(i) or DisplayWidget(position=i)
        row.device_id = w.id if w.kind == "device" else None
        row.group_id = w.id if w.kind == "group" else None
        row.capabilities = list(w.capabilities)
        widgets.append(row)
    item.name, item.room_id, item.widgets = body.name, body.room_id, widgets
    commit(session)
    return display_read(item)


@router.delete("/displays/{display_id}", status_code=204, tags=["Displays"])
def delete_display(display_id: DisplayID, session: Session = Depends(get_session)):
    session.delete(get_or_404(session, Display, display_id))
    commit(session)
    return Response(status_code=204)


@router.get("/displays/{display_id}/options", tags=["Displays"])
def display_options(
    display_id: DisplayID,
    room_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(24, ge=1, le=24),
    session: Session = Depends(get_session),
):
    get_or_404(session, Room, room_id)
    devices = session.scalars(
        select(Device)
        .where(Device.room_id == room_id)
        .order_by(Device.id)
        .offset(offset)
        .limit(limit + 1)
    ).all()
    groups = session.scalars(
        select(DeviceGroup).where(DeviceGroup.room_id == room_id).order_by(DeviceGroup.id)
    ).all()
    return {
        "room_id": room_id,
        "devices": [device_card(session, d) for d in devices[:limit]],
        "groups": [group_read(g).model_dump() for g in groups],
        "offset": offset,
        "more_devices": len(devices) > limit,
    }


@router.get("/displays/{display_id}/dashboard", tags=["Displays"])
def read_dashboard(display_id: DisplayID, session: Session = Depends(get_session)):
    return dashboard(session, get_or_404(session, Display, display_id))


@router.post("/displays/{display_id}/refresh", status_code=202, tags=["Displays"])
def refresh_display(
    display_id: DisplayID, request: Request, session: Session = Depends(get_session)
):
    get_or_404(session, Display, display_id)
    request.app.state.poller.request_refresh(display_id)
    return {"accepted": True, "display_id": display_id, "status": "queued"}
