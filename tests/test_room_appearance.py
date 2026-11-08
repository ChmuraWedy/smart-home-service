from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.orm import Session

from smarthome.config import Settings
from smarthome.main import create_app
from smarthome.models import RoomAppearance
from smarthome.room_appearance import MAX_IMAGE_BYTES


def image_bytes(color="red", format="PNG", size=(40, 30)):
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format=format)
    return output.getvalue()


def create_room(client, name, building_id):
    response = client.post("/api/v1/rooms", json={"building_id": building_id, "name": name})
    assert response.status_code == 201, response.text
    return "/api/v1/rooms/" + str(response.json()["id"])


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
