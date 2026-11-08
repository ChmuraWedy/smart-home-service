from collections.abc import Callable

from sqlalchemy.engine import Connection


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


# The position is the schema version. Append new upgrades and keep old ones in place.
MIGRATIONS: tuple[Callable[[Connection], None], ...] = (
    add_combined_power_visibility,
    add_combined_card_metadata,
    add_dashboard_hidden_devices,
)
