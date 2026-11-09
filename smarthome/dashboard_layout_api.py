from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import BaseModel, Field, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import Account, authenticate, get_session, require_account
from .db import lock_writes, upsert
from .models import AccountDashboardLayout, DashboardLayout, HouseholdMember, Room
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


class AccountView(LayoutView):
    browser_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")


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


def layout_slots(layout: DashboardLayout | AccountDashboardLayout | None):
    if layout is None:
        return LayoutSlots(slots=[])
    if layout.hidden_devices:
        return LayoutSlots(slots=layout.slots, hidden_devices=layout.hidden_devices)
    return LayoutSlots(slots=layout.slots)


def lock_member_layout(session: Session, account: Account):
    if account.role == "member":
        # Serialize the membership recheck with revocation before writing any layout.
        lock_writes(session)
        if session.get(HouseholdMember, account.id) is None:
            raise HTTPException(401, "Missing or invalid X-API-Key")


def write_account_layout(session: Session, account: Account, view: str, changes: dict):
    statement = upsert(session.get_bind(), AccountDashboardLayout).values(account_id=account.id, view=view, **changes)
    session.execute(statement.on_conflict_do_update(
        index_elements=[AccountDashboardLayout.account_id, AccountDashboardLayout.view],
        set_=changes,
    ))
    commit(session)


@router.get("/me", response_model=LayoutSlots, response_model_exclude_unset=True, tags=["Dashboard layouts"])
def read_account_layout(
    view: Annotated[AccountView, Query()],
    response: Response,
    account: Account = Depends(require_account),
    session: Session = Depends(get_session),
):
    response.headers["Cache-Control"] = "no-store"
    layout = session.get(AccountDashboardLayout, (account.id, view.key))
    if layout is None and account.role == "owner" and view.browser_id:
        layout = session.get(DashboardLayout, (view.browser_id, view.key))
    return layout_slots(layout)


@router.put("/me", response_model=LayoutSlots, response_model_exclude_unset=True, tags=["Dashboard layouts"])
def save_account_layout(
    view: Annotated[AccountView, Query()],
    body: LayoutSlots,
    response: Response,
    account: Account = Depends(require_account),
    session: Session = Depends(get_session),
):
    lock_member_layout(session, account)
    write_account_layout(session, account, view.key, body.model_dump(exclude_unset=True))
    return read_account_layout(view, response, account, session)


@router.get("/{browser_id}", response_model=LayoutSlots, response_model_exclude_unset=True, tags=["Dashboard layouts"])
def read_layout(
    browser_id: BrowserID, view: Annotated[LayoutView, Query()], session: Session = Depends(get_session)
):
    return layout_slots(session.get(DashboardLayout, (browser_id, view.key)))


@router.put("/{browser_id}", response_model=LayoutSlots, response_model_exclude_unset=True, tags=["Dashboard layouts"])
def save_layout(
    browser_id: BrowserID,
    view: Annotated[LayoutView, Query()],
    body: LayoutSlots,
    session: Session = Depends(get_session),
):
    write_layout(session, browser_id, view.key, body.model_dump(exclude_unset=True))
    return read_layout(browser_id, view, session)


def room_navigation(layout: DashboardLayout | AccountDashboardLayout | None):
    rooms = []
    for slot in layout.slots if layout else []:
        if slot is not None:
            kind, room_id = slot.split(":", 1)
            rooms.append(RoomNavigationEntry(id=int(room_id), hidden=kind == "hidden"))
    return RoomNavigationLayout(rooms=rooms)


def remove_room_from_navigation(session: Session, room_id: int):
    # SQLite can reuse a deleted room ID, so remove its preference with the room.
    removed_slots = {f"room:{room_id}", f"hidden:{room_id}"}
    for model in (DashboardLayout, AccountDashboardLayout):
        layouts = session.scalars(select(model).where(model.view == ROOM_NAVIGATION_VIEW))
        for layout in layouts:
            if any(slot in removed_slots for slot in layout.slots):
                layout.slots = [slot for slot in layout.slots if slot not in removed_slots]


def navigation_slots(session: Session, body: RoomNavigationLayout):
    existing = set(session.scalars(select(Room.id).where(Room.id.in_([room.id for room in body.rooms]))))
    return [f"{'hidden' if room.hidden else 'room'}:{room.id}" for room in body.rooms if room.id in existing]


@router.get("/me/room-navigation", response_model=RoomNavigationLayout, tags=["Dashboard layouts"])
def read_account_navigation(
    response: Response, account: Account = Depends(require_account), session: Session = Depends(get_session),
):
    response.headers["Cache-Control"] = "no-store"
    return room_navigation(session.get(AccountDashboardLayout, (account.id, ROOM_NAVIGATION_VIEW)))


@router.put("/me/room-navigation", response_model=RoomNavigationLayout, tags=["Dashboard layouts"])
def save_account_navigation(
    body: RoomNavigationLayout, response: Response,
    account: Account = Depends(require_account), session: Session = Depends(get_session),
):
    lock_member_layout(session, account)
    write_account_layout(session, account, ROOM_NAVIGATION_VIEW, {"slots": navigation_slots(session, body)})
    return read_account_navigation(response, account, session)


@router.get("/{browser_id}/room-navigation", response_model=RoomNavigationLayout, tags=["Dashboard layouts"])
def read_room_navigation(browser_id: BrowserID, session: Session = Depends(get_session)):
    return room_navigation(session.get(DashboardLayout, (browser_id, ROOM_NAVIGATION_VIEW)))


@router.put("/{browser_id}/room-navigation", response_model=RoomNavigationLayout, tags=["Dashboard layouts"])
def save_room_navigation(
    browser_id: BrowserID, body: RoomNavigationLayout, session: Session = Depends(get_session)
):
    write_layout(session, browser_id, ROOM_NAVIGATION_VIEW, {"slots": navigation_slots(session, body)})
    return read_room_navigation(browser_id, session)
