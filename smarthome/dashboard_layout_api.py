from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel, Field, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .db import upsert
from .models import DashboardLayout, Room
from .service import commit

router = APIRouter(prefix="/api/v1/dashboard-layouts", dependencies=[Depends(authenticate)])

BrowserID = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
CardID = Annotated[str, StringConstraints(pattern=r"^(device|group|combined)-.+$", max_length=140)]
DeviceCardID = Annotated[str, StringConstraints(pattern=r"^device-.+$", max_length=140)]
ROOM_NAVIGATION_VIEW = "room-navigation"


class LayoutView(BaseModel):
    building: str = Field(default="all", pattern=r"^(all|[1-9][0-9]{0,15})$")
    room: str = Field(default="all", pattern=r"^(all|none|[1-9][0-9]{0,15})$")
    columns: int = Field(ge=1, le=24)
    page: int = Field(ge=1, le=10000)

    @property
    def key(self) -> str:
        return f"{self.building}/{self.room}/{self.columns}/{self.page}"


class LayoutSlots(BaseModel):
    slots: list[CardID | None] = Field(max_length=96)
    hidden_devices: list[DeviceCardID] = Field(default_factory=list, max_length=96)

    @model_validator(mode="after")
    def unique_cards(self):
        occupied = [card for card in self.slots if card is not None]
        if len(set(occupied)) != len(occupied):
            raise ValueError("A card can only occupy one slot")
        if len(set(self.hidden_devices)) != len(self.hidden_devices):
            raise ValueError("A device can only be hidden once")
        return self


class RoomNavigationEntry(BaseModel):
    id: int = Field(strict=True, ge=1, le=2**53 - 1)
    hidden: bool = Field(default=False, strict=True)


class RoomNavigationLayout(BaseModel):
    rooms: list[RoomNavigationEntry] = Field(max_length=500)

    @model_validator(mode="after")
    def unique_rooms(self):
        if len({room.id for room in self.rooms}) != len(self.rooms):
            raise ValueError("A room can only appear once")
        return self


def write_layout(session: Session, browser_id: str, view: str, changes: dict):
    statement = upsert(session.get_bind(), DashboardLayout).values(browser_id=browser_id, view=view, **changes)
    session.execute(statement.on_conflict_do_update(
        index_elements=[DashboardLayout.browser_id, DashboardLayout.view],
        set_=changes,
    ))
    commit(session)


@router.get("/{browser_id}", response_model=LayoutSlots, response_model_exclude_unset=True, tags=["Dashboard layouts"])
def read_layout(
    browser_id: BrowserID, view: Annotated[LayoutView, Query()], session: Session = Depends(get_session)
):
    layout = session.get(DashboardLayout, (browser_id, view.key))
    if layout is None:
        return LayoutSlots(slots=[])
    return LayoutSlots(slots=layout.slots, hidden_devices=layout.hidden_devices) if layout.hidden_devices else LayoutSlots(slots=layout.slots)


@router.put("/{browser_id}", response_model=LayoutSlots, response_model_exclude_unset=True, tags=["Dashboard layouts"])
def save_layout(
    browser_id: BrowserID,
    view: Annotated[LayoutView, Query()],
    body: LayoutSlots,
    session: Session = Depends(get_session),
):
    write_layout(session, browser_id, view.key, body.model_dump(exclude_unset=True))
    return read_layout(browser_id, view, session)


@router.get("/{browser_id}/room-navigation", response_model=RoomNavigationLayout, tags=["Dashboard layouts"])
def read_room_navigation(browser_id: BrowserID, session: Session = Depends(get_session)):
    layout = session.get(DashboardLayout, (browser_id, ROOM_NAVIGATION_VIEW))
    rooms = []
    for slot in layout.slots if layout else []:
        if slot is not None:
            kind, room_id = slot.split(":", 1)
            rooms.append(RoomNavigationEntry(id=int(room_id), hidden=kind == "hidden"))
    return RoomNavigationLayout(rooms=rooms)


def remove_room_from_navigation(session: Session, room_id: int):
    # SQLite can reuse a deleted room ID, so remove its preference with the room.
    removed_slots = {f"room:{room_id}", f"hidden:{room_id}"}
    layouts = session.scalars(select(DashboardLayout).where(DashboardLayout.view == ROOM_NAVIGATION_VIEW))
    for layout in layouts:
        if any(slot in removed_slots for slot in layout.slots):
            layout.slots = [slot for slot in layout.slots if slot not in removed_slots]


@router.put("/{browser_id}/room-navigation", response_model=RoomNavigationLayout, tags=["Dashboard layouts"])
def save_room_navigation(
    browser_id: BrowserID, body: RoomNavigationLayout, session: Session = Depends(get_session)
):
    # This reserved view key cannot collide with a card layout's building/room/columns/page key.
    existing = set(session.scalars(select(Room.id).where(Room.id.in_([room.id for room in body.rooms]))))
    rooms = [room for room in body.rooms if room.id in existing]
    slots = [f"{'hidden' if room.hidden else 'room'}:{room.id}" for room in rooms]
    write_layout(session, browser_id, ROOM_NAVIGATION_VIEW, {"slots": slots})
    return RoomNavigationLayout(rooms=rooms)
