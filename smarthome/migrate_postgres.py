"""Copy an existing SQLite installation into an empty PostgreSQL schema."""

import argparse
import json
import sqlite3
import sys
import tempfile
from contextlib import closing
from datetime import timezone
from pathlib import Path

from sqlalchemy import JSON, DateTime, Text, cast, func, inspect, null, select, text
from sqlalchemy.exc import SQLAlchemyError

from .config import Settings
from .db import init_db, init_postgres_schema, lock_postgres_schema, make_engine
from .models import Base, Device

BATCH_SIZE = 200


class MigrationError(ValueError):
    """A migration error whose message can be displayed safely."""


def snapshot_sqlite(source_path, snapshot_path):
    source = Path(source_path).expanduser().resolve(strict=True)
    if not source.is_file():
        raise MigrationError("The SQLite source must be an existing database file.")
    with (
        closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as source_db,
        closing(sqlite3.connect(snapshot_path)) as snapshot_db,
    ):
        source_db.backup(snapshot_db)


def sequence_high_water(source):
    if not inspect(source).has_table("sqlite_sequence"):
        return {}
    return dict(source.exec_driver_sql("SELECT name, seq FROM sqlite_sequence").all())


def restart_postgres_sequence(target, table, column, next_id):
    sequence = target.execute(
        text("""
            SELECT namespace.nspname, sequence.relname
            FROM pg_class AS sequence
            JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
            WHERE sequence.oid = CAST(pg_get_serial_sequence(:table, :column) AS regclass)
        """),
        {"table": table.name, "column": column.name},
    ).one()
    quote = target.dialect.identifier_preparer.quote_identifier
    # The identifiers come from PostgreSQL's catalogs, and ALTER SEQUENCE is transactional.
    target.exec_driver_sql(f"ALTER SEQUENCE {quote(sequence[0])}.{quote(sequence[1])} RESTART WITH {next_id}")


def copy_rows(source, target, table):
    json_columns = [column.name for column in table.columns if isinstance(column.type, JSON)]
    utc_columns = [
        column.name for column in table.columns
        if isinstance(column.type, DateTime) and column.type.timezone
    ]
    # Read raw JSON text to preserve the distinction between SQL NULL and JSON null.
    query = select(*[
        cast(column, Text).label(column.name) if column.name in json_columns else column
        for column in table.columns
    ])
    deferred_parents = []
    count = 0
    for batch in source.execute(query).mappings().partitions(BATCH_SIZE):
        rows = []
        for source_row in batch:
            row = dict(source_row)
            for name in json_columns:
                row[name] = null() if row[name] is None else json.loads(row[name])
            for name in utc_columns:
                value = row[name]
                if value is not None and value.tzinfo is None:
                    row[name] = value.replace(tzinfo=timezone.utc)
            if table is Device.__table__ and row["parent_id"] is not None:
                # Imported Zigbee children can have lower IDs than their gateway.
                deferred_parents.append((row["id"], row["parent_id"]))
                row["parent_id"] = None
            rows.append(row)
        target.execute(table.insert(), rows)
        count += len(rows)
    for device_id, parent_id in deferred_parents:
        target.execute(
            table.update().where(table.c.id == device_id).values(
                parent_id=parent_id, updated_at=table.c.updated_at
            )
        )
    if target.scalar(select(func.count()).select_from(table)) != count:
        raise MigrationError(f"Row verification failed for {table.name}.")
    return count


def _validate_source(source, *, allow_legacy_mappings=False):
    tables = set(inspect(source).get_table_names())
    if not {"buildings", "rooms", "devices"} <= tables:
        raise MigrationError("The SQLite source does not have the Smart Home inventory schema.")
    allowed = set(Base.metadata.tables)
    if allow_legacy_mappings:
        allowed.add("cloud_device_mappings")
    if tables - allowed:
        raise MigrationError("The SQLite source contains unrecognized tables.")


def _validate_target(target):
    inspector = inspect(target)
    if (
        inspector.get_table_names() or inspector.get_view_names()
        or inspector.get_materialized_view_names() or inspector.get_sequence_names()
    ):
        raise MigrationError("Use an empty PostgreSQL schema for the migration.")
    encoding = target.exec_driver_sql("SHOW server_encoding").scalar_one()
    if encoding != "UTF8":
        raise MigrationError("Use a PostgreSQL database with UTF-8 encoding.")


def migrate_sqlite(source_path, database_url):
    if not database_url:
        raise MigrationError("Set SMART_HOME_DATABASE_URL to the empty PostgreSQL target.")
    target_engine = make_engine("", database_url)
    try:
        with tempfile.TemporaryDirectory(prefix="smart-home-db-migration-") as temp:
            snapshot_path = Path(temp) / "snapshot.db"
            snapshot_sqlite(source_path, snapshot_path)
            source_engine = make_engine(str(snapshot_path))
            try:
                with source_engine.connect() as source:
                    _validate_source(source, allow_legacy_mappings=True)
                init_db(source_engine)
                with source_engine.connect() as source, target_engine.begin() as target:
                    _validate_source(source)
                    lock_postgres_schema(target)
                    _validate_target(target)
                    init_postgres_schema(target)
                    high_water = sequence_high_water(source)
                    counts = {}
                    for table in Base.metadata.sorted_tables:
                        counts[table.name] = copy_rows(source, target, table)
                        column = table.autoincrement_column
                        if column is not None:
                            largest = target.scalar(select(func.max(column))) or 0
                            next_id = max(largest, high_water.get(table.name, 0), 0) + 1
                            restart_postgres_sequence(target, table, column, next_id)
                    return counts
            finally:
                source_engine.dispose()
    finally:
        target_engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", required=True, help="Path to the existing SQLite database")
    args = parser.parse_args()
    try:
        counts = migrate_sqlite(args.sqlite, Settings().database_url)
    except MigrationError as exc:
        print(f"Migration failed. {exc}", file=sys.stderr)
        raise SystemExit(1) from None
    except (OSError, ImportError, RuntimeError, ValueError, sqlite3.Error, SQLAlchemyError):
        print(
            "Migration failed. Check the source schema, PostgreSQL connection, and installed database driver.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
    print(json.dumps(counts, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
