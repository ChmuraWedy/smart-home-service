import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.pool import StaticPool

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
    Base.metadata.create_all(engine)
    # create_all leaves existing tables intact. Serialize this upgrade with other writers.
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        columns = connection.exec_driver_sql("PRAGMA table_info(combined_devices)").fetchall()
        if not any(column[1] == "show_all_power" for column in columns):
            connection.exec_driver_sql(
                "ALTER TABLE combined_devices ADD COLUMN show_all_power BOOLEAN NOT NULL DEFAULT 1"
            )
