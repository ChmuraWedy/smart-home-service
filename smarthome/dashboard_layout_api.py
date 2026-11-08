from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from pydantic import BaseModel, Field, StringConstraints, model_validator
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .models import DashboardLayout
from .service import commit

router = APIRouter(prefix="/api/v1/dashboard-layouts", dependencies=[Depends(authenticate)])

BrowserID = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
CardID = Annotated[str, StringConstraints(pattern=r"^(device|group|combined)-.+$", max_length=140)]
DeviceCardID = Annotated[str, StringConstraints(pattern=r"^device-.+$", max_length=140)]


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
    changes = body.model_dump(exclude_unset=True)
    statement = insert(DashboardLayout).values(browser_id=browser_id, view=view.key, **changes)
    session.execute(statement.on_conflict_do_update(
        index_elements=[DashboardLayout.browser_id, DashboardLayout.view],
        set_=changes,
    ))
    commit(session)
    return read_layout(browser_id, view, session)
