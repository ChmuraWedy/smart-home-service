from collections.abc import Callable

from sqlalchemy.engine import Connection

from .models import AccountDashboardLayout, CloudRoomOverride, HouseholdMember, RoomAppearance


def add_combined_power_visibility(connection: Connection) -> None:
    # Some unversioned databases received this column before migrations were introduced.
    columns = connection.exec_driver_sql("PRAGMA table_info(combined_devices)").fetchall()
    if not any(column[1] == "show_all_power" for column in columns):
        connection.exec_driver_sql(
            "ALTER TABLE combined_devices ADD COLUMN show_all_power BOOLEAN NOT NULL DEFAULT 1"
        )


def add_combined_card_metadata(connection: Connection) -> None:
    columns = {column[1] for column in connection.exec_driver_sql("PRAGMA table_info(combined_devices)")}
    if "show_member_cards" not in columns:
        connection.exec_driver_sql(
            "ALTER TABLE combined_devices ADD COLUMN show_member_cards BOOLEAN NOT NULL DEFAULT 0"
        )
    if "aliases" not in columns:
        connection.exec_driver_sql("ALTER TABLE combined_devices ADD COLUMN aliases JSON NOT NULL DEFAULT '[]'")


def add_dashboard_hidden_devices(connection: Connection) -> None:
    columns = {column[1] for column in connection.exec_driver_sql("PRAGMA table_info(dashboard_layouts)")}
    if "hidden_devices" not in columns:
        connection.exec_driver_sql("ALTER TABLE dashboard_layouts ADD COLUMN hidden_devices JSON NOT NULL DEFAULT '[]'")


def add_room_appearance(connection: Connection) -> None:
    RoomAppearance.__table__.create(connection, checkfirst=True)


def add_cloud_room_overrides(connection: Connection) -> None:
    CloudRoomOverride.__table__.create(connection, checkfirst=True)


def remove_manual_cloud_mappings(connection: Connection) -> None:
    connection.exec_driver_sql("DROP TABLE IF EXISTS cloud_device_mappings")


def add_room_name_translations(connection: Connection) -> None:
    columns = {column[1] for column in connection.exec_driver_sql("PRAGMA table_info(rooms)")}
    if "name_translations" not in columns:
        connection.exec_driver_sql("ALTER TABLE rooms ADD COLUMN name_translations JSON NOT NULL DEFAULT '{}'")


def add_generated_room_names(connection: Connection) -> None:
    columns = {column[1] for column in connection.exec_driver_sql("PRAGMA table_info(rooms)")}
    if "generated_name_translations" not in columns:
        connection.exec_driver_sql("ALTER TABLE rooms ADD COLUMN generated_name_translations JSON NOT NULL DEFAULT '{}'")


def add_household_accounts(connection: Connection) -> None:
    HouseholdMember.__table__.create(connection, checkfirst=True)
    AccountDashboardLayout.__table__.create(connection, checkfirst=True)
    columns = {column[1] for column in connection.exec_driver_sql("PRAGMA table_info(account_dashboard_layouts)")}
    if "hidden_devices" not in columns:
        connection.exec_driver_sql(
            "ALTER TABLE account_dashboard_layouts ADD COLUMN hidden_devices JSON NOT NULL DEFAULT '[]'"
        )


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
    add_household_accounts,
)
