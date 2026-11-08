"""Explicit, account-scoped Smart Life topology sync. No device commands or imports."""

import hashlib
import re
import threading
import time
from datetime import timezone

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .api_dependencies import get_session
from .cloud_api import router
from .cloud_scope import scope_for
from .models import (
    Building,
    CloudHome,
    CloudPlacement,
    CloudRoom,
    CloudTopology,
    Device,
    Room,
    utcnow,
)
from .schemas import DevicePatch
from .service import patch_device

MAX_DEVICES = 2000
MAX_ROOMS_PER_HOME = 500
MAX_SECONDS = 300
ROOM_LOOKUP_RETRY_SECONDS = 60
ROOM_LOOKUPS_PER_READ = 4


def external_id(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("Invalid identifier")
    value = str(value)
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", value):
        raise ValueError("Invalid identifier")
    return value


def title(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 120:
        raise ValueError("Invalid name")
    return value.strip()


def timestamp(value):
    return value.replace(tzinfo=timezone.utc).isoformat() if value else None


def cached(session, scope):
    homes = session.scalars(
        select(CloudHome).where(CloudHome.scope == scope, CloudHome.active)
    ).all()
    buildings = {h.home_id: h.building_id for h in homes if h.building_id is not None}
    rooms = session.scalars(select(CloudRoom).where(CloudRoom.scope == scope)).all()
    room_ids = {
        (r.home_id, r.room_id): r.local_room_id
        for r in rooms
        if r.home_id in buildings
        and r.local_room_id is not None
        and (local := session.get(Room, r.local_room_id)) is not None
        and local.building_id == buildings[r.home_id]
    }
    placements = session.scalars(select(CloudPlacement).where(CloudPlacement.scope == scope)).all()
    state = session.get(CloudTopology, scope)
    return {
        "synced_at": timestamp(state.synced_at) if state else None,
        "warnings": state.warnings if state else 0,
        "empty_rooms_available": False,
        "homes": [
            {"home_id": h.home_id, "building_id": h.building_id, "name": h.name} for h in homes
        ],
        "placements": [
            {
                "device_id": p.device_id,
                "home_id": p.home_id,
                "cloud_room_id": p.room_id,
                "building_id": buildings[p.home_id],
                "room_id": room_ids.get((p.home_id, p.room_id)),
            }
            for p in placements
            if p.home_id in buildings
        ],
    }


def room_name(session, building_id, name, identity, own_id=None):
    # Never merge distinct Tuya rooms or a manually created room just because names match.
    query = select(Room).where(Room.building_id == building_id, Room.name == name)
    if own_id is not None:
        query = query.where(Room.id != own_id)
    if session.scalar(query) is None:
        return name
    suffix = hashlib.sha256(identity.encode()).hexdigest()[:8]
    candidate = name[:105] + " · " + suffix
    number = 1
    while session.scalar(
        select(Room).where(
            Room.building_id == building_id, Room.name == candidate, Room.id != own_id
        )
    ):
        number += 1
        candidate = name[:99] + " · " + suffix + f"-{number}"
    return candidate


def read_developer_rooms(developer, home_id):
    if developer is None:
        return None
    with developer.lock:
        if developer.client is None:
            return None
        try:
            result = developer.client.request("GET", f"/v1.0/homes/{home_id}/rooms")
            if external_id(result["home_id"]) != home_id:
                return None
            rows = result["rooms"]
            if not isinstance(rows, list) or len(rows) > MAX_ROOMS_PER_HOME:
                return None
            rooms = {external_id(row["room_id"]): title(row["name"]) for row in rows}
            return rooms if len(rooms) == len(rows) else None
        except (KeyError, TypeError, ValueError, OSError, HTTPException):
            return None


def discover_device_placements(session, bridge, scope, device_ids):
    """Resolve newly seen devices against imported rooms without creating rooms."""
    topology = cached(session, scope)
    homes = {home["home_id"] for home in topology["homes"]}
    if not homes:
        return {}
    placements = {row["device_id"]: row for row in topology["placements"]}
    now = time.monotonic()
    new_ids = [
        device_id for device_id in device_ids
        if device_id not in placements and bridge.next_room_lookup.get(device_id, 0) <= now
    ]
    bridge.next_room_lookup = {
        device_id: until for device_id, until in bridge.next_room_lookup.items()
        if until > now and device_id not in placements
    }
    if new_ids:
        read_room = getattr(bridge._manager(), "query_room_by_device", None)
        if read_room:
            try:
                added = match_device_rooms(session, bridge, scope, homes, new_ids[:ROOM_LOOKUPS_PER_READ], read_room)
                if added:
                    session.commit()
                    placements = {row["device_id"]: row for row in cached(session, scope)["placements"]}
            except SQLAlchemyError:
                session.rollback()
    return placements


def match_device_rooms(session, bridge, scope, homes, device_ids, read_room):
    known_rooms = {}
    for mapping in session.scalars(select(CloudRoom).where(
        CloudRoom.scope == scope, CloudRoom.home_id.in_(homes),
    )):
        known_rooms.setdefault(mapping.room_id, []).append(mapping.home_id)
    added = False
    for device_id in device_ids:
        bridge.next_room_lookup[device_id] = time.monotonic() + ROOM_LOOKUP_RETRY_SECONDS
        try:
            device_id = external_id(device_id)
        except ValueError:
            continue
        try:
            reported = read_room(device_id)
            room_id = external_id(reported.id) if reported else None
        except Exception:
            break  # Retry on a later inventory read without delaying other device controls.
        matching_homes = known_rooms.get(room_id, [])
        if len(matching_homes) == 1:
            home_id = matching_homes[0]
        elif len(homes) == 1:
            home_id = next(iter(homes))
        else:
            continue  # Sharing supplies a room ID but no home ID for this lookup.
        session.merge(CloudPlacement(scope=scope, device_id=device_id, home_id=home_id, room_id=room_id))
        added = True
    return added


def apply_snapshot(session, scope, homes, room_names, devices):
    """One transaction after network reads; missing rooms never mean delete local objects."""
    home_maps = {
        h.home_id: h for h in session.scalars(select(CloudHome).where(CloudHome.scope == scope))
    }
    room_maps = {
        (r.home_id, r.room_id): r
        for r in session.scalars(select(CloudRoom).where(CloudRoom.scope == scope))
    }
    warnings = 0
    for mapping in home_maps.values():
        mapping.active = False
    for home_id, name in homes.items():
        mapping = home_maps.get(home_id)
        building = (
            session.get(Building, mapping.building_id) if mapping and mapping.building_id else None
        )
        if building is None:
            building = Building(name=name)
            session.add(building)
            session.flush()
        elif building.name == mapping.name:
            building.name = name
        if mapping is None:
            mapping = CloudHome(scope=scope, home_id=home_id)
            session.add(mapping)
            home_maps[home_id] = mapping
        mapping.building_id, mapping.name, mapping.active = building.id, name, True
    for key, name in room_names.items():
        home_id, room_id = key
        mapping = room_maps.get(key)
        local = (
            session.get(Room, mapping.local_room_id) if mapping and mapping.local_room_id else None
        )
        building_id = home_maps[home_id].building_id
        follow_name = (
            local is None or local.building_id != building_id or local.name == mapping.imported_name
        )
        if local is None or local.building_id != building_id:
            local = Room(
                building_id=building_id,
                name=room_name(session, building_id, name, ":".join(key)),
            )
            session.add(local)
            session.flush()
        elif follow_name:
            candidate = room_name(session, building_id, name, ":".join(key), local.id)
            local.name = candidate
        if mapping is None:
            mapping = CloudRoom(scope=scope, home_id=home_id, room_id=room_id)
            session.add(mapping)
            room_maps[key] = mapping
        mapping.local_room_id, mapping.name = local.id, name
        if follow_name:
            mapping.imported_name = local.name
    old = {
        p.device_id: p
        for p in session.scalars(select(CloudPlacement).where(CloudPlacement.scope == scope))
    }
    # Parents first; validation still protects gateway/child and group/display constraints.
    locals_by_id = {
        d.device_id: d for d in session.scalars(select(Device).where(Device.device_id.in_(devices)))
    }
    ordered = sorted(
        devices.items(),
        key=lambda entry: bool(locals_by_id.get(entry[0]) and locals_by_id[entry[0]].parent_id),
    )
    for device_id, row in ordered:
        mapping = old.pop(device_id, None)
        if mapping is None:
            mapping = CloudPlacement(scope=scope, device_id=device_id, managed=False)
            session.add(mapping)
        mapping.home_id = row["home_id"]
        mapping.room_id = row["room"]["id"] if row["room"] else None
        local_room = room_maps.get((mapping.home_id, mapping.room_id))
        desired = (home_maps[mapping.home_id].building_id, local_room.local_room_id if local_room else None)
        item = locals_by_id.get(device_id)
        if item:
            current = (item.building_id, item.room_id)
            previous = (mapping.applied_building_id, mapping.applied_room_id)
            if not mapping.overridden and (
                (mapping.managed and current == previous)
                or (not mapping.managed and current in ((None, None), desired))
            ):
                try:
                    with session.begin_nested():
                        patch_device(
                            session, item, DevicePatch(building_id=desired[0], room_id=desired[1])
                        )
                        session.flush()
                    mapping.managed = True
                    mapping.applied_building_id, mapping.applied_room_id = desired
                except HTTPException:
                    warnings += 1
            elif current != desired:
                mapping.managed = False
                mapping.overridden = True
                warnings += 1
    for mapping in old.values():
        session.delete(mapping)
    state = session.get(CloudTopology, scope) or CloudTopology(scope=scope)
    state.synced_at, state.warnings = utcnow(), warnings
    session.add(state)
    session.commit()


class TopologySync:
    def __init__(self):
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.scope = None
        self.job = {"status": "idle", "processed": 0, "total": 0, "message": None}

    def view(self, scope):
        with self.lock:
            return (
                dict(self.job)
                if scope == self.scope
                else {"status": "idle", "processed": 0, "total": 0, "message": None}
            )

    def update(self, **values):
        with self.lock:
            self.job.update(values)

    def start(self, bridge, engine, developer=None):
        with bridge.lock:
            scope = scope_for(bridge, "sharing")
            authorization = bridge.auth
            with self.lock:
                if self.thread and self.thread.is_alive():
                    if self.scope != scope:
                        raise HTTPException(
                            409, "Previous topology sync is stopping; retry shortly"
                        )
                    return dict(self.job)
                self.scope = scope
                self.job = {"status": "running", "processed": 0, "total": 0, "message": None}
                self.thread = threading.Thread(
                    target=self.run,
                    args=(bridge, engine, scope, authorization, developer),
                    daemon=True,
                    name="smart-life-topology",
                )
                self.thread.start()
                return dict(self.job)

    def run(self, bridge, engine, scope, authorization, developer):
        deadline = time.monotonic() + MAX_SECONDS

        def guard():
            if (
                self.stop_event.is_set()
                or time.monotonic() > deadline
                or bridge.auth is not authorization
                or scope_for(bridge, "sharing") != scope
            ):
                raise ValueError("Sync expired or account changed")

        def query(path, params=None):
            # Release the account lock between requests so selected-device controls can proceed.
            with bridge.lock:
                guard()
                result = bridge._manager().customer_api.get(path, params)
                if not isinstance(result, dict) or result.get("success") is not True:
                    raise ValueError("Cloud request failed")
                return result.get("result")

        try:
            home_rows = query("/v1.0/m/life/users/homes")
            if not isinstance(home_rows, list) or len(home_rows) > 100:
                raise ValueError("Invalid home list")
            homes, devices, catalogs = {}, {}, {}
            for row in home_rows:
                home_id = external_id(row["ownerId"])
                if home_id in homes:
                    raise ValueError("Duplicate home")
                homes[home_id] = title(row["name"])
                catalog = read_developer_rooms(developer, home_id)
                if catalog is not None:
                    catalogs[home_id] = catalog
                rows = query("/v1.0/m/life/ha/home/devices", {"homeId": home_id})
                if not isinstance(rows, list):
                    raise ValueError("Invalid device list")
                for device in rows:
                    device_id = external_id(device["id"])
                    if device_id in devices:
                        raise ValueError("Ambiguous device home")
                    devices[device_id] = {"home_id": home_id, "room": None}
                    if len(devices) > MAX_DEVICES:
                        raise ValueError("Too many devices")
            self.update(total=len(devices))
            for index, (device_id, row) in enumerate(devices.items(), 1):
                room = query(f"/v1.0/m/thing/ha/{device_id}/room")
                # Sharing returns an empty string for some unassigned devices.
                if room is not None and room != "" and room != {}:
                    row["room"] = {"id": external_id(room["id"]), "name": title(room["name"])}
                self.update(processed=index)
                # Give concurrent UI reads a chance to acquire the account lock.
                if self.stop_event.wait(0.01):
                    raise ValueError("Sync stopped")
            room_names = {
                (home_id, room_id): name
                for home_id, catalog in catalogs.items()
                for room_id, name in catalog.items()
            }
            for row in devices.values():
                if row["room"] and row["home_id"] not in catalogs:
                    key = (row["home_id"], row["room"]["id"])
                    name = row["room"]["name"]
                    if key in room_names and room_names[key] != name:
                        raise ValueError("Room changed during sync; retry")
                    room_names[key] = name
            with bridge.lock:
                guard()
                with Session(engine) as session:
                    apply_snapshot(session, scope, homes, room_names, devices)
            self.update(status="done", empty_rooms_available=bool(homes) and len(catalogs) == len(homes))
        except Exception:
            # Cloud exceptions can include credentials and raw responses. Never publish them.
            self.update(
                status="failed",
                message="Не удалось синхронизировать Smart Life. Предыдущая структура сохранена; проверьте подключение и повторите.",
            )

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=1)


@router.get("/topology")
def get_topology(request: Request, response: Response, session: Session = Depends(get_session)):
    bridge = request.app.state.cloud
    with bridge.lock:
        scope = scope_for(bridge, "sharing")
        result = cached(session, scope)
    job = request.app.state.topology.view(scope)
    result["empty_rooms_available"] = job.pop("empty_rooms_available", False)
    response.headers["Cache-Control"] = "no-store"
    return {**result, "job": job}


@router.post("/topology/sync", status_code=202)
def sync_topology(request: Request):
    state = request.app.state
    return state.topology.start(state.cloud, state.engine, state.developer_cloud)
