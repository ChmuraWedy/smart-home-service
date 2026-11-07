from fastapi.testclient import TestClient

from smarthome.config import Settings
from smarthome.main import create_app

PATH = "/api/v1/light-presets/bulb"
PRESET = {
    "name": "Kitchen warm",
    "tuya_scene_id": "scene-reference",
    "scene": {
        "scene_num": 8,
        "scene_units": [{
            "h": 0, "s": 0, "v": 0, "bright": 775, "temperature": 41,
            "unit_change_mode": "static", "unit_switch_duration": 0, "unit_gradient_duration": 0,
        }],
    },
}


def test_light_presets_persist_and_are_scoped_to_the_bulb(tmp_path):
    settings = Settings(database_path=str(tmp_path / "presets.db"), api_token="fixture-token")
    headers = {"X-API-Key": "fixture-token"}
    with TestClient(create_app(settings)) as client:
        assert client.get(PATH).status_code == 401
        saved = client.post(PATH, headers=headers, json=PRESET)
        assert saved.status_code == 201, saved.text
        preset_id = saved.json()["id"]
        assert client.post(PATH, headers=headers, json=PRESET).status_code == 409
        assert client.get("/api/v1/light-presets/other", headers=headers).json() == []
        wrong_path = f"/api/v1/light-presets/other/{preset_id}"
        assert client.delete(wrong_path, headers=headers).status_code == 404

    with TestClient(create_app(settings)) as client:
        assert client.get(PATH, headers=headers).json() == [saved.json()]
        item = f"{PATH}/{preset_id}"
        updated = {**PRESET, "name": "Renamed", "tuya_scene_id": None}
        assert client.put(item, headers=headers, json=updated).json() == {**updated, "id": preset_id}
        assert client.delete(item, headers=headers).status_code == 204
        assert client.get(PATH, headers=headers).json() == []


def test_invalid_scene_cannot_be_saved(client):
    invalid = {**PRESET, "scene": {**PRESET["scene"], "scene_units": []}}
    assert client.post(PATH, json=invalid).status_code == 422
    assert client.get(PATH).json() == []
