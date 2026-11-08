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


class PowerSource(Schema):
    device_id: Identifier
    channel: str = Field(pattern=r"^switch(?:_[1-9][0-9]*)?$", max_length=32)


class Member(Schema):
    device_id: Identifier
    route: Literal["local", "sharing", "developer"]
    power_source: PowerSource | None = None


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
        wiring = {"power_source": member["power_source"]} if "power_source" in member else {}
        members.append(CombinedMember(device_id=member["device_id"], route=route, accessible=accessible, **wiring))
    return CombinedRead(id=item.id, name=item.name, room_id=item.room_id, members=members)


def has_relay_channel(session, request, member, channel):
    identifier, route = member["device_id"], member["route"]
    if route == "local":
        device = local_device(session, identifier)
        spec = effective_capabilities(session, device).get(channel, {}) if device else {}
        return spec.get("type") == "boolean" and spec.get("writable", True)
    bridge = cloud_bridge(request, route)
    with bridge.lock:
        if scope_for(bridge, route) != member["scope"]:
            return False
        spec = bridge.writable_device(identifier).function.get(channel)
        return spec is not None and spec.type == "Boolean"


def validate_wiring(session, request, members, previous):
    by_id = {member["device_id"]: member for member in members}
    for member in members:
        source = member.get("power_source")
        if source is None:
            continue
        relay = by_id.get(source["device_id"])
        if relay is None:
            raise HTTPException(422, "The power source must be part of the combination.")
        seen = {member["device_id"]}
        upstream = source
        while upstream is not None:
            upstream_id = upstream["device_id"]
            if upstream_id in seen:
                raise HTTPException(422, "Wiring cannot form a loop.")
            seen.add(upstream_id)
            upstream = by_id.get(upstream_id, {}).get("power_source")
        before = previous.get(member["device_id"], {})
        prior_relay = previous.get(source["device_id"], {})
        if before.get("power_source") == source and all(
            relay[key] == prior_relay.get(key) for key in ("route", "scope")
        ):
            continue
        if not has_relay_channel(session, request, relay, source["channel"]):
            raise HTTPException(422, "The selected device does not expose that relay channel.")


def configure_combination(session, request, item, body):
    if body.room_id is not None:
        get_or_404(session, Room, body.room_id)
    existing = {member["device_id"]: member for member in item.members or []}
    selected = {member.device_id for member in body.members}
    members = []
    for member in body.members:
        previous = existing.get(member.device_id, {})
        if previous.get("route") == member.route:
            scope = previous["scope"]
        elif member.route == "local":
            if local_device(session, member.device_id) is None:
                raise HTTPException(404, "Device not found")
            scope = None
        else:
            bridge = cloud_bridge(request, member.route)
            with bridge.lock:
                scope = scope_for(bridge, member.route)
                bridge.device(member.device_id)
        stored = {"device_id": member.device_id, "route": member.route, "scope": scope}
        if "power_source" in member.model_fields_set:
            if member.power_source is not None:
                stored["power_source"] = member.power_source.model_dump()
        elif (source := previous.get("power_source")) and source["device_id"] in selected:
            stored["power_source"] = source
        members.append(stored)
    validate_wiring(session, request, members, existing)
    item.name, item.room_id, item.members = body.name.strip(), body.room_id, members


@router.get("", response_model=list[CombinedRead], response_model_exclude_unset=True)
def list_combined(request: Request, session: Session = Depends(get_session)):
    scopes = {}
    items = session.scalars(select(CombinedDevice).order_by(CombinedDevice.id))
    return [read_combination(request, item, scopes) for item in items]


@router.post("", status_code=201, response_model=CombinedRead, response_model_exclude_unset=True)
def create_combined(body: CombinedInput, request: Request, session: Session = Depends(get_session)):
    item = CombinedDevice()
    configure_combination(session, request, item, body)
    session.add(item)
    commit(session)
    return read_combination(request, item, {})


@router.put("/{item_id}", response_model=CombinedRead, response_model_exclude_unset=True)
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
