from collections.abc import Callable

from sqlalchemy.engine import Connection


def add_combined_power_visibility(connection: Connection) -> None:
    # Some unversioned databases received this column before migrations were introduced.
    columns = connection.exec_driver_sql("PRAGMA table_info(combined_devices)").fetchall()
    if not any(column[1] == "show_all_power" for column in columns):
        connection.exec_driver_sql(
            "ALTER TABLE combined_devices ADD COLUMN show_all_power BOOLEAN NOT NULL DEFAULT 1"
        )


# The position is the schema version. Append new upgrades and keep old ones in place.
MIGRATIONS: tuple[Callable[[Connection], None], ...] = (add_combined_power_visibility,)
