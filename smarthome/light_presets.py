from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import Field, StringConstraints, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .models import LightPreset
from .schemas import Identifier, PositiveID, Schema
from .service import commit

router = APIRouter(
    prefix="/api/v1/light-presets", tags=["Light presets"], dependencies=[Depends(authenticate)]
)
Level = Annotated[int, Field(strict=True, ge=0, le=1000)]
Duration = Annotated[int, Field(strict=True, ge=0, le=100)]


class SceneUnit(Schema):
    h: Annotated[int, Field(strict=True, ge=0, le=360)]
    s: Level
    v: Level
    bright: Level
    temperature: Level
    unit_change_mode: Literal["static", "jump", "gradient"]
    unit_switch_duration: Duration
    unit_gradient_duration: Duration


class LightScene(Schema):
    scene_num: Annotated[int, Field(strict=True, ge=1, le=256)]
    scene_units: list[SceneUnit] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def consistent_steps(self):
        first = self.scene_units[0]
        if first.unit_change_mode == "static" and len(self.scene_units) != 1:
            raise ValueError("Static scenes require one step")
        for unit in self.scene_units:
            if (
                unit.unit_change_mode != first.unit_change_mode
                or unit.unit_switch_duration != first.unit_switch_duration
                or unit.unit_gradient_duration != first.unit_gradient_duration
                or ((unit.bright or unit.temperature) and (unit.h or unit.s or unit.v))
            ):
                raise ValueError("Preset steps must use one effect and timing, and either color or white")
        return self


class PresetInput(Schema):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    scene: LightScene
    tuya_scene_id: Identifier | None = None


class PresetRead(PresetInput):
    id: PositiveID


def find_preset(session, device_id, preset_id):
    item = session.scalar(select(LightPreset).filter_by(device_id=device_id, id=preset_id))
    if item is None:
        raise HTTPException(404, "Light preset not found")
    return item


@router.get("/{device_id}", response_model=list[PresetRead])
def list_presets(device_id: Identifier, session: Session = Depends(get_session)):
    return list(session.scalars(select(LightPreset).filter_by(device_id=device_id).order_by(LightPreset.id)))


@router.post("/{device_id}", response_model=PresetRead, status_code=201)
def create_preset(device_id: Identifier, body: PresetInput, session: Session = Depends(get_session)):
    item = LightPreset(device_id=device_id, **body.model_dump())
    session.add(item)
    commit(session)
    return item


@router.put("/{device_id}/{preset_id}", response_model=PresetRead)
def update_preset(
    device_id: Identifier, preset_id: PositiveID, body: PresetInput, session: Session = Depends(get_session)
):
    item = find_preset(session, device_id, preset_id)
    item.name, item.scene, item.tuya_scene_id = body.name, body.scene.model_dump(), body.tuya_scene_id
    commit(session)
    return item


@router.delete("/{device_id}/{preset_id}", status_code=204)
def delete_preset(device_id: Identifier, preset_id: PositiveID, session: Session = Depends(get_session)):
    session.delete(find_preset(session, device_id, preset_id))
    commit(session)
    return Response(status_code=204)
