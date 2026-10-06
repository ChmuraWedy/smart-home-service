import hmac
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from .config import Settings
from .db import init_db, make_engine
from .importer import import_tinytuya
from .models import Building, Device, DeviceType, Room, utcnow
from .schemas import (
    BuildingCreate,
    BuildingPatch,
    BuildingRead,
    BuildingTree,
    CapabilityCommand,
    CommandRead,
    DeviceCreate,
    DevicePatch,
    DeviceRead,
    DeviceTypeCreate,
    DeviceTypePatch,
    DeviceTypeRead,
    DPSCommand,
    ImportRequest,
    RoomCreate,
    RoomPatch,
    RoomRead,
    RoomTree,
    SwitchCommand,
)
from .service import (
    capability_dps,
    commit,
    create_device,
    device_read,
    get_or_404,
    patch_device,
)
from .tuya import TuyaController


def get_session(request: Request):
    with Session(request.app.state.engine, expire_on_commit=False) as session:
        yield session


token_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def authenticate(request: Request, token: str | None = Depends(token_header)):
    expected = request.app.state.settings.api_token
    if expected and not hmac.compare_digest((token or "").encode(), expected.encode()):
        raise HTTPException(401, "Missing or invalid X-API-Key")


router = APIRouter(prefix="/api/v1", dependencies=[Depends(authenticate)])


def update_fields(item, body):
    for name, value in body.model_dump(mode="json", exclude_unset=True).items():
        setattr(item, name, value)


def assert_empty(session, model, *conditions):
    if session.scalar(select(model.id).where(*conditions).limit(1)) is not None:
        raise HTTPException(409, "Object has dependants; reassign or delete them first")


@router.post("/buildings", response_model=BuildingRead, status_code=201, tags=["Buildings"])
def add_building(body: BuildingCreate, session: Session = Depends(get_session)):
    item = Building(**body.model_dump())
    session.add(item)
    commit(session)
    return item


@router.get("/buildings", response_model=list[BuildingRead], tags=["Buildings"])
def list_buildings(
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    return session.scalars(select(Building).order_by(Building.id).offset(offset).limit(limit)).all()


@router.get("/buildings/{item_id}", response_model=BuildingRead, tags=["Buildings"])
def read_building(item_id: int, session: Session = Depends(get_session)):
    return get_or_404(session, Building, item_id)


@router.patch("/buildings/{item_id}", response_model=BuildingRead, tags=["Buildings"])
def edit_building(item_id: int, body: BuildingPatch, session: Session = Depends(get_session)):
    item = get_or_404(session, Building, item_id)
    update_fields(item, body)
    commit(session)
    return item


@router.delete("/buildings/{item_id}", status_code=204, tags=["Buildings"])
def delete_building(item_id: int, session: Session = Depends(get_session)):
    item = get_or_404(session, Building, item_id)
    assert_empty(session, Room, Room.building_id == item_id)
    assert_empty(session, Device, Device.building_id == item_id)
    session.delete(item)
    commit(session)
    return Response(status_code=204)


@router.get("/buildings/{item_id}/rooms", response_model=list[RoomRead], tags=["Buildings"])
def building_rooms(item_id: int, session: Session = Depends(get_session)):
    get_or_404(session, Building, item_id)
    return session.scalars(select(Room).where(Room.building_id == item_id).order_by(Room.id)).all()


@router.get("/buildings/{item_id}/hierarchy", response_model=BuildingTree, tags=["Buildings"])
def hierarchy(item_id: int, session: Session = Depends(get_session)):
    building = get_or_404(session, Building, item_id)
    rooms = session.scalars(select(Room).where(Room.building_id == item_id).order_by(Room.id)).all()
    devices = session.scalars(
        select(Device).where(Device.building_id == item_id).order_by(Device.id)
    ).all()
    return BuildingTree(
        **BuildingRead.model_validate(building).model_dump(),
        rooms=[
            RoomTree(
                **RoomRead.model_validate(room).model_dump(),
                devices=[device_read(session, d) for d in devices if d.room_id == room.id],
            )
            for room in rooms
        ],
        unassigned_devices=[device_read(session, d) for d in devices if d.room_id is None],
    )


@router.post("/rooms", response_model=RoomRead, status_code=201, tags=["Rooms"])
def add_room(body: RoomCreate, session: Session = Depends(get_session)):
    get_or_404(session, Building, body.building_id)
    item = Room(**body.model_dump())
    session.add(item)
    commit(session)
    return item


@router.get("/rooms", response_model=list[RoomRead], tags=["Rooms"])
def list_rooms(
    building_id: int | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    query = select(Room)
    if building_id is not None:
        query = query.where(Room.building_id == building_id)
    return session.scalars(query.order_by(Room.id).offset(offset).limit(limit)).all()


@router.get("/rooms/{item_id}", response_model=RoomRead, tags=["Rooms"])
def read_room(item_id: int, session: Session = Depends(get_session)):
    return get_or_404(session, Room, item_id)


@router.patch("/rooms/{item_id}", response_model=RoomRead, tags=["Rooms"])
def edit_room(item_id: int, body: RoomPatch, session: Session = Depends(get_session)):
    item = get_or_404(session, Room, item_id)
    if body.building_id is not None:
        get_or_404(session, Building, body.building_id)
        if body.building_id != item.building_id:
            assert_empty(session, Device, Device.room_id == item_id)
    update_fields(item, body)
    commit(session)
    return item


@router.delete("/rooms/{item_id}", status_code=204, tags=["Rooms"])
def delete_room(item_id: int, session: Session = Depends(get_session)):
    item = get_or_404(session, Room, item_id)
    assert_empty(session, Device, Device.room_id == item_id)
    session.delete(item)
    commit(session)
    return Response(status_code=204)


@router.get("/rooms/{item_id}/devices", response_model=list[DeviceRead], tags=["Rooms"])
def room_devices(item_id: int, session: Session = Depends(get_session)):
    get_or_404(session, Room, item_id)
    items = session.scalars(
        select(Device).where(Device.room_id == item_id).order_by(Device.id)
    ).all()
    return [device_read(session, item) for item in items]


@router.post("/device-types", response_model=DeviceTypeRead, status_code=201, tags=["Device types"])
def add_type(body: DeviceTypeCreate, session: Session = Depends(get_session)):
    item = DeviceType(**body.model_dump(mode="json"))
    session.add(item)
    commit(session)
    return item


@router.get("/device-types", response_model=list[DeviceTypeRead], tags=["Device types"])
def list_types(
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    return session.scalars(
        select(DeviceType).order_by(DeviceType.id).offset(offset).limit(limit)
    ).all()


@router.get("/device-types/{item_id}", response_model=DeviceTypeRead, tags=["Device types"])
def read_type(item_id: int, session: Session = Depends(get_session)):
    return get_or_404(session, DeviceType, item_id)


@router.patch("/device-types/{item_id}", response_model=DeviceTypeRead, tags=["Device types"])
def edit_type(item_id: int, body: DeviceTypePatch, session: Session = Depends(get_session)):
    item = get_or_404(session, DeviceType, item_id)
    update_fields(item, body)
    commit(session)
    return item


@router.delete("/device-types/{item_id}", status_code=204, tags=["Device types"])
def delete_type(item_id: int, session: Session = Depends(get_session)):
    item = get_or_404(session, DeviceType, item_id)
    assert_empty(session, Device, Device.device_type_id == item_id)
    session.delete(item)
    commit(session)
    return Response(status_code=204)


@router.post("/devices", response_model=DeviceRead, status_code=201, tags=["Devices"])
def add_device(body: DeviceCreate, session: Session = Depends(get_session)):
    item = create_device(session, body)
    commit(session)
    return device_read(session, item)


@router.get("/devices", response_model=list[DeviceRead], tags=["Devices"])
def list_devices(
    building_id: int | None = None,
    room_id: int | None = None,
    device_type_id: int | None = None,
    parent_id: int | None = None,
    is_gateway: bool | None = None,
    transport: str | None = Query(None, pattern="^(wifi|zigbee)$"),
    unassigned: bool = False,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    query = select(Device)
    for column, value in (
        (Device.building_id, building_id),
        (Device.room_id, room_id),
        (Device.device_type_id, device_type_id),
        (Device.parent_id, parent_id),
        (Device.is_gateway, is_gateway),
        (Device.transport, transport),
    ):
        if value is not None:
            query = query.where(column == value)
    if unassigned:
        query = query.where(Device.building_id.is_(None), Device.room_id.is_(None))
    items = session.scalars(query.order_by(Device.id).offset(offset).limit(limit)).all()
    return [device_read(session, item) for item in items]


@router.get("/devices/{item_id}", response_model=DeviceRead, tags=["Devices"])
def read_device(item_id: int, session: Session = Depends(get_session)):
    return device_read(session, get_or_404(session, Device, item_id))


@router.patch("/devices/{item_id}", response_model=DeviceRead, tags=["Devices"])
def edit_device(item_id: int, body: DevicePatch, session: Session = Depends(get_session)):
    item = patch_device(session, get_or_404(session, Device, item_id), body)
    commit(session)
    return device_read(session, item)


@router.delete("/devices/{item_id}", status_code=204, tags=["Devices"])
def delete_device(item_id: int, session: Session = Depends(get_session)):
    item = get_or_404(session, Device, item_id)
    assert_empty(session, Device, Device.parent_id == item_id)
    session.delete(item)
    commit(session)
    return Response(status_code=204)


@router.get("/devices/{item_id}/children", response_model=list[DeviceRead], tags=["Devices"])
def children(item_id: int, session: Session = Depends(get_session)):
    get_or_404(session, Device, item_id)
    items = session.scalars(
        select(Device).where(Device.parent_id == item_id).order_by(Device.id)
    ).all()
    return [device_read(session, item) for item in items]


def run_command(request, session, item, command, dps=None):
    parent = get_or_404(session, Device, item.parent_id) if item.parent_id else None
    # Release the read transaction while doing blocking LAN I/O. expire_on_commit=False
    # retains the configuration snapshot used for this command.
    session.commit()
    observed = request.app.state.controller.execute(item, parent, dps=dps)
    observed_at = utcnow()
    if observed:
        item.last_dps = {**(item.last_dps or {}), **observed}
    item.last_seen_at = observed_at
    commit(session)
    # Empty control acknowledgement does not prove the requested physical state.
    return CommandRead(
        device_id=item.id, command=command, acknowledged=True, dps=observed, observed_at=observed_at
    )


@router.get("/devices/{item_id}/status", response_model=CommandRead, tags=["Control"])
@router.post("/devices/{item_id}/commands/status", response_model=CommandRead, tags=["Control"])
def status(item_id: int, request: Request, session: Session = Depends(get_session)):
    return run_command(request, session, get_or_404(session, Device, item_id), "status")


def switch(item_id, request, session, body, on):
    item = get_or_404(session, Device, item_id)
    dps = {body.dp: on} if body.dp else capability_dps(session, item, "switch", on)
    return run_command(request, session, item, "on" if on else "off", dps)


@router.post("/devices/{item_id}/commands/on", response_model=CommandRead, tags=["Control"])
def turn_on(
    item_id: int,
    request: Request,
    body: SwitchCommand = SwitchCommand(),
    session: Session = Depends(get_session),
):
    return switch(item_id, request, session, body, True)


@router.post("/devices/{item_id}/commands/off", response_model=CommandRead, tags=["Control"])
def turn_off(
    item_id: int,
    request: Request,
    body: SwitchCommand = SwitchCommand(),
    session: Session = Depends(get_session),
):
    return switch(item_id, request, session, body, False)


@router.post("/devices/{item_id}/commands/set_dps", response_model=CommandRead, tags=["Control"])
def set_dps(
    item_id: int, request: Request, body: DPSCommand, session: Session = Depends(get_session)
):
    return run_command(request, session, get_or_404(session, Device, item_id), "set_dps", body.dps)


def set_capability(item_id, request, session, capability, value):
    item = get_or_404(session, Device, item_id)
    dps = capability_dps(session, item, capability, value)
    return run_command(request, session, item, capability, dps)


@router.put(
    "/devices/{item_id}/capabilities/{capability}", response_model=CommandRead, tags=["Control"]
)
def capability_value(
    item_id: int,
    capability: str,
    body: CapabilityCommand,
    request: Request,
    session: Session = Depends(get_session),
):
    return set_capability(item_id, request, session, capability, body.value)


@router.post("/devices/{item_id}/commands/brightness", response_model=CommandRead, tags=["Control"])
def brightness(
    item_id: int, body: CapabilityCommand, request: Request, session: Session = Depends(get_session)
):
    return set_capability(item_id, request, session, "brightness", body.value)


@router.post("/devices/{item_id}/commands/color", response_model=CommandRead, tags=["Control"])
def color(
    item_id: int, body: CapabilityCommand, request: Request, session: Session = Depends(get_session)
):
    return set_capability(item_id, request, session, "color", body.value)


@router.post(
    "/devices/{item_id}/commands/temperature", response_model=CommandRead, tags=["Control"]
)
def temperature(
    item_id: int, body: CapabilityCommand, request: Request, session: Session = Depends(get_session)
):
    return set_capability(item_id, request, session, "temperature", body.value)


@router.post("/imports/tinytuya", tags=["Import"])
def import_devices(body: ImportRequest, session: Session = Depends(get_session)):
    return import_tinytuya(session, body)


def create_app(settings: Settings | None = None, controller=None):
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app):
        engine = make_engine(settings.database_path)
        init_db(engine)
        app.state.engine = engine
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(
        title="Smart Home Local API",
        version="0.1.0",
        lifespan=lifespan,
        description="SQLite inventory + direct Wi-Fi and parent/cid Zigbee control. local_key is write-only.",
    )
    app.state.settings = settings
    app.state.controller = controller or TuyaController(settings)
    app.include_router(router)

    @app.get("/health", tags=["System"])
    def health():
        return {"status": "ok", "version": "0.1.0"}

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, exc):
        # Pydantic's default error body includes input, including a submitted local_key.
        # Return only paths and error types; even JSON parse errors can embed secret text.
        return JSONResponse(
            status_code=422,
            content={
                "detail": [
                    {
                        "loc": list(error["loc"]),
                        "type": error["type"],
                        "msg": "Invalid request field",
                    }
                    for error in exc.errors()
                ]
            },
        )

    @app.exception_handler(IntegrityError)
    async def integrity_error(_request, _exc):
        return JSONResponse(
            status_code=409,
            content={"detail": "Duplicate identifier/name/cid or referenced object"},
        )

    @app.exception_handler(OperationalError)
    async def database_error(_request, _exc):
        return JSONResponse(
            status_code=503, content={"detail": "Database unavailable or busy; retry later"}
        )

    return app


app = create_app()
