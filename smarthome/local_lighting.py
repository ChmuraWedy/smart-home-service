"""Recognize light encodings only after cloud DP metadata and LAN values agree."""

from .capabilities import decode
from .schemas import Capability


def color_capability(specs, functions, readings, code, dp, value):
    spec = specs.get(code, {})
    if (
        code not in {"colour_data", "colour_data_v2"}
        or code not in functions
        or spec.get("type") != "Json"
        or spec.get("dp_id") != int(dp)
        or sum(row.get("dp_id") == int(dp) for row in specs.values()) != 1
    ):
        return None
    mode = specs.get("work_mode", {})
    choices = mode.get("values", {}).get("range", [])
    mode_dp = mode.get("dp_id")
    if (
        "work_mode" not in functions
        or mode.get("type") != "Enum"
        or not isinstance(mode_dp, int)
        or mode_dp == int(dp)
        or not isinstance(choices, list)
        or not all(item in choices for item in ("white", "colour"))
        or sum(row.get("dp_id") == mode_dp for row in specs.values()) != 1
        or not any(
            row.get("code") == "work_mode"
            and row.get("dp") == str(mode_dp)
            and row.get("value") in choices
            for row in readings
        )
    ):
        return None
    encodings = ["tuya_hsv", "tuya_hsv_json"] if code == "colour_data_v2" else ["tuya_rgbhsv"]
    for encoding in encodings:
        cap = Capability(
            dp=str(dp),
            type="object",
            encoding=encoding,
            write_dps={str(mode_dp): "colour"},
        )
        try:
            decode(cap, value)
        except (ValueError, TypeError):
            continue
        return cap
    return None
