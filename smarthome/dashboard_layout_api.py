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
CardID = Annotated[str, StringConstraints(pattern=r"^(device|group)-.+$", max_length=140)]


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

    @model_validator(mode="after")
    def unique_cards(self):
        occupied = [card for card in self.slots if card is not None]
        if len(set(occupied)) != len(occupied):
            raise ValueError("A card can only occupy one slot")
        return self


@router.get("/{browser_id}", response_model=LayoutSlots, tags=["Dashboard layouts"])
def read_layout(
    browser_id: BrowserID, view: Annotated[LayoutView, Query()], session: Session = Depends(get_session)
):
    layout = session.get(DashboardLayout, (browser_id, view.key))
    return LayoutSlots(slots=layout.slots if layout else [])


@router.put("/{browser_id}", response_model=LayoutSlots, tags=["Dashboard layouts"])
def save_layout(
    browser_id: BrowserID,
    view: Annotated[LayoutView, Query()],
    body: LayoutSlots,
    session: Session = Depends(get_session),
):
    statement = insert(DashboardLayout).values(
        browser_id=browser_id, view=view.key, slots=body.slots
    )
    session.execute(statement.on_conflict_do_update(
        index_elements=[DashboardLayout.browser_id, DashboardLayout.view],
        set_={"slots": statement.excluded.slots},
    ))
    commit(session)
    return body
