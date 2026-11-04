# Bulb controls and device mappings

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

The card has one Apply action for edited values. A color-row expander shows hue, saturation, and color brightness. White brightness and temperature are distinct from the HSV value used for colored light.

Popup wizards edit circadian lighting, sleep, wake-up, random schedules, lighting effects, music commands, and transitions. They explain repetition, timing, points, and review before returning a draft to the card. Cancellation does not replace the original. A final Apply sends the edited draft.

JSON editors follow device schemas. On the inspected bulb, music/transition saturation and brightness use 0–255, while its color function uses 0–1000. Command-only fields can be empty in status without being unsupported. `music_data` can select the declared music mode; `scene_data_v2` can select scene mode. Sending a music frame does not implement microphone capture, audio analysis, or continuous music synchronization.

Known Tuya version-0 raw formats have structured editors. Parsing validates length, version, point counts, ranges, and big-endian fields. Unknown versions and structures remain unchanged. Creating a replacement schedule explicitly replaces the entire raw parameter. Raw transport is base64; declared maximum length applies to decoded bytes, with a 16 KiB global cap. Protocol encoding tests do not prove that every firmware executes every extended mode.

Sources: [lighting function definitions](https://developer.tuya.com/en/docs/iot/product-function-definition?id=K9s9rhj576ypf), [standard lighting JSON](https://developer.tuya.com/en/docs/iot/dj?id=K9i5ql3v98hn3), and [raw transport](https://developer.tuya.com/en/docs/iot/basic-features?id=Kaumiwx9b4kkp). Actual device metadata takes precedence.

## Related devices and manual mappings

Mappings record the intended source/target devices and functions in this application's database. Types are `remote`, `zigbee_group`, and `multi_control`. They are not applied Zigbee groups or Smart Life bindings. Saving does not send commands, forward button presses, or create an automation.

Select a kind, direction, other device, and source/target functions. Known DP numbers come from metadata; unknown numbers may remain null or be entered explicitly when valid. Incoming and outgoing mappings appear on both devices and survive restart. An empty list means no local manual records, not proof that Smart Life has no bindings.

Sharing SDK 0.2.15 exposes function/DP mappings but not Smart Life binding CRUD. Separate Tuya mechanisms exist for [mobile multi-control](https://developer.tuya.com/en/docs/app-development/devicemulticontrol?id=Kceuh30jk2dcu), [association control](https://developer.tuya.com/en/docs/app-development/associationControl?id=Ke6l68yd78zed), and [Zigbee remote panels](https://developer.tuya.com/en/miniapp-codelabs/codelabs/panel-zigbee-remote-group-guide/index.html); those APIs are not automatically available through Sharing authorization.

## Mapping API

Routes require `X-API-Key` and the selected `provider=sharing|developer`. Data is isolated by provider/account. Both devices must be in that account's inventory; a source can be read-only, but the destination must be writable. DP/code mismatches return 422 and duplicate records return 409.

```sh
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json'   -d '{"kind":"remote","source_code":"switch_1","source_dp_id":1,"target_device_id":"demo-lamp","target_code":"switch_led","target_dp_id":20}'   "$BASE/cloud/devices/demo-switch/mappings?provider=sharing"
```

`BASE` includes `/api/v1`. GET on the same collection returns incoming/outgoing records, `origin:manual`, `applied_to_tuya:false`, and `tuya_bindings_available:false`. PUT/DELETE address `/cloud/devices/{source_device_id}/mappings/{id}`. Incoming records must still be changed via their source device. DELETE removes only our database record. UI creation/deletion and REST editing do not change actual Tuya bindings.
