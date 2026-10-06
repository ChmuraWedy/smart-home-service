"""Explicit examples, not automatic recognition or imported HA configuration files."""

from copy import deepcopy

from .schemas import Capability


def cap(dp, kind, **kw):
    return Capability(dp=str(dp), type=kind, **kw).model_dump(mode="json")


def bulb(*, legacy=False, json_color=False):
    switch, mode, bright, temp, color = (1, 2, 3, 4, 5) if legacy else (20, 21, 22, 23, 24)
    maximum, minimum = (255, 25) if legacy else (1000, 10)
    return {
        "switch": cap(switch, "boolean"),
        "mode": cap(mode, "string", enum=["white", "colour", "scene", "music"]),
        "brightness": cap(
            bright,
            "number",
            minimum=1 if not legacy else round(minimum / maximum * 100, 6),
            maximum=100,
            scale=100 / maximum,
            raw_type="integer",
            unit="%",
            write_dps={str(mode): "white"},
        ),
        "color_temperature": cap(
            temp,
            "number",
            minimum=2700,
            maximum=6500,
            scale=3800 / maximum,
            offset=2700,
            raw_type="integer",
            unit="K",
            write_dps={str(mode): "white"},
        ),
        "color": cap(
            color,
            "object",
            encoding="tuya_hsv_json" if json_color else ("tuya_rgbhsv" if legacy else "tuya_hsv"),
            write_dps={str(mode): "colour"},
        ),
    }


PROFILES = {
    "relay": ("Реле / выключатель", "switch", {"switch": cap(1, "boolean")}),
    "relay-3ch": (
        "Трёхканальное реле",
        "switch",
        {f"switch_{i}": cap(i, "boolean") for i in range(1, 4)},
    ),
    "plug-meter": (
        "Розетка с отдельными DPS мощности",
        "switch",
        {
            "switch": cap(1, "boolean"),
            "current": cap(18, "number", scale=0.001, raw_type="integer", writable=False, unit="A"),
            "power": cap(19, "number", scale=0.1, raw_type="integer", writable=False, unit="W"),
            "voltage": cap(20, "number", scale=0.1, raw_type="integer", writable=False, unit="V"),
        },
    ),
    "bulb-v2": ("Лампа RGBCCT: DPS 20–24 / HSV16", "light", bulb()),
    "bulb-v1": ("Лампа RGBCCT: DPS 1–5 / RGB+HSV8", "light", bulb(legacy=True)),
    "bulb-json": ("Шаблон лампы с JSON HSV", "light", bulb(json_color=True)),
    "dimmer": (
        "Диммер: DPS 1/2, яркость 0–1000",
        "light",
        {
            "switch": cap(1, "boolean"),
            "brightness": cap(
                2, "number", minimum=0, maximum=100, scale=0.1, raw_type="integer", unit="%"
            ),
        },
    ),
    "cover": (
        "Штора: open/close/stop и положение",
        "cover",
        {
            "control": cap(1, "string", enum=["open", "close", "stop"]),
            "position": cap(2, "integer", minimum=0, maximum=100, unit="%"),
        },
    ),
    "fan": (
        "Вентилятор с тремя enum-скоростями",
        "fan",
        {
            "switch": cap(1, "boolean"),
            "speed": cap(
                3,
                "string",
                enum=["low", "medium", "high"],
                value_map=[
                    {"value": "low", "raw": "1"},
                    {"value": "medium", "raw": "2"},
                    {"value": "high", "raw": "3"},
                ],
            ),
            "oscillation": cap(4, "boolean"),
        },
    ),
    "thermostat": (
        "Термостат: целевая температура с шагом 0.5°C",
        "climate",
        {
            "switch": cap(1, "boolean"),
            "target_temperature": cap(
                2,
                "number",
                minimum=5,
                maximum=35,
                step=0.5,
                scale=0.5,
                raw_type="integer",
                unit="°C",
            ),
            "temperature": cap(
                3, "number", scale=0.5, raw_type="integer", writable=False, unit="°C"
            ),
            "mode": cap(
                4,
                "string",
                enum=["manual", "auto"],
                value_map=[{"value": "manual", "raw": 0}, {"value": "auto", "raw": 1}],
            ),
        },
    ),
    "temperature-humidity": (
        "Датчик TH05Z: температура, влажность, батарея",
        "sensor",
        {
            "temperature": cap(
                1, "number", scale=0.1, raw_type="integer", writable=False, unit="°C"
            ),
            "humidity": cap(2, "integer", minimum=0, maximum=100, writable=False, unit="%"),
            "battery": cap(4, "integer", minimum=0, maximum=100, writable=False, unit="%"),
        },
    ),
    "motion": (
        "Датчик движения с pir/none",
        "binary_sensor",
        {
            "motion": cap(
                1,
                "boolean",
                writable=False,
                value_map=[{"value": True, "raw": "pir"}, {"value": False, "raw": "none"}],
            ),
        },
    ),
    "presence-4in1": (
        "Presence 4in1: движение, температура, влажность",
        "sensor",
        {
            "motion": cap(
                1,
                "boolean",
                writable=False,
                value_map=[{"value": True, "raw": "presence"}, {"value": False, "raw": "none"}],
            ),
            "temperature": cap(
                111, "number", scale=0.1, raw_type="integer", writable=False, unit="°C"
            ),
            "humidity": cap(101, "integer", minimum=0, maximum=100, writable=False, unit="%"),
            "illuminance": cap(106, "integer", minimum=0, writable=False, unit="lx"),
        },
    ),
    "humidifier": (
        "Увлажнитель: мощность и целевая влажность",
        "humidifier",
        {
            "switch": cap(1, "boolean"),
            "target_humidity": cap(3, "integer", minimum=30, maximum=90, unit="%"),
            "humidity": cap(4, "integer", minimum=0, maximum=100, writable=False, unit="%"),
        },
    ),
    "vacuum-basic": (
        "Шаблон пылесоса: команды и батарея",
        "vacuum",
        {
            "command": cap(
                2,
                "string",
                enum=["clean", "pause", "dock"],
                value_map=[
                    {"value": "clean", "raw": "smart"},
                    {"value": "pause", "raw": "standby"},
                    {"value": "dock", "raw": "chargego"},
                ],
            ),
            "battery": cap(14, "integer", minimum=0, maximum=100, writable=False, unit="%"),
        },
    ),
    "button": (
        "Кнопка / импульс, без выдуманного статуса",
        "button",
        {
            "press": cap(1, "boolean", readable=False, enum=[True]),
        },
    ),
}


def profile(identifier):
    name, family, capabilities = PROFILES[identifier]
    return {
        "id": identifier,
        "name": name,
        "family": family,
        "capabilities": deepcopy(capabilities),
        "requires_dp_verification": True,
    }
