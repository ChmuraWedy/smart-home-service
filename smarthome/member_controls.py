"""Capabilities that household members may operate without changing shared setup."""

import json
import re

from fastapi import HTTPException

CAMERA_CATEGORIES = {"sp", "dghsxj"}
CAMERA_CODES = {"basic_private", "sd_format", "motion_area", "ptz_control", "record_switch"}
LIGHT_MODES = {"white", "colour", "color", "scene"}
POWER = re.compile(r"switch(?:_led|_[1-9][0-9]*)?\Z")
LIGHT_LEVEL = re.compile(r"(?:brightness|color_temperature|(?:bright|temp)_value(?:_v2)?)\Z")
COLOR = {"color", "colour_data", "colour_data_v2"}


def is_camera(category, codes):
    return category in CAMERA_CATEGORIES or not CAMERA_CODES.isdisjoint(codes)


def forbid_owner_action():
    raise HTTPException(403, "This action requires the owner account")


def local_can_write(key, definition):
    if not definition.get("writable", True):
        return False
    kind = definition.get("type")
    if POWER.fullmatch(key):
        return kind == "boolean"
    if LIGHT_LEVEL.fullmatch(key):
        return kind in {"integer", "number"}
    return key in COLOR and kind == "object"


def require_local_device(category, definitions):
    if is_camera(category, definitions):
        forbid_owner_action()


def member_local_device(device):
    require_local_device(device.category, device.capabilities)
    for key, capability in device.capabilities.items():
        capability.writable = local_can_write(key, capability.model_dump())
        capability.write_dps = {}
        capability.value_map = []
    device.last_dps = None
    device.ip = None
    device.mac = None
    return device


def require_local_commands(category, definitions, keys):
    require_local_device(category, definitions)
    if any(not local_can_write(key, definitions.get(key, {})) for key in keys):
        forbid_owner_action()


def cloud_can_write(category, code, kind):
    if not isinstance(code, str):
        return False
    if POWER.fullmatch(code):
        return kind == "Boolean"
    if category != "dj":
        return False
    if LIGHT_LEVEL.fullmatch(code):
        return kind == "Integer"
    if code in COLOR:
        return kind == "Json"
    return code == "work_mode" and kind == "Enum"


def member_cloud_functions(category, functions):
    result = []
    for spec in functions:
        code = spec["code"]
        if not cloud_can_write(category, code, spec["type"]):
            continue
        if code == "work_mode":
            try:
                limits = json.loads(spec["values"])
            except (ValueError, TypeError):
                continue
            if not isinstance(limits, dict) or not isinstance(limits.get("range"), list):
                continue
            limits["range"] = [mode for mode in limits["range"] if isinstance(mode, str) and mode in LIGHT_MODES]
            spec = {**spec, "values": json.dumps(limits)}
        result.append(spec)
    return result


def is_cloud_camera(device):
    codes = set(getattr(device, "function", {}) or {})
    codes.update(getattr(device, "status", {}) or {})
    return is_camera(getattr(device, "category", None), codes)


def require_cloud_device(device):
    if is_cloud_camera(device):
        forbid_owner_action()


def require_cloud_commands(device, commands):
    require_cloud_device(device)
    category = getattr(device, "category", None)
    for command in commands:
        kind = getattr(device.function.get(command.code), "type", None)
        if not cloud_can_write(category, command.code, kind):
            forbid_owner_action()
        if command.code == "work_mode" and (not isinstance(command.value, str) or command.value not in LIGHT_MODES):
            forbid_owner_action()
        if command.code in COLOR:
            try:
                value = json.loads(command.value) if isinstance(command.value, str) else command.value
            except ValueError:
                forbid_owner_action()
            if not isinstance(value, dict) or set(value) != {"h", "s", "v"} or any(type(axis) is not int for axis in value.values()):
                forbid_owner_action()
            if not 0 <= value["h"] <= 360 or any(not 0 <= value[axis] <= 1000 for axis in ("s", "v")):
                forbid_owner_action()
