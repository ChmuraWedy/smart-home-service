from collections.abc import Callable

from sqlalchemy import inspect, select, update
from sqlalchemy.engine import Connection

from .models import (
    Building,
    CloudRoomOverride,
    Device,
    DeviceType,
    Room,
    RoomAppearance,
    cloud_status_reports,
)
from .search import fold_name


def column_names(connection: Connection, table: str) -> set[str]:
    return {column["name"] for column in inspect(connection).get_columns(table)}


def add_combined_power_visibility(connection: Connection) -> None:
    # Some unversioned databases received this column before migrations were introduced.
    if "show_all_power" not in column_names(connection, "combined_devices"):
        connection.exec_driver_sql(
            "ALTER TABLE combined_devices ADD COLUMN show_all_power BOOLEAN NOT NULL DEFAULT TRUE"
        )


def add_combined_card_metadata(connection: Connection) -> None:
    columns = column_names(connection, "combined_devices")
    if "show_member_cards" not in columns:
        connection.exec_driver_sql(
            "ALTER TABLE combined_devices ADD COLUMN show_member_cards BOOLEAN NOT NULL DEFAULT FALSE"
        )
    if "aliases" not in columns:
        connection.exec_driver_sql("ALTER TABLE combined_devices ADD COLUMN aliases JSON NOT NULL DEFAULT '[]'")


def add_dashboard_hidden_devices(connection: Connection) -> None:
    columns = column_names(connection, "dashboard_layouts")
    if "hidden_devices" not in columns:
        connection.exec_driver_sql("ALTER TABLE dashboard_layouts ADD COLUMN hidden_devices JSON NOT NULL DEFAULT '[]'")


def add_room_appearance(connection: Connection) -> None:
    RoomAppearance.__table__.create(connection, checkfirst=True)


def add_cloud_room_overrides(connection: Connection) -> None:
    CloudRoomOverride.__table__.create(connection, checkfirst=True)


def remove_manual_cloud_mappings(connection: Connection) -> None:
    connection.exec_driver_sql("DROP TABLE IF EXISTS cloud_device_mappings")


def add_room_name_translations(connection: Connection) -> None:
    columns = column_names(connection, "rooms")
    if "name_translations" not in columns:
        connection.exec_driver_sql("ALTER TABLE rooms ADD COLUMN name_translations JSON NOT NULL DEFAULT '{}'")


def add_generated_room_names(connection: Connection) -> None:
    columns = column_names(connection, "rooms")
    if "generated_name_translations" not in columns:
        connection.exec_driver_sql("ALTER TABLE rooms ADD COLUMN generated_name_translations JSON NOT NULL DEFAULT '{}'")


def add_cloud_status_reports(connection: Connection) -> None:
    cloud_status_reports.create(connection, checkfirst=True)


def add_folded_names(connection: Connection) -> None:
    for model in (Building, Room, DeviceType, Device):
        table = model.__table__
        if "folded_name" not in column_names(connection, table.name):
            connection.exec_driver_sql(
                f"ALTER TABLE {table.name} ADD COLUMN folded_name TEXT NOT NULL DEFAULT ''"
            )
        rows = connection.execute(select(table.c.id, table.c.name)).all()
        for id, name in rows:
            values = {"folded_name": fold_name(name)}
            if model is Device:
                # Backfilling a search column is not an update to the device.
                values["updated_at"] = table.c.updated_at
            connection.execute(update(table).where(table.c.id == id).values(values))


# The position is the schema version. Append new upgrades and keep old ones in place.
MIGRATIONS: tuple[Callable[[Connection], None], ...] = (
    add_combined_power_visibility,
    add_combined_card_metadata,
    add_dashboard_hidden_devices,
    add_room_appearance,
    add_cloud_room_overrides,
    remove_manual_cloud_mappings,
    add_room_name_translations,
    add_generated_room_names,
    add_cloud_status_reports,
    add_folded_names,
)
