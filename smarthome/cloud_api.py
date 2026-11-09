import base64
import binascii
import json
from dataclasses import asdict
from http.client import HTTPConnection
from http.client import HTTPException as HTTPClientError
from ipaddress import ip_address, ip_network
from math import ceil
from pathlib import Path
from time import monotonic, sleep
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import Field, JsonValue, SecretStr, field_validator
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from .api_dependencies import Account, authenticate, get_session, require_owner
from .importer import import_tinytuya
from .member_controls import (
    is_cloud_camera,
    member_cloud_functions,
    require_cloud_commands,
    require_cloud_device,
)
from .models import CloudChannelLabel, CloudRoomOverride, Room
from .schemas import Identifier, ImportRequest, PositiveID, Schema
from .service import commit, get_or_404

router = APIRouter(prefix="/api/v1/cloud", tags=["Cloud"], dependencies=[Depends(authenticate)])
Provider = Literal["sharing", "developer"]
Region = Literal["eu", "eu-w", "us", "us-e", "cn", "in", "sg"]


class DeveloperCredentials(Schema):
    access_id: SecretStr = Field(min_length=1, max_length=256, repr=False)
    access_secret: SecretStr = Field(min_length=1, max_length=256, repr=False)
    region: Region
    sample_device_id: Identifier | None = None

    @field_validator("access_id", "access_secret")
    @classmethod
    def credential_text(cls, value):
        text = value.get_secret_value().strip()
        if not text or any(c.isspace() or not c.isprintable() for c in text):
            raise ValueError("Invalid Developer credential")
        return SecretStr(text)


class CloudRoomAssignment(Schema):
    room_id: PositiveID | None


def cloud_bridge(request, provider):
    bridge = request.app.state.developer_cloud if provider == "developer" else request.app.state.cloud
    if provider == "sharing" and hasattr(bridge, "state"):
        bridge.state.history_engine = request.app.state.engine
    return bridge


def audit_cloud(request, bridge, provider, device, *, commands=None, outcome=None):
    import logging

    from .activity import record_command, record_values
    from .cloud_scope import scope_for
    try:
        with Session(request.app.state.engine) as session:
            scope = scope_for(bridge, provider)
            if commands is not None:
                record_command(session, scope, device.id, {row["code"]: row["value"] for row in commands}, outcome, getattr(device, "local_key", None))
            else:
                record_values(session, scope, device.id, {**device.status, "online": bool(device.online)}, secret=getattr(device, "local_key", None))
            session.commit()
    except Exception:
        logging.getLogger(__name__).warning("Device activity persistence unavailable")


def battery_reading(device):
    for code in ("battery_percentage", "battery_value", "va_battery", "battery", "battery_state", "battery_level"):
        value = device.status.get(code)
        if value is None or value == getattr(device, "local_key", None):
            continue
        spec = getattr(device, "status_range", {}).get(code)
        try:
            limits = spec.values if isinstance(spec.values, dict) else json.loads(spec.values)
        except (AttributeError, ValueError, TypeError):
            limits = {}
        scale = limits.get("scale", 0)
        if type(value) in (int, float) and type(scale) is int and 0 <= scale <= 9:
            value = value * 10 ** -scale
        return {"code": code, "value": value, "unit": limits.get("unit") or ("%" if code == "battery_percentage" else None)}
    return None


class QRLogin(Schema):
    user_code: SecretStr | None = Field(default=None, min_length=1, max_length=128, repr=False)


class RedroidCredentials(Schema):
    region: str = Field(min_length=1, max_length=120)
    account: SecretStr = Field(min_length=1, max_length=254, repr=False)
    password: SecretStr = Field(min_length=1, max_length=256, repr=False)


def require_redroid(request: Request, _owner: Account = Depends(require_owner)):
    loopback = {"127.0.0.1", "::1"}
    local_request = (
        request.client is not None and request.client.host in loopback
        and request.url.hostname in loopback | {"localhost"}
    )
    if request.url.scheme != "https" and not local_request:
        raise HTTPException(403, "Open Connections over HTTPS or through a localhost SSH tunnel.")
    settings = request.app.state.settings
    if not settings.redroid_token_file:
        raise HTTPException(503, "The Smart Life Android controller is not configured.")
    try:
        token = Path(settings.redroid_token_file).read_text(encoding="ascii").strip()
        if len(token) < 32 or not all("!" <= c <= "~" for c in token):
            raise ValueError("Invalid token")
    except (OSError, ValueError):
        raise HTTPException(503, "The Smart Life Android controller token is unavailable.") from None
    request.app.state.cloud.require_enabled()
    return settings.redroid_port, token


def redroid_request(controller, method, path, body=None, content_type="application/json"):
    port, token = controller
    connection = HTTPConnection("127.0.0.1", port, timeout=85)
    try:
        connection.request(method, path, body, {"Authorization": f"Bearer {token}", "Content-Type": content_type})
        response = connection.getresponse()
        status = response.status
        result = json.loads(response.read(8192))
    except TimeoutError:
        raise HTTPException(504, "Smart Life on Android did not respond in time.") from None
    except (OSError, HTTPClientError, ValueError):
        raise HTTPException(502, "The Smart Life Android controller could not be reached.") from None
    finally:
        connection.close()
    if status == 409:
        detail = result.get("detail") if isinstance(result, dict) else None
        if detail in (
            "Smart Life already has a session on Android. Use that session or sign out in the app first.",
            "Finish signing in to Smart Life on Android first.",
        ):
            raise HTTPException(409, detail)
        raise HTTPException(409, "Check the Smart Life screen on Android and try again.")
    if status != 200 or not isinstance(result, dict):
        raise HTTPException(502, "The Smart Life Android operation failed.")
    return result


class SavedUserCode(Schema):
    user_code: SecretStr = Field(min_length=1, max_length=128, repr=False)

    @field_validator("user_code")
    @classmethod
    def trim_user_code(cls, value):
        code = value.get_secret_value().strip()
        if not code:
            raise ValueError("User Code must not be blank")
        return SecretStr(code)


class CloudImport(Schema):
    device_ids: list[Identifier] = Field(min_length=1, max_length=500)
    parent_map: dict[Identifier, Identifier] = Field(default_factory=dict)
    building_id: PositiveID | None = None
    room_id: PositiveID | None = None
    dry_run: bool = False


class CloudCommand(Schema):
    code: Annotated[str, Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_]{0,127}$")]
    value: JsonValue


class CloudCommands(Schema):
    commands: list[CloudCommand] = Field(min_length=1, max_length=16)


class ChannelLabels(Schema):
    labels: dict[
        Annotated[str, Field(pattern=r"^switch_[1-9][0-9]*$", max_length=128)],
        Annotated[str, Field(min_length=1, max_length=120)] | None,
    ] = Field(min_length=1, max_length=32)

    @field_validator("labels")
    @classmethod
    def clean_labels(cls, labels):
        for code, label in labels.items():
            if label is not None:
                label = label.strip()
                if not label or any(not c.isprintable() for c in label):
                    raise ValueError("Channel names must be nonempty printable text")
                labels[code] = label
        return labels


def channel_labels(session, bridge, provider, device_id):
    from .cloud_scope import scope_for

    scope = scope_for(bridge, provider)
    return {
        row.code: row.label for row in session.scalars(
            select(CloudChannelLabel).where(
                CloudChannelLabel.scope == scope, CloudChannelLabel.device_id == device_id
            )
        )
    }


def safe_spec(device, spec):
    result = {key: getattr(spec, key, None) for key in ("code", "type", "values")}
    ids = set()
    strategy = getattr(device, "local_strategy", None)
    for dp, row in (strategy.items() if isinstance(strategy, dict) else ()):
        if isinstance(row, dict) and row.get("status_code") == result["code"]:
            if str(dp).isascii() and str(dp).isdecimal() and 1 <= int(dp) <= 255:
                ids.add(int(dp))
    dp = getattr(spec, "dp_id", None)
    if type(dp) is int and 1 <= dp <= 255:
        ids.add(dp)
    if ids:
        result["dp_ids"] = sorted(ids)
        if len(ids) == 1:
            result["dp_id"] = next(iter(ids))
    return result


def safe_device(device):
    fields = ("id", "name", "category", "product_id", "online", "sub", "node_id", "support_local")
    result = {name: getattr(device, name, None) for name in fields}
    result["has_local_key"] = bool(getattr(device, "local_key", None))
    result["battery"] = battery_reading(device)
    result["functions"] = [
        safe_spec(device, f)
        for f in getattr(device, "function", {}).values()
    ]
    return result


def safe_status_ranges(device):
    # Read-only sensor ranges are separate from the writable function list.
    return [
        safe_spec(device, spec)
        for spec in getattr(device, "status_range", {}).values()
        if getattr(spec, "code", None) not in {"local_key", "key", "access_token", "refresh_token"}
    ]


def safe_snapshot(device, provider):
    return {
        "device_id": device.id,
        "online": bool(device.online),
        "source": "tuya_developer_cloud_snapshot"
        if provider == "developer"
        else "tuya_cloud_snapshot",
        "status": {
            code: value
            for code, value in device.status.items()
            if code not in {"local_key", "key", "access_token", "refresh_token"}
            and value != getattr(device, "local_key", None)
        },
        "device_update_time": getattr(device, "update_time", None),
        "snapshot_received_at": getattr(device, "snapshot_received_at", None),
        "event_stream_connected": getattr(device, "event_stream_connected", False),
        "status_observations": {
            code: observation
            for code, observation in getattr(device, "status_observations", {}).items()
            if code not in {"local_key", "key", "access_token", "refresh_token"}
        },
        "status_range": safe_status_ranges(device),
    }


@router.get("/status")
def cloud_status(
    request: Request, response: Response, account: Account | None = Depends(authenticate),
):
    bridge = request.app.state.cloud
    response.headers["Cache-Control"] = "no-store"
    with bridge.lock:
        return {
            "enabled": bridge.settings.cloud_enabled,
            "connected": bool(bridge.auth),
            "has_saved_user_code": bool(bridge.login_user_code),
            "saved_user_code_requires_login": bridge.saved_code_requires_login,
            "client_id": bridge.settings.cloud_client_id,
            "transport": "internet",
            "scene_edit_supported": False,
            "developer": request.app.state.developer_cloud.status(),
            **({"redroid_available": True} if account and account.role == "owner" and request.app.state.settings.redroid_token_file else {}),
            **({"account": asdict(account)} if account else {}),
        }


@router.get("/developer/status")
def developer_status(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.developer_cloud.status()


@router.put("/developer/credentials")
def developer_credentials(body: DeveloperCredentials, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.developer_cloud.save_credentials(
        {
            "access_id": body.access_id.get_secret_value(),
            "access_secret": body.access_secret.get_secret_value(),
            "region": body.region,
            "sample_device_id": body.sample_device_id,
        }
    )


@router.post("/developer/connect")
def developer_connect(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.developer_cloud.connect()


@router.delete("/developer/credentials")
def developer_logout(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.developer_cloud.logout()


@router.put("/user-code")
def save_user_code(body: SavedUserCode, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.cloud.save_user_code(body.user_code.get_secret_value())


@router.post("/login/qr", status_code=201)
def begin_login(body: QRLogin, request: Request):
    user_code = body.user_code.get_secret_value() if body.user_code is not None else None
    return request.app.state.cloud.begin_login(user_code)


@router.post("/login/redroid/credentials")
def redroid_login(body: RedroidCredentials, controller=Depends(require_redroid)):
    region = body.region.strip()
    account = body.account.get_secret_value().strip()
    if not region or not account:
        raise HTTPException(422, "Enter the Smart Life region and account.")
    result = redroid_request(controller, "POST", "/v1/login/credentials", json.dumps({
        "region": region, "account": account, "password": body.password.get_secret_value(),
    }).encode())
    if result.get("screen") not in ("home", "verification"):
        raise HTTPException(409, "Finish signing in to Smart Life on Android first.")
    return {"screen": result["screen"]}


@router.post("/login/redroid/qr", status_code=201)
def redroid_qr(request: Request, controller=Depends(require_redroid)):
    account = redroid_request(controller, "GET", "/v1/account/user-code")
    code = account.get("user_code")
    if not isinstance(code, str) or not code.strip() or len(code) > 128:
        raise HTTPException(502, "Smart Life on Android did not provide a User Code.")
    bridge = request.app.state.cloud
    started = monotonic()
    login = bridge.begin_login(code, redroid=True)
    session = login["session_id"]
    try:
        token = bridge.redroid_qr_token(session)
        try:
            opened = redroid_request(controller, "POST", "/v1/account/authorize-qr", json.dumps({"token": token}).encode())
            approval_ready = opened.get("status") == "ready"
        except HTTPException:
            approval_ready = False
        remaining = login["expires_in"] - ceil(monotonic() - started)
        if remaining <= 0:
            raise HTTPException(409, "The QR code expired on Android. Start a new connection.")
    except Exception:
        with bridge.lock:
            bridge.pending.pop(session, None)
        raise
    return {**login, "expires_in": remaining, "android_approval_ready": approval_ready}


@router.post("/login/redroid/{session_id}/confirm")
def redroid_confirm(session_id: str, request: Request, controller=Depends(require_redroid)):
    bridge = request.app.state.cloud
    token = bridge.redroid_qr_token(session_id)
    approved = redroid_request(controller, "POST", "/v1/account/authorize-qr", json.dumps({
        "token": token, "approve": True,
    }).encode())
    if approved.get("status") != "approved":
        raise HTTPException(409, "Smart Life on Android did not complete approval.")
    try:
        return bridge.confirm(session_id)
    except HTTPException as error:
        if error.status_code != 409:
            raise
        sleep(2)
        return bridge.confirm(session_id)


@router.get("/login/{session_id}/qr.svg")
def qr_code(session_id: str, request: Request):
    return Response(
        request.app.state.cloud.qr_svg(session_id),
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/login/{session_id}/confirm")
def confirm_login(session_id: str, request: Request):
    return request.app.state.cloud.confirm(session_id)


@router.delete("/session")
def logout(request: Request):
    return request.app.state.cloud.logout()


@router.get("/devices")
def devices(
    request: Request, response: Response, refresh: bool = False, provider: Provider = "sharing",
    account: Account | None = Depends(authenticate),
    session: Session = Depends(get_session),
):
    from .cloud_scope import scope_for
    from .device_aliases import aliases_for_devices
    from .device_translations import cloud_translations
    from .topology import discover_device_placements

    response.headers["Cache-Control"] = "no-store"
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        account_devices = bridge.devices(refresh)
        member = bool(account and account.role == "member")
        if member:
            account_devices = [
                device for device in account_devices
                if not is_cloud_camera(device)
            ]
        snapshots = [bridge.state.snapshot(device) if provider == "sharing" else device for device in account_devices]
        rows = [safe_device(device) for device in snapshots]
        for device in snapshots:
            audit_cloud(request, bridge, provider, device)
        if rows:
            scope = scope_for(bridge, provider)
            ids = [row["id"] for row in rows]
            placements = discover_device_placements(session, bridge, scope, ids) if provider == "sharing" else {}
            aliases = aliases_for_devices(session, scope, ids)
            cloud_translations(session, scope, rows, aliases)
            overrides = {
                device_id: {"room_id": room_id, "building_id": building_id}
                for device_id, room_id, building_id in session.execute(
                    select(CloudRoomOverride.device_id, CloudRoomOverride.room_id, Room.building_id)
                    .outerjoin(Room, Room.id == CloudRoomOverride.room_id)
                    .where(CloudRoomOverride.scope == scope, CloudRoomOverride.device_id.in_(ids))
                )
            }
            labels = {(label.device_id, label.code): label.label for label in session.scalars(
                select(CloudChannelLabel).where(CloudChannelLabel.scope == scope_for(bridge, provider), CloudChannelLabel.device_id.in_([row["id"] for row in rows]))
            )}
            for row, device in zip(rows, snapshots, strict=True):
                row["aliases"] = aliases[row["id"]]
                if device.id in overrides:
                    row["app_room"] = overrides[device.id]
                if device.id in placements:
                    placement = placements[device.id]
                    row["synced_room"] = {"room_id": placement["room_id"], "building_id": placement["building_id"]}

                if member:
                    row["functions"] = member_cloud_functions(row["category"], row["functions"])
                functions, ranges = row["functions"], safe_status_ranges(device)
                for spec in functions + ranges:
                    if (device.id, spec["code"]) in labels:
                        spec["user_label"] = labels[(device.id, spec["code"])]
                row["controls"] = {
                    "ready": device.id in bridge.state.metadata if provider == "sharing" else bool(functions or ranges),
                    "definitions": {"device_id": device.id, "functions": functions, "status_range": ranges},
                    "snapshot": safe_snapshot(device, provider),
                }
    return rows


@router.put("/devices/{device_id}/room")
def assign_cloud_device_room(
    device_id: Identifier, body: CloudRoomAssignment, request: Request,
    provider: Provider = "sharing", session: Session = Depends(get_session),
):
    from .cloud_scope import scope_for

    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        scope = scope_for(bridge, provider)
        bridge.device(device_id)
        room = get_or_404(session, Room, body.room_id) if body.room_id is not None else None
        building_id = room.building_id if room else None
        statement = insert(CloudRoomOverride).values(scope=scope, device_id=device_id, room_id=body.room_id)
        session.execute(statement.on_conflict_do_update(
            index_elements=[CloudRoomOverride.scope, CloudRoomOverride.device_id],
            set_={"room_id": statement.excluded.room_id},
        ))
        commit(session)
    return {"room_id": body.room_id, "building_id": building_id}


@router.post("/imports/local-inventory")
def import_local_inventory(
    body: CloudImport,
    request: Request,
    provider: Provider = "sharing",
    session: Session = Depends(get_session),
):
    rows = []
    bridge = cloud_bridge(request, provider)
    for id in body.device_ids:
        device = bridge.device(id)
        row = {"id": device.id, "name": device.name}
        for key in ("local_key", "product_id", "category"):
            value = getattr(device, key, None)
            if value:
                row[key] = value
        if getattr(device, "sub", False):
            row["sub"] = True
        if getattr(device, "node_id", None):
            row["node_id"] = device.node_id
        if provider == "developer" and getattr(device, "gateway_id", None):
            row["gateway_id"] = device.gateway_id
        # SDK may report a public WAN IP. It is never a usable direct LAN address.
        ip = getattr(device, "ip", None)
        if ip and not getattr(device, "sub", False):
            try:
                parsed = ip_address(ip)
                if parsed.version == 4 and any(
                    parsed in ip_network(net)
                    for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
                ):
                    row["ip"] = ip
            except ValueError:
                pass
        rows.append(row)
    import_request = ImportRequest(
        devices=rows,
        parent_map=body.parent_map,
        building_id=body.building_id,
        room_id=body.room_id,
        dry_run=body.dry_run,
    )
    return import_tinytuya(session, import_request)


@router.get("/devices/{device_id}/status")
def cloud_device_status(
    device_id: Identifier,
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
    refresh: bool = False,
    provider: Provider = "sharing",
    watch: bool = False,
    account: Account | None = Depends(authenticate),
):
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        if account and account.role == "member":
            require_cloud_device(bridge.device(device_id))
        device = bridge.device_status(device_id, refresh)
        audit_cloud(request, bridge, provider, device)
        if watch and provider == "sharing" and not refresh:
            bridge.schedule_inventory_refresh(background_tasks)
            bridge.schedule_missing_light_refresh(background_tasks, device)
    response.headers["Cache-Control"] = "no-store"
    return safe_snapshot(device, provider)


@router.get("/devices/{device_id}/functions")
def cloud_device_functions(
    device_id: Identifier, request: Request, response: Response, provider: Provider = "sharing",
    account: Account | None = Depends(authenticate),
    session: Session = Depends(get_session),
):
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        device = bridge.writable_device(device_id)
        labels = channel_labels(session, bridge, provider, device_id)
        functions = safe_device(device)["functions"]
        if account and account.role == "member":
            require_cloud_device(device)
            functions = member_cloud_functions(getattr(device, "category", None), functions)
        ranges = safe_status_ranges(device)
        for spec in functions + ranges:
            if spec["code"] in labels:
                spec["user_label"] = labels[spec["code"]]
    response.headers["Cache-Control"] = "no-store"
    return {
        "device_id": device.id,
        "functions": functions,
        "status_range": ranges,
    }


@router.put("/devices/{device_id}/channel-labels")
def save_channel_labels(
    device_id: Identifier, body: ChannelLabels, request: Request, response: Response,
    provider: Provider = "sharing", session: Session = Depends(get_session),
):
    from .cloud_scope import scope_for
    from .service import commit

    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        scope = scope_for(bridge, provider)
        device = bridge.writable_device(device_id)
        available = set(device.function) | set(getattr(device, "status_range", {}))
        if not set(body.labels).issubset(available):
            raise HTTPException(422, "Channel is not available on the selected device")
        for code, label in body.labels.items():
            row = session.get(CloudChannelLabel, (scope, device_id, code))
            if label is None:
                if row is not None:
                    session.delete(row)
            elif row is not None:
                row.label = label
            else:
                session.add(CloudChannelLabel(scope=scope, device_id=device_id, code=code, label=label))
        commit(session)
        labels = channel_labels(session, bridge, provider, device_id)
    response.headers["Cache-Control"] = "no-store"
    return {"device_id": device_id, "labels": labels}


@router.post("/devices/{device_id}/commands")
def cloud_commands(
    device_id: Identifier, body: CloudCommands, request: Request, provider: Provider = "sharing",
    account: Account | None = Depends(authenticate),
):
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        device = bridge.writable_device(device_id)
        if account and account.role == "member":
            require_cloud_commands(device, body.commands)
        return execute_cloud_commands(request, bridge, provider, device, body.commands)


def execute_cloud_commands(request, bridge, provider, device, commands):
    validate_cloud_commands(device, commands)
    values = [command.model_dump() for command in commands]
    audit_cloud(request, bridge, provider, device, commands=values, outcome="sent")
    try:
        result = bridge.send_commands(device.id, values)
    except HTTPException as error:
        outcome = "rejected" if error.status_code in {400, 403, 404, 409, 422} else "unknown"
        audit_cloud(request, bridge, provider, device, commands=values, outcome=outcome)
        raise
    outcome = "accepted" if result.get("acknowledged") else "unknown"
    audit_cloud(request, bridge, provider, device, commands=values, outcome=outcome)
    return result


def validate_cloud_commands(device, commands):
    codes = [command.code for command in commands]
    if len(set(codes)) != len(codes):
        raise HTTPException(422, "Cloud command codes must be unique")
    for command in commands:
        function = device.function.get(command.code)
        if function is None:
            raise HTTPException(422, "Cloud command is not in the device writable function list")
        try:
            limits = json.loads(function.values or "{}")
        except (ValueError, TypeError):
            limits = {}
        if not isinstance(limits, dict):
            limits = {}
        valid = {
            "Boolean": type(command.value) is bool,
            "Integer": type(command.value) is int,
            "Enum": isinstance(command.value, str),
            "Json": isinstance(command.value, (dict, str)),
            "String": isinstance(command.value, str),
            "Raw": isinstance(command.value, str),
        }.get(function.type, False)
        if not valid:
            raise HTTPException(422, "Cloud command value does not match its function type")
        if function.type == "Raw":
            try:
                decoded = base64.b64decode(command.value, validate=True)
                maximum = int(limits.get("maxlen", 16384))
                if maximum < 0 or len(decoded) > min(maximum, 16384):
                    raise ValueError
            except (ValueError, TypeError, binascii.Error):
                raise HTTPException(422, "Raw command requires valid base64 within its byte limit") from None
        if function.type == "Json" and limits and command.code in {
            "music_data", "control_data", "colour_data", "colour_data_v2", "scene_data_v2"
        }:
            try:
                value = json.loads(command.value) if isinstance(command.value, str) else command.value
            except ValueError:
                raise HTTPException(422, "Lighting command requires a JSON object") from None
            validate_lighting_object(value, limits)
        if function.type == "Enum" and command.value not in limits.get("range", []):
            raise HTTPException(422, "Cloud command enum value is not allowed")
        if function.type == "Integer":
            if command.value < limits.get("min", command.value) or command.value > limits.get(
                "max", command.value
            ):
                raise HTTPException(422, "Cloud command number is outside its range")
            if limits.get("step") and (command.value - limits.get("min", 0)) % limits["step"]:
                raise HTTPException(422, "Cloud command number does not match its step")


def validate_lighting_object(value, schema):
    if not isinstance(value, dict) or set(value) != set(schema):
        raise HTTPException(422, "Lighting command fields do not match the device schema")
    for key, rule in schema.items():
        if not isinstance(rule, dict):
            raise HTTPException(422, "Invalid lighting schema")
        current = value[key]
        if "range" in rule:
            if not isinstance(current, str) or current not in rule["range"]:
                raise HTTPException(422, "Lighting command enum value is not allowed")
        elif "min" in rule and "max" in rule:
            if type(current) is not int or not rule["min"] <= current <= rule["max"]:
                raise HTTPException(422, "Lighting command value is outside its range")
            if rule.get("step") and (current - rule["min"]) % rule["step"]:
                raise HTTPException(422, "Lighting command value does not match its step")
        elif key == "scene_units":
            if not isinstance(current, list) or not 1 <= len(current) <= 32:
                raise HTTPException(422, "Lighting scene requires 1..32 steps")
            for unit in current:
                validate_lighting_object(unit, rule)
        else:
            validate_lighting_object(current, rule)


@router.get("/scenes")
def cloud_scenes(request: Request, provider: Provider = "sharing"):
    if provider == "developer":
        raise HTTPException(
            501, "Developer scene operations are not implemented; use the Sharing scene list"
        )
    return request.app.state.cloud.scenes()
