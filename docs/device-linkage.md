# Bulb controls and device parameters

[Interface guide](../frontend/README.md) · [Switch channels](switch-controls.md)

## Authentication and available controls

A confirmed QR session persists on the server; the browser authenticates to our API with its own saved service key. Reopening a card therefore does not require a new QR login while that session is valid. Cloud commands need internet access. Local commands independently use the saved IP, protocol, key, and optional gateway/child route.

The UI follows the selected device's actual definitions. The inspected WorkRoomLamp0 exposed the following functions; this table is not a universal DP map for every bulb.

| Code | DP | Purpose |
| --- | --- | --- |
| `switch_led` | 20 | Power |
| `work_mode` | 21 | White, color, scene, music |
| `bright_value_v2` | 22 | White brightness |
| `temp_value_v2` | 23 | White color temperature |
| `colour_data_v2` | 24 | HSV color |
| `scene_data_v2` | 25 | Scene ID and transition/light steps |
| `countdown_1` | 26 | Countdown in seconds |
| `music_data` | 27 | Music lighting command |
| `control_data` | 28 | One-time immediate/smooth transition |
| `rhythm_mode` | 30 | Circadian lighting points |
| `sleep_mode` | 31 | Sleep schedule |
| `wakeup_mode` | 32 | Wake-up schedule |
| `power_memory` | 33 | Manufacturer, last, or custom power-on state |
| `do_not_disturb` | 34 | Do-not-disturb setting |
| `remote_switch` | 41 | Remote-control Boolean; bindings are separate |
| `random_timing` | 210 | Random timing interval, days, channels, light |

`dp_id` is returned only for an unambiguous known mapping; `dp_ids` retains ambiguity. Missing numbers are not guessed. These responses do not contain local keys.

## Color, effects, and schedules

Controls send valid changed values automatically. A color-row expander shows hue, saturation, and color brightness. White brightness and temperature are distinct from the HSV value used for colored light.

Popup wizards edit circadian lighting, sleep, wake-up, random schedules, lighting effects, music commands, and transitions. They explain repetition, timing, points, and review before returning a draft to the card. Cancellation does not replace the original. Done sends the edited settings automatically.

JSON editors follow device schemas. On the inspected bulb, music/transition saturation and brightness use 0–255, while its color function uses 0–1000. Command-only fields can be empty in status without being unsupported. `music_data` can select the declared music mode; `scene_data_v2` can select scene mode. Sending a music frame does not implement microphone capture, audio analysis, or continuous music synchronization.

Known Tuya version-0 raw formats have structured editors. Parsing validates length, version, point counts, ranges, and big-endian fields. Unknown versions and structures remain unchanged. Creating a replacement schedule explicitly replaces the entire raw parameter. Raw transport is base64; declared maximum length applies to decoded bytes, with a 16 KiB global cap. Protocol encoding tests do not prove that every firmware executes every extended mode.

Sources: [lighting function definitions](https://developer.tuya.com/en/docs/iot/product-function-definition?id=K9s9rhj576ypf), [standard lighting JSON](https://developer.tuya.com/en/docs/iot/dj?id=K9i5ql3v98hn3), and [raw transport](https://developer.tuya.com/en/docs/iot/basic-features?id=Kaumiwx9b4kkp). Actual device metadata takes precedence.

Local bulb setup recognizes HSV16, JSON HSV v2, and legacy RGB+HSV8 only when an advertised color function, its unambiguous DP, a valid LAN payload, and an observed writable white/color mode agree. The color capability includes the confirmed mode DP, so picking a color also selects color mode. Unknown formats remain read-only; no product category supplies an assumed DP map. Previously saved raw mappings are preserved until explicitly corrected.
