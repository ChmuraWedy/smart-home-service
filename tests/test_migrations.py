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

    assert schema_version(engine) == len(db.MIGRATIONS)
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


def test_upgrades_a_version_one_database_without_losing_layouts():
    engine = db.make_engine(":memory:")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE rooms (id INTEGER PRIMARY KEY)")
        connection.exec_driver_sql(
            "CREATE TABLE combined_devices (id INTEGER PRIMARY KEY, show_all_power BOOLEAN NOT NULL)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE dashboard_layouts (browser_id TEXT, view TEXT, slots JSON, PRIMARY KEY (browser_id, view))"
        )
        connection.exec_driver_sql("INSERT INTO combined_devices VALUES (1, 0)")
        connection.exec_driver_sql("INSERT INTO dashboard_layouts VALUES ('browser', 'all/all/3/1', '[null]')")
        connection.exec_driver_sql("PRAGMA user_version = 1")

    db.init_db(engine)

    assert schema_version(engine) == len(db.MIGRATIONS)
    with engine.connect() as connection:
        assert connection.exec_driver_sql(
            "SELECT show_all_power, show_member_cards, aliases FROM combined_devices"
        ).one() == (0, 0, "[]")
        assert connection.exec_driver_sql("SELECT slots, hidden_devices FROM dashboard_layouts").one() == ("[null]", "[]")
    engine.dispose()


def test_adds_name_translations_to_existing_rooms():
    engine = db.make_engine(":memory:")
    db.Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE rooms DROP COLUMN generated_name_translations")
        connection.exec_driver_sql("ALTER TABLE rooms DROP COLUMN name_translations")
        connection.exec_driver_sql("INSERT INTO buildings (id, name) VALUES (1, 'Home')")
        connection.exec_driver_sql("INSERT INTO rooms (id, building_id, name) VALUES (1, 1, 'Study')")
        connection.exec_driver_sql("PRAGMA user_version = 6")

    db.init_db(engine)

    with engine.connect() as connection:
        assert connection.exec_driver_sql(
            "SELECT name, name_translations, generated_name_translations FROM rooms"
        ).one() == ("Study", "{}", "{}")
    engine.dispose()


def test_adds_room_appearance_to_a_version_three_database_without_changing_rooms(tmp_path):
    engine = db.make_engine(str(tmp_path / "home.db"))
    db.Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TABLE room_appearances")
        connection.exec_driver_sql("INSERT INTO buildings (id, name) VALUES (1, 'Home')")
        connection.exec_driver_sql("INSERT INTO rooms (id, building_id, name) VALUES (1, 1, 'Study')")
        connection.exec_driver_sql("PRAGMA user_version = 3")

    db.init_db(engine)

    assert schema_version(engine) == len(db.MIGRATIONS)
    with engine.begin() as connection:
        assert connection.exec_driver_sql("SELECT name FROM rooms").scalar_one() == "Study"
        connection.exec_driver_sql("INSERT INTO room_appearances (room_id, card_opacity) VALUES (1, 75)")
        connection.exec_driver_sql("DELETE FROM rooms WHERE id = 1")
        assert connection.exec_driver_sql("SELECT room_id FROM room_appearances").fetchall() == []
    engine.dispose()
