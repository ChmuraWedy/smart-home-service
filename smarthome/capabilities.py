"""Small, explicit DPS adapters. No product category implies a universal DP map."""

import colorsys
import json
import math

from fastapi import HTTPException
from pydantic import ValidationError

from .schemas import HSV, Capability


def same(a, b):
    return type(a) is type(b) and a == b


def validate_value(spec: Capability, value):
    valid = {
        "boolean": type(value) is bool,
        "integer": type(value) is int,
        "number": type(value) in (int, float) and math.isfinite(value),
        "string": isinstance(value, str),
        "object": isinstance(value, dict),
    }[spec.type]
    if not valid:
        raise ValueError("Value does not match capability type")
    if spec.minimum is not None and value < spec.minimum:
        raise ValueError("Value is below capability minimum")
    if spec.maximum is not None and value > spec.maximum:
        raise ValueError("Value exceeds capability maximum")
    if spec.enum is not None and not any(same(value, option) for option in spec.enum):
        raise ValueError("Value is not in capability enum")
    return value


def encode(spec: Capability, value):
    validate_value(spec, value)
    if spec.value_map:
        for entry in spec.value_map:
            if same(value, entry.value):
                return entry.raw
        raise ValueError("Value has no raw mapping")
    if spec.encoding != "raw":
        hsv = HSV.model_validate(value)
        if spec.encoding == "tuya_hsv":
            return f"{hsv.h:04x}{hsv.s:04x}{hsv.v:04x}"
        if spec.encoding == "tuya_hsv_json":
            return json.dumps(hsv.model_dump(), separators=(",", ":"))
        rgb = colorsys.hsv_to_rgb((hsv.h % 360) / 360, hsv.s / 1000, hsv.v / 1000)
        return (
            "".join(f"{round(x * 255):02x}" for x in rgb)
            + f"{hsv.h:04x}{round(hsv.s * 255 / 1000):02x}{round(hsv.v * 255 / 1000):02x}"
        )
    if spec.type == "boolean":
        return not value if spec.invert else value
    if spec.type in {"integer", "number"}:
        if spec.step is not None:
            steps = (value - (spec.minimum or 0)) / spec.step
            if not math.isclose(steps, round(steps), abs_tol=1e-7):
                raise ValueError("Value does not match capability step")
        if spec.invert:
            value = spec.minimum + spec.maximum - value
        raw = (value - spec.offset) / spec.scale
        if spec.raw_type == "integer" or (spec.raw_type is None and spec.type == "integer"):
            # Range adapters (brightness/Kelvin) explicitly quantize to the nearest raw tick.
            return round(raw)
        return raw
    return value


def decode(spec: Capability, raw):
    if spec.value_map:
        for entry in spec.value_map:
            if same(raw, entry.raw):
                return validate_value(spec, entry.value)
        raise ValueError("Unknown raw value")
    if spec.encoding != "raw":
        if spec.encoding == "tuya_hsv_json":
            value = json.loads(raw) if isinstance(raw, str) else raw
        else:
            length = 12 if spec.encoding == "tuya_hsv" else 14
            if not isinstance(raw, str) or len(raw) != length:
                raise ValueError("Malformed color data")
            if spec.encoding == "tuya_hsv":
                value = dict(h=int(raw[:4], 16), s=int(raw[4:8], 16), v=int(raw[8:12], 16))
            else:
                int(raw[:6], 16)  # Validate the RGB prefix, too.
                value = dict(
                    h=int(raw[6:10], 16),
                    s=round(int(raw[10:12], 16) * 1000 / 255),
                    v=round(int(raw[12:14], 16) * 1000 / 255),
                )
        return HSV.model_validate(value).model_dump()
    if spec.type == "boolean":
        if type(raw) is not bool:
            raise ValueError("Expected raw boolean")
        value = not raw if spec.invert else raw
    elif spec.type in {"integer", "number"}:
        if type(raw) not in (int, float) or not math.isfinite(raw):
            raise ValueError("Expected finite raw number")
        if spec.raw_type == "integer" and type(raw) is not int:
            raise ValueError("Expected raw integer")
        value = raw * spec.scale + spec.offset
        if spec.invert:
            value = spec.minimum + spec.maximum - value
        value = round(value, 6)
        if spec.type == "integer":
            if not math.isclose(value, round(value), abs_tol=1e-7):
                raise ValueError("Decoded integer is fractional")
            value = round(value)
    else:
        value = raw
    return validate_value(spec, value)


def command_dps(spec: Capability, value):
    if not spec.writable:
        raise HTTPException(422, "Capability is read-only")
    try:
        return {**spec.write_dps, spec.dp: encode(spec, value)}
    except (ValueError, TypeError, ValidationError, OverflowError):
        raise HTTPException(
            422, "Value does not match capability type/range/step/mapping/color format"
        ) from None


def merge_commands(commands):
    merged = {}
    for command in commands:
        for dp, value in command.items():
            if dp in merged and not same(merged[dp], value):
                raise HTTPException(
                    422, "Capabilities require conflicting values/modes on the same DP"
                )
            merged[dp] = value
    return merged
