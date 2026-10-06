from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select

from .models import Device
from .schemas import DeviceCreate, DevicePatch
from .service import commit, create_device, patch_device


def rows_from_json(value):
    if isinstance(value, dict) and "devices" in value:
        value = value["devices"]
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise HTTPException(
            422, "TinyTuya file must be a list of objects or {devices: [...]} wrapper"
        )
    if len(value) > 10000:
        raise HTTPException(422, "Import is limited to 10000 rows per file")
    return value


def import_tinytuya(session, request):
    """Atomic two-pass upsert. Import stores configuration, never contacts hardware."""
    merged = {}
    for source in (request.devices, request.snapshot):
        if source is None:
            continue
        seen = set()
        for index, raw in enumerate(rows_from_json(source), start=1):
            device_id = raw.get("id") or raw.get("device_id") or raw.get("gwId")
            if not isinstance(device_id, str) or not device_id.strip():
                raise HTTPException(422, f"Import row {index} requires a nonempty string device id")
            if device_id in seen:
                raise HTTPException(422, f"Duplicate device id in import row {index}")
            seen.add(device_id)
            row = merged.setdefault(device_id, {})
            if "parent" in raw or raw.get("sub") is True:
                row["_child_hint"] = True
            # Empty snapshot fields must not erase credentials or topology from devices.json.
            for key, value in raw.items():
                if value is not None and value != "":
                    row[key] = value
            # version/ver and key/local_key are normalized *per source* so snapshots win.
            for dest, aliases in {
                "version": ("version", "ver"),
                "local_key": ("local_key", "key"),
            }.items():
                for alias in aliases:
                    if raw.get(alias) not in (None, ""):
                        row[dest] = raw[alias]
                        break
    existing = {item.device_id: item for item in session.scalars(select(Device)).all()}
    plans = {}
    for device_id, raw in merged.items():
        current = existing.get(device_id)
        parent_ref = (
            request.parent_map.get(device_id)
            or raw.get("parent")
            or raw.get("gateway_id")
            or raw.get("parent_device_id")
        )
        if parent_ref is None and current is not None and current.parent_id is not None:
            parent = session.get(Device, current.parent_id)
            parent_ref = parent.device_id
        cid = raw.get("cid") or raw.get("node_id") or (current.cid if current else None)
        if raw.get("cid") and raw.get("node_id") and raw["cid"] != raw["node_id"]:
            raise HTTPException(422, "Import cid and node_id disagree")
        child = bool(
            parent_ref
            or cid
            or raw.get("_child_hint")
            or raw.get("sub")
            or (current and current.transport == "zigbee")
        )
        if child and (not isinstance(parent_ref, str) or not parent_ref or not cid):
            raise HTTPException(
                422,
                "Zigbee import requires parent/gateway_id + cid/node_id; use parent_map for unknown parents",
            )
        if parent_ref and (
            parent_ref == device_id or parent_ref not in merged and parent_ref not in existing
        ):
            raise HTTPException(422, "Import parent is missing or references the child itself")
        plans[device_id] = {"raw": raw, "parent": parent_ref, "cid": cid, "child": child}
    gateway_ids = {plan["parent"] for plan in plans.values() if plan["parent"]}
    if any(plans.get(gateway, {}).get("child") for gateway in gateway_ids):
        raise HTTPException(
            422, "Nested gateways/cycles are unsupported; parent must be a direct Wi-Fi gateway"
        )
    if any(device_id not in plans for device_id in request.parent_map):
        raise HTTPException(422, "parent_map contains a child not present in the imported files")

    created = updated = 0
    warnings = []
    try:
        # Promote existing referenced direct devices, even if absent from the import file.
        for gateway_id in gateway_ids - plans.keys():
            gateway = existing[gateway_id]
            if gateway.transport != "wifi" or gateway.parent_id is not None:
                raise HTTPException(422, "Imported parent must be a direct Wi-Fi gateway")
            if not gateway.is_gateway:
                gateway.is_gateway = True
                updated += 1
        for child_pass in (False, True):
            for device_id, plan in plans.items():
                if plan["child"] != child_pass:
                    continue
                raw = plan["raw"]
                current = existing.get(device_id)
                values = {"device_id": device_id}
                for field in ("name", "ip", "local_key", "product_id", "category", "mac"):
                    if raw.get(field) not in (None, ""):
                        values[field] = raw[field]
                if "version" in raw:
                    values["version"] = str(raw["version"])
                if "aliases" in raw:
                    values["aliases"] = raw["aliases"]
                if current is None:
                    values.setdefault("name", device_id)
                if plan["child"]:
                    values.update(
                        transport="zigbee",
                        is_gateway=False,
                        parent_id=existing[plan["parent"]].id,
                        cid=plan["cid"],
                    )
                elif device_id in gateway_ids or raw.get("is_gateway") is True:
                    values["is_gateway"] = True
                for field in ("building_id", "room_id", "device_type_id"):
                    if getattr(request, field) is not None:
                        values[field] = getattr(request, field)
                # New children inherit the known gateway building if no placement was supplied.
                if (
                    current is None
                    and plan["child"]
                    and "building_id" not in values
                    and "room_id" not in values
                ):
                    values["building_id"] = existing[plan["parent"]].building_id
                try:
                    if current:
                        item = patch_device(session, current, DevicePatch.model_validate(values))
                        updated += 1
                    else:
                        item = create_device(session, DeviceCreate.model_validate(values))
                        created += 1
                    session.flush()
                except ValidationError:
                    raise HTTPException(
                        422,
                        "Invalid Tuya metadata or aliases in import (IP, key length, protocol version or field type)",
                    ) from None
                existing[device_id] = item
                if not plan["child"] and (not item.ip or not item.version or not item.local_key):
                    warnings.append(
                        {
                            "device_id": device_id,
                            "message": "Control needs ip + local_key + version",
                        }
                    )
        report = {
            "created": created,
            "updated": updated,
            "dry_run": request.dry_run,
            "warnings": warnings,
            "device_ids": list(plans),
        }
        if request.dry_run:
            session.rollback()
        else:
            commit(session)
        return report
    except Exception:
        session.rollback()
        raise
