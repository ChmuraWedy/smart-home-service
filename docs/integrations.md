# Integration choices and device compatibility

Research snapshot: 7 October 2026. LocalTuya revision `59c95cd06c2696afc98f6bc52d5fa060f3c517da`; Tuya Local revision `908c133d110a80d9b8dca7da76d55b9017aa62cf`. Their catalogs were studied, not copied into this project.

| Integration | Approach | Relevant ideas |
| --- | --- | --- |
| [LocalTuya](https://github.com/rospogrigio/localtuya) | LAN, selected DPS, status push, optional cloud key lookup | Relay channels, scaled brightness/temperature, inverted covers, enums |
| [Tuya Local](https://github.com/make-all/tuya-local) | TinyTuya with product-specific configurations | Explicit profiles, read-only sensors, separate write/feedback DPS, gateway/child routing |
| [Official Home Assistant Tuya](https://www.home-assistant.io/integrations/tuya/) | Cloud User Code/QR and Sharing SDK | Optional cloud adapter independent of local control |

A category or integration platform does not prove support for every product. Sharing functions/status ranges can be incomplete; a cloud access token is not a device local key.

## Implemented concepts

- Relay/outlet/multi-channel Boolean switches and combined DPS writes.
- Dimmers with explicit ranges and scaling.
- RGBCCT HSV16, RGB+HSV8, and JSON HSV, with mode companion writes.
- Covers with open/close/stop, inverted position, and separate feedback DP.
- Fan power, oscillation, and enum speed.
- Thermostat targets/modes with scale, offset, and step.
- Read-only temperature, humidity, motion, presence, and separate voltage/current/power readings.
- Humidifier targets/power, explicit vacuum clean/pause/dock commands, and write-only button pulses.

These concepts have controlled-transport direct Wi-Fi and parent/cid tests. Those tests do not certify each physical product. Packed energy frames, vacuum maps, vendor IR learning, secure lock operations, and arbitrary vendor payloads need dedicated adapters. [Camera streaming](camera-controls.md) is a separate supported cloud path, not a generic local capability adapter.

## Profiles and units

`GET /api/v1/profiles` lists explicit example DP maps. There is no universal automatic mapping by category. Verify numbers, formats, and ranges against the product, live status, and trustworthy metadata.

Our scaling is `API = raw * scale + offset`; another integration's divisor-style `scale` cannot be copied directly. Limits and step use API units. Integer raw writes round to a tick. Boolean inversion flips truth values; numeric inversion reflects the defined range. `read_dp`, reversible `value_map`, and constant `write_dps` support separate feedback, enums, and mode writes.

Normalized color uses hue 0–360, saturation/value 0–1000. White brightness normally uses percent, and a declared temperature profile can use Kelvin. Change HSV value for color-mode brightness; the separate white brightness capability can select white mode. Legacy definitions without conversion fields retain their original units.

Batch capability writes reject conflicting DP values before sending. Some products still require separate packets; validate that behavior on hardware. Cached state includes independent known/stale/timestamp fields. Neither ACK nor a fresh humidity value refreshes an old temperature observation. Sleeping Zigbee sensors may need real gateway/cloud reports rather than polling.
