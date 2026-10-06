from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Building(Base):
    __tablename__ = "buildings"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str | None] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text)


class Room(Base):
    __tablename__ = "rooms"
    __table_args__ = (UniqueConstraint("building_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(
        ForeignKey("buildings.id", ondelete="RESTRICT"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)


class DeviceType(Base):
    __tablename__ = "device_types"
    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    capabilities: Mapped[dict] = mapped_column(JSON, default=dict)


class Device(Base):
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
