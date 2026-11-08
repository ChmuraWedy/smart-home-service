"""Persistent dashboard combinations with aggregate control across Tuya routes."""

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .cloud_api import CloudCommand, cloud_bridge, execute_cloud_commands
from .cloud_mappings import scope_for
from .control import run_command
from .models import CombinedDevice, Device, Room
from .schemas import Identifier, Name, PositiveID, Schema
from .service import capability_values_dps, commit, effective_capabilities, get_or_404

router = APIRouter(
    prefix="/api/v1/combined-devices",
    tags=["Combined devices"],
    dependencies=[Depends(authenticate)],
)
POWER_CODE = re.compile(r"switch(?:_led|_[1-9][0-9]*)?")


class Member(Schema):
    device_id: Identifier
    route: Literal["local", "sharing", "developer"]


class CombinedInput(Schema):
    name: Name
    room_id: PositiveID | None = None
    members: list[Member] = Field(min_length=2, max_length=16)

    @field_validator("members")
    @classmethod
    def distinct_members(cls, value):
        if len({member.device_id for member in value}) != len(value):
            raise ValueError("Combined members must be unique physical devices")
        return value


class CombinedMember(Member):
    accessible: bool


class CombinedRead(Schema):
    id: PositiveID
    name: Name
    room_id: PositiveID | None
    members: list[CombinedMember]


class PowerResult(Schema):
    device_id: Identifier
    outcome: Literal["accepted", "unavailable", "unsupported", "unknown"]


class CombinedPowerResult(Schema):
    results: list[PowerResult]


def local_device(session, identifier):
    return session.scalar(select(Device).where(Device.device_id == identifier))


def account_scope(request, route):
    bridge = cloud_bridge(request, route)
    with bridge.lock:
        return scope_for(bridge, route)


def read_combination(request, item, scopes):
    members = []
    for member in item.members:
        route = member["route"]
        if route != "local" and route not in scopes:
            try:
                scopes[route] = account_scope(request, route)
            except HTTPException:
                scopes[route] = None
        accessible = route == "local" or scopes[route] == member["scope"]
        members.append(CombinedMember(device_id=member["device_id"], route=route, accessible=accessible))
    return CombinedRead(id=item.id, name=item.name, room_id=item.room_id, members=members)


def configure_combination(session, request, item, body):
    if body.room_id is not None:
        get_or_404(session, Room, body.room_id)
    existing = {(m["device_id"], m["route"]): m for m in item.members or []}
    members = []
    for member in body.members:
        key = (member.device_id, member.route)
        if key in existing:
            members.append(existing[key])
            continue
        if member.route == "local":
            if local_device(session, member.device_id) is None:
                raise HTTPException(404, "Device not found")
            scope = None
        else:
            bridge = cloud_bridge(request, member.route)
            with bridge.lock:
                scope = scope_for(bridge, member.route)
                bridge.device(member.device_id)
        members.append({**member.model_dump(), "scope": scope})
    item.name, item.room_id, item.members = body.name.strip(), body.room_id, members


@router.get("", response_model=list[CombinedRead])
def list_combined(request: Request, session: Session = Depends(get_session)):
    scopes = {}
    items = session.scalars(select(CombinedDevice).order_by(CombinedDevice.id))
    return [read_combination(request, item, scopes) for item in items]


@router.post("", status_code=201, response_model=CombinedRead)
def create_combined(body: CombinedInput, request: Request, session: Session = Depends(get_session)):
    item = CombinedDevice()
    configure_combination(session, request, item, body)
    session.add(item)
    commit(session)
    return read_combination(request, item, {})


@router.put("/{item_id}", response_model=CombinedRead)
def update_combined(
    item_id: PositiveID, body: CombinedInput, request: Request, session: Session = Depends(get_session)
):
    item = get_or_404(session, CombinedDevice, item_id)
    configure_combination(session, request, item, body)
    commit(session)
    return read_combination(request, item, {})


@router.delete("/{item_id}", status_code=204)
def delete_combined(item_id: PositiveID, session: Session = Depends(get_session)):
    session.delete(get_or_404(session, CombinedDevice, item_id))
    commit(session)
    return Response(status_code=204)


def local_power(request, session, identifier, value):
    item = local_device(session, identifier)
    if item is None or not item.enabled:
        return "unavailable"
    values = {
        key: value
        for key, spec in effective_capabilities(session, item).items()
        if POWER_CODE.fullmatch(key) and spec["type"] == "boolean" and spec.get("writable", True)
    }
    if not values or len(values) > 16:
        return "unsupported"
    dps = capability_values_dps(session, item, values)
    result = run_command(request, session, item, "capabilities", dps)
    return "accepted" if result.acknowledged else "unknown"


def cloud_power(request, member, value):
    route = member["route"]
    bridge = cloud_bridge(request, route)
    with bridge.lock:
        if scope_for(bridge, route) != member["scope"]:
            return "unavailable"
        device = bridge.writable_device(member["device_id"])
        if not device.online:
            return "unavailable"
        commands = [
            CloudCommand(code=code, value=value)
            for code, spec in device.function.items()
            if POWER_CODE.fullmatch(code) and spec.type == "Boolean"
        ]
        if not commands or len(commands) > 16:
            return "unsupported"
        result = execute_cloud_commands(request, bridge, route, device, commands)
        return "accepted" if result.get("acknowledged") else "unknown"


@router.post("/{item_id}/power/{command}", response_model=CombinedPowerResult)
def combined_power(
    item_id: PositiveID,
    command: Literal["on", "off"],
    request: Request,
    session: Session = Depends(get_session),
):
    members = get_or_404(session, CombinedDevice, item_id).members
    # Release the SQLite read transaction before doing network I/O or recording commands.
    session.commit()
    results = []
    for member in members:
        identifier = member["device_id"]
        try:
            if member["route"] == "local":
                outcome = local_power(request, session, identifier, command == "on")
            else:
                outcome = cloud_power(request, member, command == "on")
        except HTTPException as error:
            session.rollback()
            outcome = "unavailable" if error.status_code in {403, 404, 409, 503} else "unknown"
        results.append(PowerResult(device_id=identifier, outcome=outcome))
    return CombinedPowerResult(results=results)
