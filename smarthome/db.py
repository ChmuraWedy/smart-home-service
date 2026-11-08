import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.pool import StaticPool

from .migrations import MIGRATIONS
from .models import Base
from .search import fold_name


def make_engine(path: str):
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
        connection.create_function("unicode_casefold", 1, fold_name, deterministic=True)
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=10000")
        # Default rollback journal avoids an extra persistent WAL file on small flash.
        cursor.close()

    return engine


def init_db(engine):
    with engine.begin() as connection:
        # SQLite's driver may otherwise run DDL outside a transaction.
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        current = connection.exec_driver_sql("PRAGMA user_version").scalar_one()
        if not 0 <= current <= len(MIGRATIONS):
            raise RuntimeError(f"Unsupported database schema version {current}. This build supports up to {len(MIGRATIONS)}.")
        if current == 0:
            # Bootstrap new databases and create missing tables on unversioned installations.
            Base.metadata.create_all(connection)
        for version, upgrade in enumerate(MIGRATIONS[current:], start=current + 1):
            upgrade(connection)
            connection.exec_driver_sql(f"PRAGMA user_version = {version}")
