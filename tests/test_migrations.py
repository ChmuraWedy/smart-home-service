from concurrent.futures import ThreadPoolExecutor

import pytest

from smarthome import db


def schema_version(engine):
    with engine.connect() as connection:
        return connection.exec_driver_sql("PRAGMA user_version").scalar_one()


def test_concurrent_starts_apply_the_database_upgrade_once(tmp_path):
    path = str(tmp_path / "home.db")

    def start():
        engine = db.make_engine(path)
        try:
            db.init_db(engine)
            return schema_version(engine)
        finally:
            engine.dispose()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(lambda _: start(), range(2))) == [len(db.MIGRATIONS)] * 2


def test_failure_rolls_back_schema_changes_and_version(monkeypatch):
    engine = db.make_engine(":memory:")
    db.init_db(engine)
    before = schema_version(engine)

    def create_probe(connection):
        connection.exec_driver_sql("CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)")

    def fail(_connection):
        raise RuntimeError("migration failed")

    monkeypatch.setattr(db, "MIGRATIONS", (*db.MIGRATIONS, create_probe, fail))
    with pytest.raises(RuntimeError, match="migration failed"):
        db.init_db(engine)

    assert schema_version(engine) == before
    with engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA table_info(migration_probe)").fetchall() == []
    engine.dispose()


def test_adopts_an_unversioned_database_that_already_has_the_column():
    engine = db.make_engine(":memory:")
    db.Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "INSERT INTO combined_devices (name, members, show_all_power) VALUES ('Lights', '[]', 0)"
        )

    db.init_db(engine)

    assert schema_version(engine) == 1
    with engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT show_all_power FROM combined_devices").scalar_one() == 0
    engine.dispose()


def test_newer_schema_is_rejected_without_modification():
    engine = db.make_engine(":memory:")
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA user_version = 999")

    with pytest.raises(RuntimeError, match="Unsupported database schema version 999"):
        db.init_db(engine)

    assert schema_version(engine) == 999
    with engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall() == []
    engine.dispose()
