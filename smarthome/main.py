from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from . import __version__
from .api_dependencies import authenticate, get_session
from .auto_label_translations import (
    standard_room_names,
    translate_batches,
    translate_local_device,
    translate_room_names,
)
from .config import Settings
from .control import run_command
from .dashboard_layout_api import remove_room_from_navigation
from .dashboard_layout_api import router as dashboard_layout_router
from .db import init_db, make_engine
from .importer import import_tinytuya
from .models import (
    Building,
    CloudPlacement,
    DashboardLayout,
    Device,
    DeviceType,
    Room,
)
from .schemas import (
    Alias,
    AliasCreate,
    BuildingCreate,
    BuildingPatch,
    BuildingRead,
    BuildingTree,
    CapabilitiesCommand,
    CapabilityCommand,
    CommandRead,
    DeviceCreate,
    DevicePatch,
    DeviceRead,
    DeviceState,
    DeviceTypeCreate,
    DeviceTypePatch,
    DeviceTypeRead,
    DPSCommand,
    EntityRef,
    ImportRequest,
    NameQuery,
    PositiveID,
    RoomCreate,
    RoomNamePreview,
    RoomPatch,
    RoomRead,
    RoomTree,
    SwitchCommand,
)
from .search import alias_filters, fold_name, get_by_alias, get_by_name, name_filters
from .service import (
    capability_dps,
    capability_values_dps,
    commit,
    create_aliased,
    create_device,
    device_read,
    device_state,
    get_by_ref,
    get_or_404,
    patch_device,
    replace_aliases,
)
from .tuya import TuyaController

router = APIRouter(prefix="/api/v1", dependencies=[Depends(authenticate)])


def update_fields(item, body, session, *, exclude=None):
    values = body.model_dump(mode="json", exclude_unset=True, exclude=exclude)
    aliases = values.pop("aliases", None)
    for name, value in values.items():
        setattr(item, name, value)
    if aliases is not None:
        replace_aliases(session, item, aliases)


def assert_empty(session, model, *conditions):
    if session.scalar(select(model.id).where(*conditions).limit(1)) is not None:
        raise HTTPException(409, "Object has dependants; reassign or delete them first")


@router.post("/buildings", response_model=BuildingRead, status_code=201, tags=["Buildings"])
def add_building(body: BuildingCreate, session: Session = Depends(get_session)):
    item = create_aliased(session, Building, body)
    commit(session)
    return item


@router.get("/buildings", response_model=list[BuildingRead], tags=["Buildings"])
def list_buildings(
    alias: NameQuery | None = None,
    name: NameQuery | None = None,
    q: NameQuery | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    query = name_filters(select(Building), Building, name=name, q=q)
    if alias is not None:
        query = alias_filters(query, Building, alias)
    return session.scalars(query.order_by(Building.id).offset(offset).limit(limit)).all()


@router.get("/buildings/{item_id}", response_model=BuildingRead, tags=["Buildings"])
def read_building(item_id: EntityRef, session: Session = Depends(get_session)):
    return get_by_ref(session, Building, item_id)


@router.patch("/buildings/{item_id}", response_model=BuildingRead, tags=["Buildings"])
def edit_building(item_id: EntityRef, body: BuildingPatch, session: Session = Depends(get_session)):
    item = get_by_ref(session, Building, item_id)
    update_fields(item, body, session)
    commit(session)
    return item


@router.delete("/buildings/{item_id}", status_code=204, tags=["Buildings"])
def delete_building(item_id: EntityRef, session: Session = Depends(get_session)):
    item = get_by_ref(session, Building, item_id)
    assert_empty(session, Room, Room.building_id == item.id)
    assert_empty(session, Device, Device.building_id == item.id)
    session.delete(item)
    commit(session)
    return Response(status_code=204)


@router.get("/buildings/{item_id}/rooms", response_model=list[RoomRead], tags=["Buildings"])
def building_rooms(item_id: EntityRef, session: Session = Depends(get_session)):
    item = get_by_ref(session, Building, item_id)
    return session.scalars(select(Room).where(Room.building_id == item.id).order_by(Room.id)).all()


@router.get("/buildings/{item_id}/hierarchy", response_model=BuildingTree, tags=["Buildings"])
def hierarchy(item_id: EntityRef, session: Session = Depends(get_session)):
    building = get_by_ref(session, Building, item_id)
    rooms = session.scalars(
        select(Room).where(Room.building_id == building.id).order_by(Room.id)
    ).all()
    devices = session.scalars(
        select(Device).where(Device.building_id == building.id).order_by(Device.id)
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
def add_room(body: RoomCreate, request: Request, session: Session = Depends(get_session)):
    get_or_404(session, Building, body.building_id)
    item = create_aliased(session, Room, body)
    commit(session)
    translate_room_names(session, request.app.state.settings.label_translator_url, [item.id])
    return item


@router.post("/rooms/translation-preview", tags=["Rooms"])
def preview_room_name(body: RoomNamePreview, request: Request, response: Response) -> dict[str, str]:
    response.headers["Cache-Control"] = "no-store"
    standard = standard_room_names(body.name)
    if standard is not None:
        return standard
    url = request.app.state.settings.label_translator_url
    if url:
        try:
            return translate_batches(url, [body.name])[body.name]
        except (OSError, ValueError):
            pass
    raise HTTPException(503, "Room name translation is unavailable")


@router.get("/rooms", response_model=list[RoomRead], tags=["Rooms"])
def list_rooms(
    building_id: int | None = None,
    alias: NameQuery | None = None,
    name: NameQuery | None = None,
    q: NameQuery | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    query = name_filters(select(Room), Room, name=name, q=q)
    if building_id is not None:
        query = query.where(Room.building_id == building_id)
    if alias is not None:
        query = alias_filters(query, Room, alias)
    return session.scalars(query.order_by(Room.id).offset(offset).limit(limit)).all()


@router.get("/rooms/{item_id}", response_model=RoomRead, tags=["Rooms"])
def read_room(item_id: EntityRef, session: Session = Depends(get_session)):
    return get_by_ref(session, Room, item_id)


@router.patch("/rooms/{item_id}", response_model=RoomRead, tags=["Rooms"])
def edit_room(item_id: EntityRef, body: RoomPatch, request: Request, session: Session = Depends(get_session)):
    item = get_by_ref(session, Room, item_id)
    if body.building_id is not None:
        get_or_404(session, Building, body.building_id)
        if body.building_id != item.building_id:
            assert_empty(session, Device, Device.room_id == item.id)
    update_fields(item, body, session, exclude={"name_translations"})
    if body.name_translations:
        edits = [part for locale, value in body.name_translations.items() for part in (f"$.{locale}", value)]
        item.name_translation_overrides = func.json_set(Room.name_translation_overrides, *edits)
    commit(session)
    translate_room_names(session, request.app.state.settings.label_translator_url, [item.id])
    return item


@router.delete("/rooms/{item_id}", status_code=204, tags=["Rooms"])
def delete_room(item_id: EntityRef, session: Session = Depends(get_session)):
    item = get_by_ref(session, Room, item_id)
    assert_empty(session, Device, Device.room_id == item.id)
    remove_room_from_navigation(session, item.id)
    # The persisted layout view is building/room/columns/page.
    session.execute(delete(DashboardLayout).where(DashboardLayout.view.like(f"%/{item.id}/%/%")))
    session.delete(item)
    commit(session)
    return Response(status_code=204)


@router.get("/rooms/{item_id}/devices", response_model=list[DeviceRead], tags=["Rooms"])
def room_devices(item_id: EntityRef, session: Session = Depends(get_session)):
    room = get_by_ref(session, Room, item_id)
    items = session.scalars(
        select(Device).where(Device.room_id == room.id).order_by(Device.id)
    ).all()
    return [device_read(session, item) for item in items]


@router.get("/profiles", tags=["Profiles"])
def list_profiles():
    from .profiles import PROFILES, profile

    return [profile(identifier) for identifier in PROFILES]


@router.get("/profiles/{identifier}", tags=["Profiles"])
def read_profile(identifier: str):
    from .profiles import PROFILES, profile

    if identifier not in PROFILES:
        raise HTTPException(404, "Profile not found")
    return profile(identifier)


@router.post("/device-types", response_model=DeviceTypeRead, status_code=201, tags=["Device types"])
def add_type(body: DeviceTypeCreate, session: Session = Depends(get_session)):
    item = DeviceType(**body.model_dump(mode="json"))
    session.add(item)
    commit(session)
    return item


@router.get("/device-types", response_model=list[DeviceTypeRead], tags=["Device types"])
def list_types(
    name: NameQuery | None = None,
    q: NameQuery | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    query = name_filters(select(DeviceType), DeviceType, name=name, q=q)
    return session.scalars(query.order_by(DeviceType.id).offset(offset).limit(limit)).all()


@router.get("/device-types/{item_id}", response_model=DeviceTypeRead, tags=["Device types"])
def read_type(item_id: int, session: Session = Depends(get_session)):
    return get_or_404(session, DeviceType, item_id)


@router.patch("/device-types/{item_id}", response_model=DeviceTypeRead, tags=["Device types"])
def edit_type(item_id: int, body: DeviceTypePatch, session: Session = Depends(get_session)):
    item = get_or_404(session, DeviceType, item_id)
    update_fields(item, body, session)
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
def add_device(body: DeviceCreate, request: Request, session: Session = Depends(get_session)):
    item = create_device(session, body)
    commit(session)
    translate_local_device(session, request, item)
    return device_read(session, item)


@router.get("/devices", response_model=list[DeviceRead], tags=["Devices"])
def list_devices(
    alias: NameQuery | None = None,
    name: NameQuery | None = None,
    q: NameQuery | None = None,
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
    query = name_filters(select(Device), Device, name=name, q=q)
    if alias is not None:
        query = alias_filters(query, Device, alias)
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
    from .device_translations import LOCAL_SCOPE, translations_for

    items = session.scalars(query.order_by(Device.id).offset(offset).limit(limit)).all()
    translations = translations_for(session, LOCAL_SCOPE, [str(item.id) for item in items])
    return [device_read(session, item, translations.get(str(item.id), {})) for item in items]


@router.get("/devices/{item_id}", response_model=DeviceRead, tags=["Devices"])
def read_device(item_id: EntityRef, session: Session = Depends(get_session)):
    return device_read(session, get_by_ref(session, Device, item_id))


@router.patch("/devices/{item_id}", response_model=DeviceRead, tags=["Devices"])
def edit_device(item_id: EntityRef, body: DevicePatch, request: Request, session: Session = Depends(get_session)):
    item = patch_device(session, get_by_ref(session, Device, item_id), body)
    if "room_id" in body.model_fields_set:
        session.execute(update(CloudPlacement).where(CloudPlacement.device_id == item.device_id).values(overridden=True))
    commit(session)
    if {"name", "aliases"} & body.model_fields_set:
        translate_local_device(session, request, item)
    return device_read(session, item)


@router.delete("/devices/{item_id}", status_code=204, tags=["Devices"])
def delete_device(item_id: EntityRef, session: Session = Depends(get_session)):
    item = get_by_ref(session, Device, item_id)
    from .device_translations import LOCAL_SCOPE, prune_translations

    assert_empty(session, Device, Device.parent_id == item.id)
    for kind in ("name", "alias"):
        prune_translations(session, LOCAL_SCOPE, str(item.id), kind, [])
    session.delete(item)
    commit(session)
    return Response(status_code=204)


@router.get("/devices/{item_id}/children", response_model=list[DeviceRead], tags=["Devices"])
def children(item_id: EntityRef, session: Session = Depends(get_session)):
    item = get_by_ref(session, Device, item_id)
    items = session.scalars(
        select(Device).where(Device.parent_id == item.id).order_by(Device.id)
    ).all()
    return [device_read(session, item) for item in items]


@router.get("/devices/{item_id}/state", response_model=DeviceState, tags=["Control"])
def normalized_state(
    item_id: EntityRef,
    request: Request,
    refresh: bool = False,
    watch: bool = False,
    max_age: int = Query(60, ge=1, le=86400),
    session: Session = Depends(get_session),
):
    item = get_by_ref(session, Device, item_id)
    if refresh:
        run_command(request, session, item, "status")
    if watch:
        request.app.state.visible_status.touch(item.id)
    return device_state(session, item, max_age=max_age)


@router.post(
    "/devices/{item_id}/commands/capabilities", response_model=CommandRead, tags=["Control"]
)
def set_capabilities(
    item_id: EntityRef,
    body: CapabilitiesCommand,
    request: Request,
    session: Session = Depends(get_session),
):
    item = get_by_ref(session, Device, item_id)
    dps = capability_values_dps(session, item, body.values)
    return run_command(request, session, item, "capabilities", dps)


@router.get("/devices/{item_id}/status", response_model=CommandRead, tags=["Control"])
@router.post("/devices/{item_id}/commands/status", response_model=CommandRead, tags=["Control"])
def status(item_id: EntityRef, request: Request, session: Session = Depends(get_session)):
    return run_command(request, session, get_by_ref(session, Device, item_id), "status")


def switch(item_id, request, session, body, on):
    item = get_by_ref(session, Device, item_id)
    dps = {body.dp: on} if body.dp else capability_dps(session, item, "switch", on)
    return run_command(request, session, item, "on" if on else "off", dps)


@router.post("/devices/{item_id}/commands/on", response_model=CommandRead, tags=["Control"])
def turn_on(
    item_id: EntityRef,
    request: Request,
    body: SwitchCommand = SwitchCommand(),
    session: Session = Depends(get_session),
):
    return switch(item_id, request, session, body, True)


@router.post("/devices/{item_id}/commands/off", response_model=CommandRead, tags=["Control"])
def turn_off(
    item_id: EntityRef,
    request: Request,
    body: SwitchCommand = SwitchCommand(),
    session: Session = Depends(get_session),
):
    return switch(item_id, request, session, body, False)


@router.post("/devices/{item_id}/commands/set_dps", response_model=CommandRead, tags=["Control"])
def set_dps(
    item_id: EntityRef, request: Request, body: DPSCommand, session: Session = Depends(get_session)
):
    return run_command(request, session, get_by_ref(session, Device, item_id), "set_dps", body.dps)


def set_capability(item_id, request, session, capability, value):
    item = get_by_ref(session, Device, item_id)
    dps = capability_dps(session, item, capability, value)
    return run_command(request, session, item, capability, dps)


@router.put(
    "/devices/{item_id}/capabilities/{capability}", response_model=CommandRead, tags=["Control"]
)
def capability_value(
    item_id: EntityRef,
    capability: str,
    body: CapabilityCommand,
    request: Request,
    session: Session = Depends(get_session),
):
    return set_capability(item_id, request, session, capability, body.value)


@router.post("/devices/{item_id}/commands/brightness", response_model=CommandRead, tags=["Control"])
def brightness(
    item_id: EntityRef,
    body: CapabilityCommand,
    request: Request,
    session: Session = Depends(get_session),
):
    return set_capability(item_id, request, session, "brightness", body.value)


@router.post("/devices/{item_id}/commands/color", response_model=CommandRead, tags=["Control"])
def color(
    item_id: EntityRef,
    body: CapabilityCommand,
    request: Request,
    session: Session = Depends(get_session),
):
    return set_capability(item_id, request, session, "color", body.value)


@router.post(
    "/devices/{item_id}/commands/temperature", response_model=CommandRead, tags=["Control"]
)
def temperature(
    item_id: EntityRef,
    body: CapabilityCommand,
    request: Request,
    session: Session = Depends(get_session),
):
    return set_capability(item_id, request, session, "temperature", body.value)


@router.post("/imports/tinytuya", tags=["Import"])
def import_devices(body: ImportRequest, session: Session = Depends(get_session)):
    return import_tinytuya(session, body)


def register_name_lookup(resource, model, read_schema):
    @router.get(
        "/lookup/" + resource,
        response_model=read_schema,
        tags=["Search"],
        name=f"{resource}_lookup_by_name",
    )
    def lookup_by_name(
        name: NameQuery,
        building_id: PositiveID | None = None,
        room_id: PositiveID | None = None,
        parent_id: PositiveID | None = None,
        device_type_id: PositiveID | None = None,
        session: Session = Depends(get_session),
    ):
        item = get_by_name(
            session,
            model,
            name,
            building_id=building_id,
            room_id=room_id,
            parent_id=parent_id,
            device_type_id=device_type_id,
        )
        return device_read(session, item) if model is Device else read_schema.model_validate(item)


for resource, model, schema in (
    ("buildings", Building, BuildingRead),
    ("rooms", Room, RoomRead),
    ("devices", Device, DeviceRead),
    ("device-types", DeviceType, DeviceTypeRead),
):
    register_name_lookup(resource, model, schema)


def register_alias_lookup(resource, model, read_schema):
    @router.get(
        "/lookup/" + resource + "/alias",
        response_model=read_schema,
        tags=["Search"],
        name=f"{resource}_lookup_by_alias",
    )
    def lookup_by_alias(
        alias: NameQuery,
        building_id: PositiveID | None = None,
        room_id: PositiveID | None = None,
        parent_id: PositiveID | None = None,
        device_type_id: PositiveID | None = None,
        session: Session = Depends(get_session),
    ):
        item = get_by_alias(
            session,
            model,
            alias,
            building_id=building_id,
            room_id=room_id,
            parent_id=parent_id,
            device_type_id=device_type_id,
        )
        return device_read(session, item) if model is Device else read_schema.model_validate(item)


def register_alias_routes(resource, model, read_schema):
    path = "/" + resource + "/{item_id}/aliases"

    @router.get(path, response_model=list[str], tags=["Aliases"], name=f"{resource}_aliases")
    def list_aliases(item_id: EntityRef, session: Session = Depends(get_session)):
        return get_by_ref(session, model, item_id).aliases

    @router.post(
        path,
        response_model=read_schema,
        status_code=201,
        tags=["Aliases"],
        name=f"{resource}_add_alias",
    )
    def add_alias(item_id: EntityRef, body: AliasCreate, request: Request, session: Session = Depends(get_session)):
        item = get_by_ref(session, model, item_id)
        if any(fold_name(body.alias) == fold_name(alias) for alias in item.aliases):
            raise HTTPException(409, "Alias already exists on this object")
        if len(item.alias_entries) >= 32:
            raise HTTPException(422, "Object cannot have more than 32 aliases")
        replace_aliases(session, item, [*item.aliases, body.alias])
        commit(session)
        if model is Device:
            translate_local_device(session, request, item)
            return device_read(session, item)
        return read_schema.model_validate(item)

    @router.delete(
        path + "/{alias}", status_code=204, tags=["Aliases"], name=f"{resource}_delete_alias"
    )
    def delete_alias(item_id: EntityRef, alias: Alias, session: Session = Depends(get_session)):
        item = get_by_ref(session, model, item_id)
        if fold_name(alias) == fold_name(item.name):
            raise HTTPException(409, "The name alias is automatic; rename the object instead")
        if alias not in item.aliases:
            raise HTTPException(404, "Alias not found on this object")
        replace_aliases(session, item, [name for name in item.aliases if name != alias])
        commit(session)
        return Response(status_code=204)


for resource, model, schema in (
    ("buildings", Building, BuildingRead),
    ("rooms", Room, RoomRead),
    ("devices", Device, DeviceRead),
):
    register_alias_lookup(resource, model, schema)
    register_alias_routes(resource, model, schema)


def create_app(settings: Settings | None = None, controller=None):
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app):
        engine = make_engine(settings.database_path)
        init_db(engine)
        app.state.engine = engine
        from .commissioning import Observations

        app.state.observations = Observations()
        app.state.gateway_findings = Observations()
        from .network import NetworkMonitor

        app.state.network = NetworkMonitor()
        if settings.network_monitor_enabled:
            app.state.network.start_global()
        from .topology import TopologySync

        app.state.topology = TopologySync()
        from .cloud import CloudBridge

        app.state.cloud = CloudBridge(settings)
        from .developer_cloud import DeveloperBridge

        app.state.developer_cloud = DeveloperBridge(settings)
        from .camera_playback import PlaybackStore, install_access_log_filter

        app.state.camera_playback = PlaybackStore()
        install_access_log_filter()
        from .poller import DisplayPoller

        app.state.poller = DisplayPoller(app)
        app.state.poller.start()
        from .visible_status import VisibleStatusPoller

        app.state.visible_status = VisibleStatusPoller(app)
        app.state.visible_status.start()
        try:
            yield
        finally:
            app.state.network.close()
            app.state.visible_status.stop()
            app.state.poller.stop()
            app.state.topology.stop()
            app.state.observations.clear()
            app.state.gateway_findings.clear()
            app.state.cloud.close()
            engine.dispose()

    app = FastAPI(
        title="Smart Home Local API",
        version=__version__,
        lifespan=lifespan,
        description="SQLite inventory + direct Wi-Fi and parent/cid Zigbee control. local_key is write-only.",
    )
    app.state.settings = settings
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["X-API-Key", "Content-Type", "Range"],
            expose_headers=["Accept-Ranges", "Content-Range"],
            allow_credentials=False,
        )
    app.state.controller = controller or TuyaController(settings)
    app.include_router(router)
    from .display_api import router as display_router

    app.include_router(display_router)

    app.include_router(dashboard_layout_router)

    from .room_appearance import router as room_appearance_router

    app.include_router(room_appearance_router)
    from .light_presets import router as light_presets_router

    app.include_router(light_presets_router)

    from .combined_devices import router as combined_router

    app.include_router(combined_router)
    from .topology import router as cloud_router

    app.include_router(cloud_router)
    from .camera_api import router as camera_router

    app.include_router(camera_router)
    from .camera_playback import router as playback_router

    app.include_router(playback_router)
    from .commissioning import router as commissioning_router

    app.include_router(commissioning_router)
    from .network import router as network_router

    app.include_router(network_router)
    from .gateway_setup import router as gateway_setup_router

    app.include_router(gateway_setup_router)
    from .gateway_setup import connection_router

    app.include_router(connection_router)
    from .device_aliases import router as device_aliases_router

    app.include_router(device_aliases_router)
    from .device_translations import router as device_translations_router

    app.include_router(device_translations_router)

    from .activity import router as activity_router
    app.include_router(activity_router)

    @app.get("/cloud", include_in_schema=False)
    def cloud_setup_page():
        if not settings.frontend_url:
            raise HTTPException(404, "The web UI runs separately; see frontend/README.md")
        return RedirectResponse(settings.frontend_url, headers={"Cache-Control": "no-store"})

    @app.get("/health", tags=["System"])
    def health():
        return {"status": "ok", "version": __version__}

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
