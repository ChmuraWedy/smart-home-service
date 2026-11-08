"""Translate newly saved labels locally, without changing their original text."""

import json
import logging
from time import monotonic
from typing import NamedTuple
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError

from .device_translations import LOCAL_SCOPE, save_values
from .models import CloudDeviceAlias, Device, DeviceTranslation, Room
from .schemas import DisplayText, Locale
from .search import fold_name

logger = logging.getLogger(__name__)
translation_values = TypeAdapter(dict[Locale, DisplayText])


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Translation traffic stays between the backend and the local service.
opener = build_opener(ProxyHandler({}), NoRedirect())


class Label(NamedTuple):
    scope: str
    device_id: str
    kind: str
    original: str


def local_labels(device):
    identifier = str(device.id)
    return [Label(LOCAL_SCOPE, identifier, "name", device.name)] + [
        Label(LOCAL_SCOPE, identifier, "alias", entry.alias)
        for entry in device.alias_entries
        if fold_name(entry.alias) != fold_name(device.name)
    ]


def cloud_labels(session, scope, identifier, name):
    local = session.scalar(select(Device).where(Device.device_id == identifier))
    labels = local_labels(local) if local else []
    if name and (not local or name != local.name):
        labels.append(Label(scope, identifier, "name", name))
    aliases = session.scalars(select(CloudDeviceAlias.alias).filter_by(scope=scope, device_id=identifier))
    labels.extend(Label(scope, identifier, "alias", alias) for alias in aliases if fold_name(alias) != fold_name(name))
    return labels


def translate_labels(url, originals):
    request = Request(
        url.rstrip("/") + "/translate",
        data=json.dumps(originals, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(request, timeout=8) as response:
        raw = json.loads(response.read(64 * 1024))
    if not isinstance(raw, list) or len(raw) != len(originals):
        raise ValueError("Unexpected translation response")
    return {original: translation_values.validate_python(value) for original, value in zip(originals, raw, strict=True)}


def translate_batches(url, originals, deadline=None):
    generated = {}
    for offset in range(0, len(originals), 33):
        if deadline is not None and monotonic() + 8 > deadline:
            break
        generated.update(translate_labels(url, originals[offset:offset + 33]))
    return generated


def generate_missing(session, url, current_labels):
    """Call after saving the originals. Insert only labels that still exist and have no override."""
    if not url:
        return
    try:
        candidates = [
            label for label in current_labels()
            if 1 <= len(label.original) <= 120 and not session.get(DeviceTranslation, label)
        ]
        session.rollback()
        if not candidates:
            return
        originals = list(dict.fromkeys(label.original for label in candidates))
        generated = translate_batches(url, originals)
        if not any(generated.values()):
            return
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        current = set(current_labels())
        for label in candidates:
            values = generated.get(label.original)
            if values and label in current:
                save_values(session, *label, values, promote=True)
        session.commit()
    except (OSError, ValueError, ValidationError, SQLAlchemyError):
        session.rollback()
        logger.warning("Automatic label translation was unavailable; the original was saved.")


def translate_local_device(session, request, device):
    url = request.app.state.settings.label_translator_url
    if not url:
        return
    identifier, physical = device.id, device.device_id

    def current():
        item = session.get(Device, identifier)
        return local_labels(item) if item and item.device_id == physical else []

    generate_missing(session, url, current)


def translate_room_names(session, url, room_ids, deadline=None):
    if not url or not room_ids:
        return
    try:
        rows = session.execute(
            select(Room.id, Room.name, Room.generated_name_translations).where(Room.id.in_(room_ids))
        )
        candidates = [
            (id, name) for id, name, generated in rows
            if 1 <= len(name) <= 120 and generated.get("original") != name
        ]
        session.rollback()
        if not candidates:
            return
        generated = translate_batches(url, list(dict.fromkeys(name for _, name in candidates)), deadline)
        for id, name in candidates:
            if name not in generated:
                continue
            session.execute(
                update(Room).where(Room.id == id, Room.name == name).values(
                    generated_name_translations={"original": name, "values": generated[name]}
                )
            )
        session.commit()
    except (OSError, ValueError, ValidationError, SQLAlchemyError):
        session.rollback()
        logger.warning("Automatic room translation was unavailable; the original was saved.")
