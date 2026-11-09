import os
from pathlib import Path

from sqlalchemy import (
    JSON,
    Column,
    Integer,
    MetaData,
    Table,
    cast,
    create_engine,
    event,
    func,
    inspect,
    literal,
    select,
    text,
)
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.pool import StaticPool

from .migrations import MIGRATIONS
from .models import Base

SCHEMA_LOCK = 8329104003124
SCHEMA_VERSION = Table(
    "smart_home_schema_version",
    MetaData(),
    Column("id", Integer, primary_key=True, autoincrement=False),
    Column("version", Integer, nullable=False),
)


def make_engine(path: str, database_url: str = ""):
    if database_url:
        try:
            url = make_url(database_url)
        except (ArgumentError, ValueError):
            raise ValueError("SMART_HOME_DATABASE_URL must be a PostgreSQL URL") from None
        if url.drivername not in {"postgresql", "postgresql+psycopg"}:
            raise ValueError("SMART_HOME_DATABASE_URL must be a PostgreSQL URL")
        # SQLite returns naive UTC timestamps and existing readers interpret them as UTC.
        options = f"{url.query.get('options', '')} -ctimezone=UTC".strip()
        url = url.set(drivername="postgresql+psycopg").update_query_dict({"options": options})
        return create_engine(
            url,
            hide_parameters=True,
            pool_pre_ping=True,
        )

    memory = path == ":memory:"
    if not memory:
        file = Path(path).expanduser().resolve()
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Create restrictively before SQLite opens it (SQLite otherwise uses process umask).
        fd = os.open(file, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(file, 0o600)
        path = str(file)
    engine = create_engine(
        "sqlite://" if memory else "sqlite:///" + path,
        connect_args={"check_same_thread": False, "timeout": 10},
        **({"poolclass": StaticPool} if memory else {}),
    )

    @event.listens_for(engine, "connect")
    def configure_sqlite(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=10000")
        # Default rollback journal avoids an extra persistent WAL file on small flash.
        cursor.close()

    return engine


def upsert(bind, table):
    if bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    return insert(table)


def merge_json_object(bind, column, values):
    """Patch an object in the database so concurrent edits to other keys survive."""
    if bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import JSONB

        return cast(cast(column, JSONB).op("||")(literal(values, type_=JSONB)), JSON)
    edits = [part for key, value in values.items() for part in (f"$.{key}", value)]
    return func.json_set(column, *edits)


def lock_postgres_schema(connection):
    connection.execute(text("SELECT pg_advisory_xact_lock(:lock)"), {"lock": SCHEMA_LOCK})


def lock_writes(session):
    connection = session.connection()
    if connection.dialect.name == "postgresql":
        # Serialize the same read/modify/write operations that take SQLite's write lock.
        connection.execute(text("SELECT pg_advisory_xact_lock(:lock)"), {"lock": SCHEMA_LOCK + 1})
    else:
        connection.exec_driver_sql("BEGIN IMMEDIATE")


def _validate_schema_version(current):
    if not 0 <= current <= len(MIGRATIONS):
        raise RuntimeError(
            f"Unsupported database schema version {current}. This build supports up to {len(MIGRATIONS)}."
        )


def init_postgres_schema(connection):
    """Initialize or upgrade within the caller's locked transaction."""
    inspector = inspect(connection)
    if not inspector.has_table(SCHEMA_VERSION.name):
        existing = set(inspector.get_table_names())
        inventory_tables = set(Base.metadata.tables) | {"cloud_device_mappings"}
        if existing & inventory_tables:
            raise RuntimeError("The PostgreSQL schema contains inventory tables without a schema version.")
        SCHEMA_VERSION.create(connection)
        connection.execute(SCHEMA_VERSION.insert().values(id=1, version=0))
    current = connection.scalar(select(SCHEMA_VERSION.c.version).where(SCHEMA_VERSION.c.id == 1))
    if current is None:
        raise RuntimeError("The PostgreSQL schema version is missing.")
    _validate_schema_version(current)
    if current == 0:
        Base.metadata.create_all(connection)
    for upgrade in MIGRATIONS[current:]:
        upgrade(connection)
    if current < len(MIGRATIONS):
        connection.execute(
            SCHEMA_VERSION.update().where(SCHEMA_VERSION.c.id == 1).values(version=len(MIGRATIONS))
        )


def init_db(engine):
    with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            lock_postgres_schema(connection)
            init_postgres_schema(connection)
            return
        # SQLite's driver may otherwise run DDL outside a transaction.
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        current = connection.exec_driver_sql("PRAGMA user_version").scalar_one()
        _validate_schema_version(current)
        if current == 0:
            # Bootstrap new databases and create missing tables on unversioned installations.
            Base.metadata.create_all(connection)
        for version, upgrade in enumerate(MIGRATIONS[current:], start=current + 1):
            upgrade(connection)
            connection.exec_driver_sql(f"PRAGMA user_version = {version}")
