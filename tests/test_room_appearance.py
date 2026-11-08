from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.orm import Session

from smarthome import auto_label_translations
from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.models import Room, RoomAppearance
from smarthome.room_appearance import MAX_IMAGE_BYTES


def image_bytes(color="red", format="PNG", size=(40, 30)):
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format=format)
    return output.getvalue()


def create_room(client, name, building_id):
    response = client.post("/api/v1/rooms", json={"building_id": building_id, "name": name})
    assert response.status_code == 201, response.text
    return "/api/v1/rooms/" + str(response.json()["id"])


def test_room_name_translations_are_optional_and_persist_per_language(tmp_path):
    settings = Settings(database_path=str(tmp_path / "rooms.db"), display_poll_interval=0)
    with TestClient(create_app(settings)) as client:
        building_id = client.post("/api/v1/buildings", json={"name": "Home"}).json()["id"]
        body = {"building_id": building_id, "name": "Study"}
        response = client.post("/api/v1/rooms", json={
            **body, "name_translations": {"pl": " Gabinet ", "be": "Кабінет", "ru": "Кабинет"},
        })
        assert response.status_code == 201, response.text
        path = f"/api/v1/rooms/{response.json()['id']}"
        assert response.json()["name_translations"] == {"pl": "Gabinet", "be": "Кабінет", "ru": "Кабинет"}
        response = client.patch(path, json={"name_translations": {"pl": "Pracownia", "ru": None}})
        assert response.status_code == 200, response.text
        assert response.json()["name"] == "Study"
        assert response.json()["name_translations"] == {"pl": "Pracownia", "be": "Кабінет"}
        assert client.patch(path, json={"name_translations": {"fr": "Bureau"}}).status_code == 422
        assert client.patch(path, json={"name_translations": {"en": " "}}).status_code == 422
        assert client.patch(path, json={"name_translations": None}).status_code == 422
        assert client.patch(path, json={"name": "Office"}).status_code == 200

    with TestClient(create_app(settings)) as client:
        assert client.get(path).json()["name_translations"] == {"pl": "Pracownia", "be": "Кабінет"}


def test_room_names_generate_automatically_and_preserve_corrections(tmp_path, monkeypatch):
    calls = []

    def translate(_url, originals):
        calls.append(originals)
        return {name: {"en": name, "pl": "Auto PL", "be": f"Auto {name}", "ru": "Auto RU"} for name in originals}

    monkeypatch.setattr(auto_label_translations, "translate_labels", translate)
    settings = Settings(
        database_path=str(tmp_path / "rooms.db"), display_poll_interval=0,
        label_translator_url="http://127.0.0.1:8093",
    )
    with TestClient(create_app(settings)) as client:
        preview = client.post("/api/v1/rooms/translation-preview", json={"name": "Study"})
        assert preview.status_code == 200 and preview.json()["pl"] == "Auto PL"
        assert client.get("/api/v1/rooms").json() == []
        building = client.post("/api/v1/buildings", json={"name": "Home"}).json()["id"]
        room = client.post("/api/v1/rooms", json={
            "name": "Study", "building_id": building, "name_translations": {"pl": "Gabinet", "ru": None},
        }).json()
        path = f"/api/v1/rooms/{room['id']}"
        assert room["name_translations"] == {"en": "Study", "pl": "Gabinet", "be": "Auto Study"}
        assert set(room["manual_name_languages"]) == {"pl", "ru"}
        corrected = client.patch(path, json={"name_translations": {"be": None}}).json()
        assert corrected["name_translations"] == {"en": "Study", "pl": "Gabinet"}
        renamed = client.patch(path, json={"name": "Office"}).json()
        assert renamed["name_translations"] == {"en": "Office", "pl": "Gabinet"}
        assert calls == [["Study"], ["Study"], ["Office"]]

        def unavailable(*_args):
            raise OSError("Translator offline")

        monkeypatch.setattr(auto_label_translations, "translate_labels", unavailable)
        renamed = client.patch(path, json={"name": "Workshop"})
        assert renamed.status_code == 200
        assert renamed.json()["name_translations"] == {"pl": "Gabinet"}


def test_standard_room_terms_preserve_numbers_and_replace_bad_generated_values(client):
    labels = {"en": "Living room 1", "ru": "Гостиная 1", "pl": "Salon 1", "be": "Гасцёўня 1"}
    for name in ("Living room1", "LIVING   ROOM 1", "Гостиная1"):
        preview = client.post("/api/v1/rooms/translation-preview", json={"name": name})
        assert preview.status_code == 200
        assert preview.json() == labels
    building = client.post("/api/v1/buildings", json={"name": "Home"}).json()["id"]
    response = client.post("/api/v1/rooms", json={
        "name": "Living room1", "building_id": building, "name_translations": {"pl": "Pokój dzienny 1"},
    })
    assert response.status_code == 201
    assert response.json()["name_translations"] == {**labels, "pl": "Pokój dzienny 1"}
    room_id = response.json()["id"]
    with Session(client.app.state.engine) as session:
        session.get(Room, room_id).generated_name_translations = {
            "original": "Living room1", "values": {"ru": "Жизненная комната1"},
        }
        session.commit()
    refreshed = client.patch(f"/api/v1/rooms/{room_id}", json={}).json()
    assert refreshed["name"] == "Living room1"
    assert refreshed["name_translations"] == {**labels, "pl": "Pokój dzienny 1"}


def test_room_appearance_survives_restart_and_stays_isolated(tmp_path):
    settings = Settings(database_path=str(tmp_path / "rooms.db"), display_poll_interval=0)
    with TestClient(create_app(settings)) as client:
        building = client.post("/api/v1/buildings", json={"name": "Home"}).json()["id"]
        kitchen = create_room(client, "Kitchen", building)
        bedroom = create_room(client, "Bedroom", building)
        defaults = {"card_opacity": 100, "background_version": None}
        assert client.get(kitchen + "/appearance").json() == defaults
        assert client.get(kitchen + "/background").status_code == 404
        assert client.patch(kitchen + "/appearance", json={"card_opacity": 72}).json() == {
            **defaults, "card_opacity": 72,
        }
        first = client.put(kitchen + "/background", content=image_bytes(), headers={"Content-Type": "image/png"})
        assert first.status_code == 200, first.text
        assert first.json()["card_opacity"] == 72
        old_version = first.json()["background_version"]
        second = client.put(kitchen + "/background", content=image_bytes("blue"), headers={"Content-Type": "image/png"})
        assert second.status_code == 200, second.text
        assert second.json()["background_version"] != old_version
        assert client.get(bedroom + "/appearance").json() == defaults

    with TestClient(create_app(settings)) as client:
        assert client.get(kitchen + "/appearance").json() == second.json()
        image = client.get(kitchen + "/background")
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/jpeg"
        assert image.headers["cache-control"] == "private, no-store"
        assert image.headers["x-content-type-options"] == "nosniff"
        with Image.open(BytesIO(image.content)) as jpeg:
            assert jpeg.size == (40, 30)
            red, green, blue = jpeg.getpixel((2, 2))
            assert blue > 240 and red < 5 and green < 5
        assert client.delete(kitchen + "/background").json() == {**defaults, "card_opacity": 72}
        assert client.get(kitchen + "/background").status_code == 404
        assert client.delete(kitchen).status_code == 204
        assert client.get(kitchen + "/appearance").status_code == 404
        with Session(client.app.state.engine) as session:
            assert session.get(RoomAppearance, int(kitchen.rsplit("/", 1)[1])) is None


def test_appearance_requires_key_and_rejects_invalid_uploads(tmp_path):
    settings = Settings(
        api_token="test-room-key", database_path=str(tmp_path / "secure.db"), display_poll_interval=0,
    )
    with TestClient(create_app(settings)) as client:
        for method, path in (
            ("GET", "appearance"), ("PATCH", "appearance"), ("GET", "background"),
            ("PUT", "background"), ("DELETE", "background"),
        ):
            assert client.request(method, f"/api/v1/rooms/1/{path}").status_code == 401
        client.headers["X-API-Key"] = settings.api_token
        building = client.post("/api/v1/buildings", json={"name": "Home"}).json()["id"]
        room = create_room(client, "Workshop", building)
        assert client.put(room + "/background", content=b"<svg/>", headers={"Content-Type": "image/svg+xml"}).status_code == 415
        assert client.put(room + "/background", content=b"<svg/>", headers={"Content-Type": "image/png"}).status_code == 422
        assert client.put(room + "/background", content=image_bytes(), headers={"Content-Type": "image/jpeg"}).status_code == 422
        assert client.put(room + "/background", content=b"x" * (MAX_IMAGE_BYTES + 1), headers={"Content-Type": "image/png"}).status_code == 413
        assert client.put(
            room + "/background", content=image_bytes(size=(5001, 4000)), headers={"Content-Type": "image/png"},
        ).status_code == 422
        assert client.get(room + "/appearance").json() == {"card_opacity": 100, "background_version": None}


@pytest.mark.parametrize("opacity", [None, 64, 101, 80.5, "80"])
def test_opacity_validation_preserves_saved_value(client, opacity):
    building = client.post("/api/v1/buildings", json={"name": "Home"}).json()["id"]
    room = create_room(client, "Kitchen", building)
    assert client.patch(room + "/appearance", json={"card_opacity": 75}).status_code == 200
    assert client.patch(room + "/appearance", json={"card_opacity": opacity}).status_code == 422
    assert client.get(room + "/appearance").json()["card_opacity"] == 75


def test_room_delete_preserves_occupied_rooms_and_removes_only_their_layouts(client):
    building = client.post("/api/v1/buildings", json={"name": "Home"}).json()["id"]
    room = create_room(client, "Kitchen", building)
    room_id = int(room.rsplit("/", 1)[1])
    assert client.patch(room + "/appearance", json={"card_opacity": 74}).status_code == 200
    layout = "/api/v1/dashboard-layouts/" + "a" * 32
    room_view = {"building": building, "room": room_id, "columns": 3, "page": 1}
    other_view = {"building": building, "room": "all", "columns": room_id, "page": 1}
    saved = {"slots": ["device-1"]}
    assert client.put(layout, params=room_view, json=saved).status_code == 200
    assert client.put(layout, params=other_view, json=saved).status_code == 200
    device = client.post("/api/v1/devices", json={
        "device_id": "outlet-room", "name": "Outlet", "room_id": room_id, "building_id": building,
    }).json()
    assert client.delete(room).status_code == 409
    assert client.get(room + "/appearance").json()["card_opacity"] == 74
    assert client.get(layout, params=room_view).json() == saved
    assert client.patch(f"/api/v1/devices/{device['id']}", json={"room_id": None}).status_code == 200
    assert client.delete(room).status_code == 204
    assert client.get(f"/api/v1/devices/{device['id']}").json()["room_id"] is None
    assert client.get(layout, params=room_view).json() == {"slots": []}
    assert client.get(layout, params=other_view).json() == saved
