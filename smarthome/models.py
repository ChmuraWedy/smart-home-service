from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    false,
    true,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class DashboardLayout(Base):
    __tablename__ = "dashboard_layouts"
    browser_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    view: Mapped[str] = mapped_column(String(64), primary_key=True)
    slots: Mapped[list[str | None]] = mapped_column(JSON)
    hidden_devices: Mapped[list[str]] = mapped_column(JSON, server_default="[]")


class LightPreset(Base):
    __tablename__ = "light_presets"
    __table_args__ = (UniqueConstraint("device_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(80))
    scene: Mapped[dict] = mapped_column(JSON)
    tuya_scene_id: Mapped[str | None] = mapped_column(String(128))


class CombinedDevice(Base):
    """Dashboard-only virtual device. Each member pins a physical identity and route."""

    __tablename__ = "combined_devices"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    room_id: Mapped[int | None] = mapped_column(ForeignKey("rooms.id", ondelete="SET NULL"))
    members: Mapped[list[dict[str, str | None]]] = mapped_column(JSON)
    show_all_power: Mapped[bool] = mapped_column(Boolean, server_default=true())
    show_member_cards: Mapped[bool] = mapped_column(Boolean, server_default=false())
    aliases: Mapped[list[str]] = mapped_column(JSON, server_default="[]")


class CloudChannelLabel(Base):
    __tablename__ = "cloud_channel_labels"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    code: Mapped[str] = mapped_column(String(128), primary_key=True)
    label: Mapped[str] = mapped_column(String(120))


class CloudDeviceAlias(Base):
    __tablename__ = "cloud_device_aliases"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    alias: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(128), index=True)


class DeviceTranslation(Base):
    __tablename__ = "device_translations"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    original: Mapped[str] = mapped_column(String(256), primary_key=True)
    values: Mapped[dict[str, str]] = mapped_column(JSON)


class CloudDeviceMapping(Base):
    """User-maintained map; never presented as an applied Tuya association."""

    __tablename__ = "cloud_device_mappings"
    __table_args__ = (UniqueConstraint(
        "scope", "kind", "source_device_id", "source_code", "target_device_id", "target_code"
    ),)
    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    source_device_id: Mapped[str] = mapped_column(String(128), index=True)
    source_code: Mapped[str] = mapped_column(String(128))
    source_dp_id: Mapped[int | None]
    target_device_id: Mapped[str] = mapped_column(String(128))
    target_code: Mapped[str] = mapped_column(String(128))
    target_dp_id: Mapped[int | None]


class AliasOwner:
    @property
    def aliases(self) -> list[str]:
        from .search import fold_name

        # The current human name is an automatic alias, including on old databases.
        return [
            self.name,
            *sorted(
                entry.alias
                for entry in self.alias_entries
                if fold_name(entry.alias) != fold_name(self.name)
            ),
        ]


class CloudHome(Base):
    __tablename__ = "cloud_homes"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    home_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    building_id: Mapped[int | None] = mapped_column(ForeignKey("buildings.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(120))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class CloudRoom(Base):
    __tablename__ = "cloud_rooms"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    home_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    room_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    local_room_id: Mapped[int | None] = mapped_column(ForeignKey("rooms.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(120))
    imported_name: Mapped[str] = mapped_column(String(120))


class CloudPlacement(Base):
    __tablename__ = "cloud_placements"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    home_id: Mapped[str] = mapped_column(String(128))
    room_id: Mapped[str | None] = mapped_column(String(128))
    managed: Mapped[bool] = mapped_column(Boolean, default=False)
    overridden: Mapped[bool] = mapped_column(Boolean, default=False)
    applied_building_id: Mapped[int | None]
    applied_room_id: Mapped[int | None]


class CloudTopology(Base):
    __tablename__ = "cloud_topology"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    warnings: Mapped[int] = mapped_column(default=0)


class Building(AliasOwner, Base):
    __tablename__ = "buildings"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str | None] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text)
    alias_entries: Mapped[list["BuildingAlias"]] = relationship(
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="BuildingAlias.alias",
    )


class Room(AliasOwner, Base):
    __tablename__ = "rooms"
    __table_args__ = (UniqueConstraint("building_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(
        ForeignKey("buildings.id", ondelete="RESTRICT"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    alias_entries: Mapped[list["RoomAlias"]] = relationship(
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="RoomAlias.alias",
    )


class RoomAppearance(Base):
    __tablename__ = "room_appearances"
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True)
    card_opacity: Mapped[int] = mapped_column(default=100)
    background_version: Mapped[str | None] = mapped_column(String(64))
    background: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)


class DeviceType(Base):
    __tablename__ = "device_types"
    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    capabilities: Mapped[dict] = mapped_column(JSON, default=dict)


class Device(AliasOwner, Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("parent_id", "cid"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    building_id: Mapped[int | None] = mapped_column(
        ForeignKey("buildings.id", ondelete="RESTRICT"), index=True
    )
    room_id: Mapped[int | None] = mapped_column(
        ForeignKey("rooms.id", ondelete="RESTRICT"), index=True
    )
    device_type_id: Mapped[int | None] = mapped_column(
        ForeignKey("device_types.id", ondelete="RESTRICT"), index=True
    )
    device_id: Mapped[str] = mapped_column(String(128), unique=True)
    local_key: Mapped[str | None] = mapped_column(String(128))
    ip: Mapped[str | None] = mapped_column(String(45))
    version: Mapped[str | None] = mapped_column(String(8))
    transport: Mapped[str] = mapped_column(String(10), default="wifi")
    is_gateway: Mapped[bool] = mapped_column(Boolean, default=False)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("devices.id", ondelete="RESTRICT"), index=True
    )
    cid: Mapped[str | None] = mapped_column(String(128))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    product_id: Mapped[str | None] = mapped_column(String(128))
    category: Mapped[str | None] = mapped_column(String(80))
    mac: Mapped[str | None] = mapped_column(String(32))
    # Device-level capability entries override entries with the same name in DeviceType.
    capabilities: Mapped[dict] = mapped_column(JSON, default=dict)
    last_dps: Mapped[dict | None] = mapped_column(JSON)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
    alias_entries: Mapped[list["DeviceAlias"]] = relationship(
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="DeviceAlias.alias",
    )


class BuildingAlias(Base):
    __tablename__ = "building_aliases"
    alias: Mapped[str] = mapped_column(String(64), primary_key=True)
    building_id: Mapped[int] = mapped_column(
        ForeignKey("buildings.id", ondelete="CASCADE"), index=True
    )


class RoomAlias(Base):
    __tablename__ = "room_aliases"
    alias: Mapped[str] = mapped_column(String(64), primary_key=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), index=True)


class DeviceAlias(Base):
    __tablename__ = "device_aliases"
    alias: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)


class DeviceObservation(Base):
    """Per-DP timestamps: an ACK or unrelated sensor reading never refreshes a value."""

    __tablename__ = "device_observations"
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True
    )
    dp: Mapped[str] = mapped_column(String(8), primary_key=True)
    value: Mapped[object] = mapped_column(JSON)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class DeviceGroup(Base):
    __tablename__ = "device_groups"
    __table_args__ = (UniqueConstraint("room_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="RESTRICT"), index=True)
    members: Mapped[list["GroupMember"]] = relationship(
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="GroupMember.position",
    )


class GroupMember(Base):
    __tablename__ = "group_members"
    group_id: Mapped[int] = mapped_column(
        ForeignKey("device_groups.id", ondelete="CASCADE"), primary_key=True
    )
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="RESTRICT"), primary_key=True
    )
    position: Mapped[int] = mapped_column()


class Display(Base):
    __tablename__ = "displays"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="RESTRICT"), index=True)
    widgets: Mapped[list["DisplayWidget"]] = relationship(
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="DisplayWidget.position",
    )


class DisplayWidget(Base):
    __tablename__ = "display_widgets"
    display_id: Mapped[str] = mapped_column(
        ForeignKey("displays.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int | None] = mapped_column(
        ForeignKey("devices.id", ondelete="RESTRICT"), index=True
    )
    group_id: Mapped[int | None] = mapped_column(
        ForeignKey("device_groups.id", ondelete="RESTRICT"), index=True
    )
    capabilities: Mapped[list] = mapped_column(JSON, default=list)


class DeviceActivity(Base):
    __tablename__ = "device_activity"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(64), index=True)
    device_id: Mapped[str] = mapped_column(String(128), index=True)
    at: Mapped[str] = mapped_column(String(40))
    observed_at: Mapped[str | None] = mapped_column(String(40))
    kind: Mapped[str] = mapped_column(String(20))
    code: Mapped[str] = mapped_column(String(128))
    value: Mapped[object] = mapped_column(JSON)
    outcome: Mapped[str | None] = mapped_column(String(20))


class ActivityValue(Base):
    __tablename__ = "device_activity_values"
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    code: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[object] = mapped_column(JSON)
    report_stamp: Mapped[str | None] = mapped_column(String(40))
