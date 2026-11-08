import unicodedata
from datetime import datetime
from ipaddress import IPv4Address
from typing import Annotated, ClassVar, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    JsonValue,
    SecretStr,
    field_validator,
    model_validator,
)

Name = Annotated[str, Field(min_length=1, max_length=120, pattern=r".*\S.*")]
Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^\S+$")]
DP = Annotated[str, Field(pattern=r"^[1-9][0-9]{0,4}$")]
CapName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
Version = Literal["3.1", "3.2", "3.3", "3.4", "3.5"]
PositiveID = Annotated[int, Field(gt=0)]


def clean_display_text(value):
    if isinstance(value, str):
        value = unicodedata.normalize("NFC", value).strip()
        if any(unicodedata.category(char) in {"Cc", "Cf"} for char in value):
            raise ValueError("Display translations cannot contain control characters")
    return value


Locale = Literal["en", "ru", "pl", "be"]
DisplayText = Annotated[str, BeforeValidator(clean_display_text), Field(min_length=1, max_length=120)]


def normalize_alias(value):
    return unicodedata.normalize("NFC", value).strip().casefold() if isinstance(value, str) else value


def normalize_reference(value):
    if isinstance(value, str) and value.strip()[:5].lower() == "name:":
        name = value.strip()[5:].strip()
        if not name or len(name) > 120:
            raise ValueError("Name reference requires 1..120 characters")
        return "name:" + name
    value = normalize_alias(value)
    if isinstance(value, str) and value.isascii() and value.isdecimal():
        if len(value) > 19 or int(value) > 9223372036854775807:
            raise ValueError("ID exceeds SQLite integer range")
    return value


def validate_alias(value):
    if not 1 <= len(value) <= 64 or not value[0].isalpha() or any(
        not (c.isalnum() or unicodedata.category(c).startswith("M") or c in " ._-") for c in value
    ):
        raise ValueError("Alias requires 1..64 letters, marks, digits, spaces or ._-; start with a letter")
    return value


def validate_reference(value):
    if value.startswith("name:"):
        return value
    if value.isascii() and value.isdecimal():
        if value.startswith("0"):
            raise ValueError("Positive numeric ID required")
        return value
    return validate_alias(value)


Alias = Annotated[str, BeforeValidator(normalize_alias), AfterValidator(validate_alias)]
EntityRef = Annotated[
    str,
    BeforeValidator(normalize_reference),
    Field(max_length=125, description="Numeric ID, Unicode alias, or exact name reference: name:Розетка"),
    AfterValidator(validate_reference),
]
NameQuery = Annotated[
    str,
    BeforeValidator(lambda value: value.strip() if isinstance(value, str) else value),
    Field(min_length=1, max_length=120),
]


def unique_aliases(value):
    if value is not None and len(value) != len(set(value)):
        raise ValueError("Aliases must be unique after normalization")
    return value


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True, allow_inf_nan=False)


class DeviceAliases(Schema):
    aliases: list[Alias] = Field(max_length=32)
    _unique = field_validator("aliases")(unique_aliases)


class Patch(Schema):
    non_nullable: ClassVar[set[str]] = set()

    @model_validator(mode="after")
    def prevent_null(self):
        for name in self.non_nullable & self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class AliasedSchema(Schema):
    aliases: list[NameQuery] = Field(default_factory=list, max_length=33)
    _normalize_aliases = field_validator("aliases")(lambda v: [normalize_alias(x) for x in v])
    _unique_aliases = field_validator("aliases")(unique_aliases)


class AliasedPatch(Patch):
    aliases: list[NameQuery] | None = Field(default=None, max_length=33)
    _normalize_aliases = field_validator("aliases")(
        lambda v: [normalize_alias(x) for x in v] if v is not None else v
    )
    _unique_aliases = field_validator("aliases")(unique_aliases)


Scalar = str | int | float | bool


class ValueMapping(Schema):
    value: Scalar
    raw: Scalar


class Capability(Schema):
    dp: DP
    type: Literal["boolean", "integer", "number", "string", "object"]
    readable: bool = True
    writable: bool = True
    minimum: float | None = None
    maximum: float | None = None
    enum: list[JsonValue] | None = None
    unit: str | None = Field(default=None, max_length=40)
    encoding: Literal["raw", "tuya_hsv", "tuya_rgbhsv", "tuya_hsv_json"] = "raw"
    read_dp: DP | None = None
    scale: float = Field(default=1, gt=0)
    offset: float = 0
    invert: bool = False
    raw_type: Literal["integer", "number"] | None = None
    step: float | None = Field(default=None, gt=0)
    value_map: list[ValueMapping] = Field(default_factory=list, max_length=32)
    write_dps: dict[DP, JsonValue] = Field(default_factory=dict, max_length=16)

    @field_validator("dp", mode="before")
    @classmethod
    def dp_string(cls, value):
        return str(value) if type(value) is int else value

    @model_validator(mode="after")
    def validate_bounds(self):
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("minimum must not exceed maximum")
        if (self.minimum is not None or self.maximum is not None) and self.type not in {
            "integer",
            "number",
        }:
            raise ValueError("Numeric bounds require a numeric capability")
        numeric = self.type in {"integer", "number"}
        if self.encoding != "raw" and self.type != "object":
            raise ValueError("Color encoding requires an object capability")
        if not numeric and (self.scale != 1 or self.offset != 0 or self.raw_type or self.step):
            raise ValueError("Scaling/step/raw_type require a numeric capability")
        if (
            self.invert
            and self.type != "boolean"
            and not (numeric and self.minimum is not None and self.maximum is not None)
        ):
            raise ValueError("Invert requires a boolean or bounded numeric capability")
        if self.dp in self.write_dps:
            raise ValueError("write_dps must not overwrite the capability DP")
        if self.value_map and (
            self.encoding != "raw"
            or self.scale != 1
            or self.offset != 0
            or self.invert
            or self.raw_type
        ):
            raise ValueError("value_map cannot be combined with encoding/scaling/invert/raw_type")
        for field in ("value", "raw"):
            values = [(type(getattr(x, field)), getattr(x, field)) for x in self.value_map]
            if len(set(values)) != len(values):
                raise ValueError("value_map must be reversible without duplicates")
        for entry in self.value_map:
            valid = {
                "boolean": type(entry.value) is bool,
                "integer": type(entry.value) is int,
                "number": type(entry.value) in (int, float),
                "string": isinstance(entry.value, str),
                "object": False,
            }[self.type]
            if not valid:
                raise ValueError("value_map values must match the capability type")
        return self


Capabilities = dict[CapName, Capability]


class BuildingCreate(AliasedSchema):
    name: Name
    address: str | None = Field(default=None, max_length=500)
    description: str | None = Field(default=None, max_length=4000)


class BuildingPatch(AliasedPatch):
    non_nullable = {"name", "aliases"}
    name: Name | None = None
    address: str | None = Field(default=None, max_length=500)
    description: str | None = Field(default=None, max_length=4000)


class BuildingRead(BuildingCreate):
    id: int
    aliases: list[str] = Field(default_factory=list, max_length=33)
    _normalize_aliases = field_validator("aliases")(lambda v: v)


class RoomCreate(AliasedSchema):
    building_id: PositiveID
    name: Name
    description: str | None = Field(default=None, max_length=4000)
    name_translations: dict[Locale, DisplayText] = Field(default_factory=dict)


class RoomPatch(AliasedPatch):
    non_nullable = {"building_id", "name", "aliases", "name_translations"}
    building_id: PositiveID | None = None
    name: Name | None = None
    description: str | None = Field(default=None, max_length=4000)
    name_translations: dict[Locale, DisplayText | None] | None = None


class RoomRead(RoomCreate):
    id: int
    aliases: list[str] = Field(default_factory=list, max_length=33)
    _normalize_aliases = field_validator("aliases")(lambda v: v)


class DeviceTypeCreate(Schema):
    slug: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,79}$")
    name: Name
    description: str | None = Field(default=None, max_length=4000)
    capabilities: Capabilities = Field(default_factory=dict)


class DeviceTypePatch(Patch):
    non_nullable = {"slug", "name", "capabilities"}
    slug: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_-]{0,79}$")
    name: Name | None = None
    description: str | None = Field(default=None, max_length=4000)
    capabilities: Capabilities | None = None


class DeviceTypeRead(DeviceTypeCreate):
    id: int


class DeviceFields(AliasedSchema):
    name: Name
    description: str | None = Field(default=None, max_length=4000)
    device_id: Identifier
    building_id: PositiveID | None = None
    room_id: PositiveID | None = None
    device_type_id: PositiveID | None = None
    ip: IPv4Address | None = None
    version: Version | None = None
    transport: Literal["wifi", "zigbee"] = "wifi"
    is_gateway: bool = False
    parent_id: PositiveID | None = None
    cid: Identifier | None = None
    enabled: bool = True
    product_id: str | None = Field(default=None, max_length=128)
    category: str | None = Field(default=None, max_length=80)
    mac: str | None = Field(default=None, max_length=32)
    capabilities: Capabilities = Field(default_factory=dict)

    @field_validator("ip")
    @classmethod
    def unicast_ip(cls, value):
        if value is not None and (
            value.is_unspecified or value.is_multicast or str(value) == "255.255.255.255"
        ):
            raise ValueError("A concrete unicast IPv4 address is required")
        return value


class DeviceCreate(DeviceFields):
    local_key: SecretStr | None = Field(
        default=None, repr=False, description="Write-only; 16 ASCII characters"
    )
    node_id: Identifier | None = Field(default=None, description="Alias for cid")

    @field_validator("local_key")
    @classmethod
    def key_length(cls, value):
        if value is not None:
            key = value.get_secret_value()
            if len(key) != 16 or not key.isascii() or not key.isprintable():
                raise ValueError("local_key must contain exactly 16 printable ASCII characters")
        return value

    @model_validator(mode="after")
    def cid_alias(self):
        if self.node_id is not None:
            if self.cid is not None and self.cid != self.node_id:
                raise ValueError("cid and node_id must match")
            self.cid = self.node_id
        return self


class DevicePatch(AliasedPatch):
    non_nullable = {
        "name",
        "device_id",
        "transport",
        "is_gateway",
        "enabled",
        "capabilities",
        "aliases",
    }
    name: Name | None = None
    description: str | None = Field(default=None, max_length=4000)
    device_id: Identifier | None = None
    building_id: PositiveID | None = None
    room_id: PositiveID | None = None
    device_type_id: PositiveID | None = None
    local_key: SecretStr | None = Field(default=None, repr=False)
    ip: IPv4Address | None = None
    version: Version | None = None
    transport: Literal["wifi", "zigbee"] | None = None
    is_gateway: bool | None = None
    parent_id: PositiveID | None = None
    cid: Identifier | None = None
    node_id: Identifier | None = None
    enabled: bool | None = None
    product_id: str | None = Field(default=None, max_length=128)
    category: str | None = Field(default=None, max_length=80)
    mac: str | None = Field(default=None, max_length=32)
    capabilities: Capabilities | None = None

    _key_length = field_validator("local_key")(DeviceCreate.key_length.__func__)
    _unicast_ip = field_validator("ip")(DeviceFields.unicast_ip.__func__)

    @model_validator(mode="after")
    def cid_alias(self):
        if "node_id" in self.model_fields_set:
            if "cid" in self.model_fields_set and self.cid != self.node_id:
                raise ValueError("cid and node_id must match")
            self.cid = self.node_id
            self.model_fields_set.add("cid")
        return self


class DeviceRead(DeviceFields):
    id: int
    translations: dict[str, dict[str, dict[str, str]]] = Field(default_factory=dict)
    aliases: list[str] = Field(default_factory=list, max_length=33)
    _normalize_aliases = field_validator("aliases")(lambda v: v)
    node_id: str | None
    has_local_key: bool
    last_dps: dict[str, JsonValue] | None
    last_seen_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AliasCreate(Schema):
    alias: Alias


class RoomTree(RoomRead):
    devices: list[DeviceRead]


class BuildingTree(BuildingRead):
    rooms: list[RoomTree]
    unassigned_devices: list[DeviceRead]


class DPSCommand(Schema):
    dps: dict[DP, JsonValue] = Field(min_length=1, max_length=64)


class SwitchCommand(Schema):
    dp: DP | None = None


class CapabilityCommand(Schema):
    value: JsonValue


class HSV(Schema):
    h: Annotated[int, Field(strict=True, ge=0, le=360)]
    s: Annotated[int, Field(strict=True, ge=0, le=1000)]
    v: Annotated[int, Field(strict=True, ge=0, le=1000)]


class CommandRead(Schema):
    device_id: int
    command: str
    acknowledged: bool
    dps: dict[str, JsonValue]
    observed_at: datetime


class CapabilityState(Schema):
    value: JsonValue | None = None
    known: bool = False
    stale: bool = True
    observed_at: datetime | None = None


class DeviceState(Schema):
    device_id: int
    name: str
    enabled: bool
    available: bool
    values: dict[str, CapabilityState]


class CapabilitiesCommand(Schema):
    values: dict[CapName, JsonValue] = Field(min_length=1, max_length=16)


class GroupCreate(Schema):
    name: Name
    room_id: PositiveID
    device_ids: list[PositiveID] = Field(min_length=1, max_length=16)

    @field_validator("device_ids")
    @classmethod
    def unique_members(cls, values):
        if len(set(values)) != len(values):
            raise ValueError("Group members must be unique")
        return values


class GroupPatch(Patch):
    non_nullable = {"name", "room_id", "device_ids"}
    name: Name | None = None
    room_id: PositiveID | None = None
    device_ids: list[PositiveID] | None = Field(default=None, min_length=1, max_length=16)
    _unique_members = field_validator("device_ids")(
        lambda v: GroupCreate.unique_members(v) if v is not None else v
    )


class GroupRead(GroupCreate):
    id: int


DisplayID = Annotated[str, Field(pattern=r"^[a-z][a-z0-9._-]{0,63}$")]


class WidgetSelection(Schema):
    kind: Literal["device", "group"]
    id: PositiveID
    capabilities: list[CapName] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def valid_selection(self):
        if self.kind == "group" and self.capabilities:
            raise ValueError("Group widgets do not select individual capabilities")
        if len(set(self.capabilities)) != len(self.capabilities):
            raise ValueError("Capabilities must be unique")
        return self


class DisplayConfig(Schema):
    name: Name
    room_id: PositiveID
    widgets: list[WidgetSelection] = Field(default_factory=list, max_length=12)

    @field_validator("widgets")
    @classmethod
    def unique_widgets(cls, widgets):
        targets = [(w.kind, w.id) for w in widgets]
        if len(set(targets)) != len(targets):
            raise ValueError("Widget targets must be unique")
        return widgets


class DisplayRead(DisplayConfig):
    id: str


class ImportRequest(Schema):
    devices: JsonValue = Field(
        description="TinyTuya devices.json: list or {devices: [...]} wrapper"
    )
    snapshot: JsonValue | None = None
    building_id: PositiveID | None = None
    room_id: PositiveID | None = None
    device_type_id: PositiveID | None = None
    parent_map: dict[Identifier, Identifier] = Field(
        default_factory=dict, description="child Tuya ID -> gateway Tuya ID"
    )
    dry_run: bool = False
