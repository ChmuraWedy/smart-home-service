import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, null, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

from smarthome.config import Settings
from smarthome.db import MIGRATIONS, SCHEMA_VERSION, init_db, make_engine
from smarthome.main import create_app
from smarthome.migrate_postgres import migrate_sqlite
from smarthome.models import (
    Base,
    Building,
    CombinedDevice,
    DashboardLayout,
    Device,
    DeviceAlias,
    DeviceType,
    Room,
    RoomAppearance,
    cloud_status_reports,
)

BROWSER = "a" * 32
LAYOUT_PATH = f"/api/v1/dashboard-layouts/{BROWSER}"
LAYOUT_VIEW = {"building": "all", "room": "all", "columns": 2, "page": 1}
LEGACY_TIME = datetime(2026, 9, 1, 7, 32, tzinfo=timezone.utc)
GATEWAY_ID = 2 ** 31 + 8


@pytest.fixture
def postgres_url():
    url = os.getenv("SMART_HOME_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Set SMART_HOME_TEST_POSTGRES_URL to run tests on PostgreSQL.")
    schema = f"test_{uuid4().hex}"
    engine = make_engine("", url)
    try:
        with engine.begin() as connection:
            connection.execute(CreateSchema(schema))
        try:
            url = make_url(url)
            options = f"{url.query.get('options', '')} -csearch_path={schema}".strip()
            yield url.update_query_dict({"options": options}).render_as_string(hide_password=False)
        finally:
            with engine.begin() as connection:
                connection.execute(DropSchema(schema, cascade=True))
    finally:
        engine.dispose()


def seed_legacy_inventory(path):
    engine = make_engine(str(path))
    try:
        init_db(engine)
        with Session(engine) as session:
            session.add_all([
                Building(id=3, name="Home"),
                DeviceType(id=4, slug="outlet", name="Gniazdo"),
            ])
            session.flush()
            session.add(Room(id=5, building_id=3, name="Пакоі", name_translations={"en": "Rooms"}))
            session.flush()
            session.add(Device(
                id=GATEWAY_ID, name="Gateway", device_id="gateway", is_gateway=True, local_key="example-key",
            ))
            session.flush()
            session.add(Device(
                id=6, name="Straße 50%_Plug", device_id="plug", parent_id=GATEWAY_ID, cid="plug-child",
                building_id=3, room_id=5, device_type_id=4, transport="zigbee",
                last_dps=null(), updated_at=LEGACY_TIME,
            ))
            session.flush()
            session.add_all([
                DeviceAlias(alias="кава", device_id=6),
                CombinedDevice(id=30, name="Group", room_id=5, members=[{"device_id": "plug"}]),
                CombinedDevice(id=43, name="Deleted group", room_id=5, members=[]),
                DashboardLayout(browser_id=BROWSER, view="all/all/2/1", slots=["combined-30"]),
                RoomAppearance(room_id=5, card_opacity=62, background=b"private-image"),
            ])
            session.commit()
        with engine.begin() as connection:
            connection.execute(cloud_status_reports.insert().values(
                scope="fixture-account", device_id="plug", code="switch", value="false",
                received_at="2026-09-01T07:32:00+00:00",
            ))
            connection.execute(CombinedDevice.__table__.delete().where(CombinedDevice.id == 43))
            for model in (Building, DeviceType, Room, Device):
                connection.exec_driver_sql(f"ALTER TABLE {model.__tablename__} DROP COLUMN folded_name")
            connection.exec_driver_sql("PRAGMA user_version = 8")
    finally:
        engine.dispose()


def test_migrate_existing_installation_and_start_api(tmp_path, postgres_url):
    sqlite_path = tmp_path / "existing.db"
    seed_legacy_inventory(sqlite_path)
    before = sqlite_path.read_bytes()

    counts = migrate_sqlite(sqlite_path, postgres_url)
    assert counts.keys() == Base.metadata.tables.keys()
    assert counts["devices"] == 2
    assert counts["cloud_status_reports"] == 1
    assert sqlite_path.read_bytes() == before
    with pytest.raises(ValueError, match="empty PostgreSQL schema"):
        migrate_sqlite(sqlite_path, postgres_url)

    settings = Settings(
        database_path=str(tmp_path / "unused.db"),
        database_url=postgres_url,
        display_poll_interval=0,
    )
    with TestClient(create_app(settings)) as client:
        device = client.get("/api/v1/devices/name:STRASSE%2050%25_Plug").json()
        assert device["id"] == 6
        assert device["parent_id"] == GATEWAY_ID
        assert "local_key" not in device
        assert client.get("/api/v1/devices/КАВА").json()["id"] == 6
        matches = client.get("/api/v1/devices", params={"q": "%_"}).json()
        assert [entry["id"] for entry in matches] == [6]
        assert client.get(LAYOUT_PATH, params=LAYOUT_VIEW).json() == {"slots": ["combined-30"]}
        changed = {"slots": ["combined-30", None], "hidden_devices": ["device-plug"]}
        assert client.put(LAYOUT_PATH, params=LAYOUT_VIEW, json=changed).json() == changed
        assert client.get(LAYOUT_PATH, params=LAYOUT_VIEW).json() == changed

        with Session(client.app.state.engine) as session:
            assert session.get(Room, 5).name_translations == {"en": "Rooms"}
            assert session.get(RoomAppearance, 5).background == b"private-image"
            assert session.get(Device, GATEWAY_ID).local_key == "example-key"
            assert session.get(Device, 6).updated_at == LEGACY_TIME
            assert session.get(Device, 6).updated_at.utcoffset() == timedelta(0)
            assert session.scalar(select(Device.id).where(Device.id == 6, Device.last_dps.is_(None))) == 6
            assert session.scalar(select(cloud_status_reports.c.value)) == "false"
            assert session.scalar(select(SCHEMA_VERSION.c.version)) == len(MIGRATIONS)
            combination = CombinedDevice(name="New group", room_id=5, members=[])
            session.add(combination)
            session.flush()
            assert combination.id == 44
            session.rollback()

        assert client.patch("/api/v1/rooms/5", json={"name_translations": {"pl": "Pokoje"}}).json()[
            "name_translations"
        ] == {"en": "Rooms", "pl": "Pokoje"}
        assert client.patch("/api/v1/rooms/5", json={"name_translations": {"en": None}}).json()[
            "name_translations"
        ] == {"pl": "Pokoje"}
        assert client.patch("/api/v1/rooms/5/appearance", json={"card_opacity": 70}).json()[
            "card_opacity"
        ] == 70
        assert client.get("/api/v1/rooms/5/background").content == b"private-image"

        assert client.patch("/api/v1/devices/6", json={"name": "Światło"}).status_code == 200
        assert client.get("/api/v1/devices/name:ŚWIATŁO").json()["id"] == 6
        assert client.get("/api/v1/devices/name:STRASSE%2050%25_Plug").status_code == 404
        assert client.post("/api/v1/devices", json={"name": "Fresh", "device_id": "fresh"}).json()["id"] > GATEWAY_ID

    assert not (tmp_path / "unused.db").exists()


def test_failed_copy_rolls_back_tables_and_can_be_retried(tmp_path, postgres_url):
    sqlite_path = tmp_path / "existing.db"
    seed_legacy_inventory(sqlite_path)
    source = make_engine(str(sqlite_path))
    try:
        with source.begin() as connection:
            connection.execute(Device.__table__.update().where(Device.id == 6).values(name="x" * 121))
        before = sqlite_path.read_bytes()
        with pytest.raises(SQLAlchemyError):
            migrate_sqlite(sqlite_path, postgres_url)
        assert sqlite_path.read_bytes() == before

        target = make_engine("", postgres_url)
        try:
            assert inspect(target).get_table_names() == []
            assert inspect(target).get_sequence_names() == []
        finally:
            target.dispose()
        with source.begin() as connection:
            connection.execute(Device.__table__.update().where(Device.id == 6).values(name="Plug"))
        assert migrate_sqlite(sqlite_path, postgres_url)["devices"] == 2
    finally:
        source.dispose()


def test_concurrent_startup_and_postgres_reports(tmp_path, postgres_url):
    engine = make_engine("", postgres_url)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: init_db(engine), range(2)))
        with engine.connect() as connection:
            assert connection.scalar(select(SCHEMA_VERSION.c.version)) == len(MIGRATIONS)

        settings = Settings(database_path=str(tmp_path / "unused.db"), database_url=postgres_url)
        with TestClient(create_app(settings)) as client:
            bridge = client.app.state.cloud
            bridge.auth = {"token_info": {"uid": "test-uid"}}
            store = bridge.state.store
            report = {"value": True, "observed_at": None, "received_at": "2026-09-01T07:32:00+00:00"}
            store.save("device", {"switch": report})
            revised = {**report, "value": False}
            store.save("device", {"switch": revised})
            assert store.load("device") == {"switch": revised}
            bridge.auth = {"token_info": {"uid": "another-uid"}}
            assert store.load("device") == {}
            bridge.auth = {"token_info": {"uid": "test-uid"}}
            store.clear("device")
            assert store.load("device") == {}
    finally:
        engine.dispose()



def test_refuses_to_adopt_unversioned_inventory(postgres_url):
    engine = make_engine("", postgres_url)
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE buildings (id integer PRIMARY KEY)"))
        with pytest.raises(RuntimeError, match="without a schema version"):
            init_db(engine)
        assert inspect(engine).get_table_names() == ["buildings"]
    finally:
        engine.dispose()


def test_migrates_household_keys_and_private_layouts(tmp_path, postgres_url):
    sqlite_path = tmp_path / "household.db"
    owner = {"X-API-Key": "test-owner-key"}
    layout_path = "/api/v1/dashboard-layouts/me"
    layout = {"slots": ["device-light"]}
    with TestClient(create_app(Settings(database_path=str(sqlite_path), api_token=owner["X-API-Key"]))) as source:
        issued = source.post("/api/v1/accounts", headers=owner, json={
            "name": "Member", "login": "member", "device_name": "Phone",
        })
        assert issued.status_code == 201
        member = issued.json()
        member_key = {"X-API-Key": member["access_key"]}
        assert source.put(layout_path, headers=member_key, params=LAYOUT_VIEW, json=layout).json() == layout

    before = sqlite_path.read_bytes()
    assert migrate_sqlite(sqlite_path, postgres_url)["household_device_keys"] == 1
    settings = Settings(database_path=str(sqlite_path), database_url=postgres_url, api_token=owner["X-API-Key"])
    with TestClient(create_app(settings)) as target:
        assert target.get("/api/v1/accounts/me", headers=member_key).json()["login"] == "member"
        reveal = target.get(f"/api/v1/accounts/{member['id']}/key", headers=owner)
        assert reveal.json()["access_key"] == member["access_key"]
        assert target.get(layout_path, headers=member_key, params=LAYOUT_VIEW).json() == layout
        assert target.get(layout_path, headers=owner, params=LAYOUT_VIEW).json() == {"slots": []}
        updated = {"slots": [None, "device-light"]}
        assert target.put(layout_path, headers=member_key, params=LAYOUT_VIEW, json=updated).json() == updated
        assert target.put("/api/v1/accounts/owner", headers=owner, json={"name": "Owner", "login": "home-owner"}).status_code == 200
        assert target.delete(f"/api/v1/accounts/{member['id']}", headers=owner).status_code == 204
        assert target.get("/api/v1/accounts/me", headers=member_key).status_code == 401
    assert sqlite_path.read_bytes() == before


def test_postgres_upgrades_legacy_member_access_keys(postgres_url):
    engine = make_engine("", postgres_url)
    try:
        init_db(engine)
        member_id = "a" * 32
        digest = "d" * 64
        with engine.begin() as connection:
            connection.exec_driver_sql("DROP TABLE household_device_keys")
            connection.exec_driver_sql("DROP TABLE household_owner")
            connection.exec_driver_sql("ALTER TABLE household_members DROP COLUMN login, DROP COLUMN sealed_key")
            connection.execute(text(
                "INSERT INTO household_members (id, name, key_digest) VALUES (:id, 'Legacy member', :digest)"
            ), {"id": member_id, "digest": digest})
            connection.execute(SCHEMA_VERSION.update().values(version=9))

        init_db(engine)
        with engine.connect() as connection:
            assert connection.scalar(select(SCHEMA_VERSION.c.version)) == len(MIGRATIONS)
            assert connection.exec_driver_sql("SELECT login FROM household_members").scalar_one() == "user-" + member_id
            assert connection.exec_driver_sql(
                "SELECT id, member_id, key_digest FROM household_device_keys"
            ).one() == (member_id, member_id, digest)
    finally:
        engine.dispose()
