from dataclasses import replace

from smarthome import auto_label_translations


def test_saving_labels_generates_variants_and_manual_edits_preserve_other_languages(client, monkeypatch):
    settings = replace(client.app.state.settings, label_translator_url="http://127.0.0.1:8093")
    monkeypatch.setattr(client.app.state, "settings", settings)
    variants = {
        "Hall lamp": {"pl": "Lampa w holu", "be": "Лямпа ў холе"},
        "entry light": {"pl": "Światło przy wejściu"},
        "side door light": {"pl": "Światło przy bocznych drzwiach"},
    }
    batches = []

    def translate(_url, originals):
        batches.append(originals)
        return {label: variants[label] for label in originals}

    monkeypatch.setattr(auto_label_translations, "translate_labels", translate)
    created = client.post("/api/v1/devices", json={
        "name": "Hall lamp", "device_id": "lamp-1", "aliases": ["entry light"],
    })
    assert created.status_code == 201, created.text
    device = created.json()
    assert device["name"] == "Hall lamp"
    assert device["translations"] == {
        "name": {"Hall lamp": variants["Hall lamp"]},
        "alias": {"entry light": variants["entry light"]},
    }
    path = f"/api/v1/devices/{device['id']}"
    body = {"kind": "name", "original": "Hall lamp", "edited": ["pl"]}
    manual = client.put(path + "/translations", json={**body, "values": {"pl": "Lampa w przedpokoju"}})
    assert manual.json()["values"] == {"pl": "Lampa w przedpokoju", "be": "Лямпа ў холе"}
    updated = client.patch(path, json={"aliases": ["side door light"]})
    assert updated.json()["translations"] == {
        "name": {"Hall lamp": {"pl": "Lampa w przedpokoju", "be": "Лямпа ў холе"}},
        "alias": {"side door light": variants["side door light"]},
    }
    cleared = client.put(path + "/translations", json={**body, "values": {}})
    assert cleared.json()["values"] == {"be": "Лямпа ў холе"}
    assert batches == [["Hall lamp", "entry light"], ["side door light"]]


def test_original_is_saved_even_when_translator_is_unavailable(client, monkeypatch):
    settings = replace(client.app.state.settings, label_translator_url="http://127.0.0.1:8093")
    monkeypatch.setattr(client.app.state, "settings", settings)

    def translate(_url, _originals):
        raise TimeoutError

    monkeypatch.setattr(auto_label_translations, "translate_labels", translate)
    created = client.post("/api/v1/devices", json={"name": "Hall lamp", "device_id": "lamp-1"})
    assert created.status_code == 201, created.text
    assert created.json()["translations"] == {"name": {}, "alias": {}}
    loaded = client.get("/api/v1/devices").json()
    assert loaded[0]["name"] == "Hall lamp"


def test_local_name_and_alias_translations_follow_the_originals(client):
    device = client.post("/api/v1/devices", json={
        "name": "Hall lamp", "device_id": "lamp-1", "aliases": ["entry light"],
    }).json()
    path = f"/api/v1/devices/{device['id']}"
    edits = (
        {"kind": "name", "original": "Hall lamp", "values": {"pl": " Lampa w holu ", "be": "Лямпа ў холе"}},
        {"kind": "alias", "original": "entry light", "values": {"ru": "Свет у входа"}},
    )
    for edit in edits:
        saved = client.put(path + "/translations", json=edit)
        assert saved.status_code == 200, saved.text
        assert saved.json()["shared"] is True
    loaded = client.get("/api/v1/devices").json()[0]
    assert loaded["name"] == "Hall lamp"
    assert loaded["aliases"] == ["Hall lamp", "entry light"]
    assert loaded["translations"] == {
        "name": {"Hall lamp": {"pl": "Lampa w holu", "be": "Лямпа ў холе"}},
        "alias": {"entry light": {"ru": "Свет у входа"}},
    }
    assert client.put(path + "/translations", json={**edits[0], "values": {"de": "Lampe"}}).status_code == 422
    assert client.put(path + "/translations", json={**edits[0], "values": {"en": "Bad\nname"}}).status_code == 422
    assert client.patch(path, json={"name": "Renamed lamp", "aliases": ["new alias"]}).status_code == 200
    assert client.put(path + "/translations", json=edits[1]).status_code == 409
    restored = client.patch(path, json={"name": "Hall lamp", "aliases": ["entry light"]}).json()
    assert restored["translations"] == {"name": {}, "alias": {}}
    assert client.put(path + "/translations", json=edits[0]).status_code == 200
    assert client.put(path + "/translations", json={**edits[0], "values": {}}).status_code == 200
    assert client.get(path).json()["translations"]["name"] == {}


def test_local_device_delete_removes_translations_before_an_id_is_reused(client):
    body = {"name": "Lamp", "device_id": "lamp-1"}
    device = client.post("/api/v1/devices", json=body).json()
    path = f"/api/v1/devices/{device['id']}"
    assert client.put(path + "/translations", json={
        "kind": "name", "original": "Lamp", "values": {"ru": "Лампа"},
    }).status_code == 200
    assert client.delete(path).status_code == 204
    assert client.post("/api/v1/devices", json=body).json()["translations"]["name"] == {}
