import json
from ipaddress import ip_address, ip_network
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field, JsonValue, SecretStr, field_validator
from sqlalchemy.orm import Session

from .api_dependencies import authenticate, get_session
from .importer import import_tinytuya
from .schemas import Identifier, ImportRequest, PositiveID, Schema

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


def cloud_bridge(request, provider):
    return request.app.state.developer_cloud if provider == "developer" else request.app.state.cloud


class QRLogin(Schema):
    user_code: SecretStr | None = Field(default=None, min_length=1, max_length=128, repr=False)


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


def safe_device(device):
    fields = ("id", "name", "category", "product_id", "online", "sub", "node_id", "support_local")
    result = {name: getattr(device, name, None) for name in fields}
    result["has_local_key"] = bool(getattr(device, "local_key", None))
    result["functions"] = [
        {key: getattr(f, key, None) for key in ("code", "type", "values")}
        for f in getattr(device, "function", {}).values()
    ]
    return result


def safe_status_ranges(device):
    # Read-only sensor ranges are separate from the writable function list.
    return [
        {key: getattr(spec, key, None) for key in ("code", "type", "values")}
        for spec in getattr(device, "status_range", {}).values()
        if getattr(spec, "code", None) not in {"local_key", "key", "access_token", "refresh_token"}
    ]


@router.get("/status")
def cloud_status(request: Request, response: Response):
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
    request: Request, response: Response, refresh: bool = False, provider: Provider = "sharing"
):
    response.headers["Cache-Control"] = "no-store"
    return [safe_device(device) for device in cloud_bridge(request, provider).devices(refresh)]


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
    refresh: bool = False,
    provider: Provider = "sharing",
):
    bridge = cloud_bridge(request, provider)
    device = (
        bridge.device_status(device_id, refresh)
        if provider == "developer"
        else bridge.device(device_id, refresh)
    )
    response.headers["Cache-Control"] = "no-store"
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
        "status_range": safe_status_ranges(device),
    }


@router.get("/devices/{device_id}/functions")
def cloud_device_functions(
    device_id: Identifier, request: Request, response: Response, provider: Provider = "sharing"
):
    bridge = cloud_bridge(request, provider)
    device = (
        bridge.writable_device(device_id) if provider == "developer" else bridge.device(device_id)
    )
    response.headers["Cache-Control"] = "no-store"
    return {
        "device_id": device.id,
        "functions": safe_device(device)["functions"],
        "status_range": safe_status_ranges(device),
    }


@router.post("/devices/{device_id}/commands")
def cloud_commands(
    device_id: Identifier, body: CloudCommands, request: Request, provider: Provider = "sharing"
):
    bridge = cloud_bridge(request, provider)
    with bridge.lock:
        device = (
            bridge.writable_device(device_id)
            if provider == "developer"
            else bridge.device(device_id)
        )
        validate_cloud_commands(device, body.commands)
        return bridge.send_commands(device_id, [command.model_dump() for command in body.commands])


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
        valid = {
            "Boolean": type(command.value) is bool,
            "Integer": type(command.value) is int,
            "Enum": isinstance(command.value, str),
            "Json": isinstance(command.value, (dict, str)),
            "String": isinstance(command.value, str),
        }.get(function.type, False)
        if not valid:
            raise HTTPException(422, "Cloud command value does not match its function type")
        if function.type == "Enum" and command.value not in limits.get("range", []):
            raise HTTPException(422, "Cloud command enum value is not allowed")
        if function.type == "Integer":
            if command.value < limits.get("min", command.value) or command.value > limits.get(
                "max", command.value
            ):
                raise HTTPException(422, "Cloud command number is outside its range")
            if limits.get("step") and (command.value - limits.get("min", 0)) % limits["step"]:
                raise HTTPException(422, "Cloud command number does not match its step")


@router.get("/scenes")
def cloud_scenes(request: Request, provider: Provider = "sharing"):
    if provider == "developer":
        raise HTTPException(
            501, "Developer scene operations are not implemented; use the Sharing scene list"
        )
    return request.app.state.cloud.scenes()
