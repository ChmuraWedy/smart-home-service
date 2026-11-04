# Cheap Yellow Display room panel

ESP32 firmware uses this service's REST API. Choose a room, select arbitrary devices/groups, then save. The server keeps the selection in SQLite and the panel in NVS; restart reloads the server configuration. Back cancels unsaved room selection. Re-saving retained widgets preserves explicitly configured capability lists.

Cards are generated from capabilities, including power, sensors, cover position, fan modes, brightness, and color where available. Groups open their actual members. The panel is an LVGL application, separate from the browser's React interface. Tuya device keys are never sent to firmware.

## Components and board profiles

The implementation uses [LVGL 8.4](https://lvgl.io/docs/open/8.4/), [LovyanGFX](https://github.com/lovyan03/LovyanGFX), ArduinoJson, and a separate FreeRTOS task for HTTP so network waits do not block LVGL. Board information was researched from [Sunton](https://github.com/rzeldent/platformio-espressif32-sunton), [esp32-smartdisplay](https://github.com/rzeldent/esp32-smartdisplay), and [Cheap Yellow Display](https://github.com/witnessmenow/ESP32-Cheap-Yellow-Display).

| PlatformIO environment | Board family | LCD / touch | Resolution |
| --- | --- | --- | --- |
| `cyd-028r` | ESP32-2432S028R, R v2 | ILI9341 / XPT2046 | 240×320 |
| `cyd-028r-st7789` | ESP32-2432S028R v3 / CYD2USB | ST7789 / XPT2046 | 240×320 |
| `cyd-028c` | JC2432W328C | ST7789 / CST816S | 240×320 |
| `cyd-035r` | ESP32-3248S035R | ST7796 / XPT2046, shared SPI | 320×480 |
| `cyd-035c` | ESP32-3248S035C | ST7796 / GT911 | 320×480 |

These are five compilable profiles, not universal yellow-display compatibility. ESP32-S3 and 4.3/7-inch RGB panels are not supported by this driver. Verify the exact LCD, touch controller, and pinout; profiles do not probe GPIO automatically.

The reported `ESP32-2432S028 XXSR69` board with two USB connectors provisionally uses `cyd-028r-st7789`, which is the default environment. Connector count or XXSR69 alone does not prove the controller. If verified power/flash succeeds but the display is wrong, inspect the actual hardware and consider `cyd-028r`. Color order, inversion, and touch calibration require hardware verification.

## Build and upload

First configure rooms, devices with verified capabilities, and optional groups on the server. See [room displays](../../docs/displays.md).

```sh
python -m pip install platformio
cp firmware/cyd/include/config.example.h firmware/cyd/include/panel_config.h
# Set Wi-Fi, API_BASE, API_TOKEN, and a unique PANEL_ID in panel_config.h.
pio run -d firmware/cyd -e cyd-028r-st7789
pio run -d firmware/cyd -e cyd-028r-st7789 -t upload
pio device monitor -d firmware/cyd -b 115200
```

`API_BASE` is the reachable API address ending in `/api/v1`, with no trailing slash, for example `http://<server-LAN-IP>:8000/api/v1` for a direct API or port 8080 for Docker. Do not use the React development port. `127.0.0.1` on ESP32 refers to the panel itself. Bind the API to the appropriate LAN address and use one worker.

Each panel needs a unique `PANEL_ID`; an empty ID is derived from its MAC. `panel_config.h` and `.pio` are ignored. A compiled image contains its Wi-Fi/API credentials and must not be published with real settings. This profile uses HTTP on a trusted LAN; internet access requires a separately implemented certificate-validating TLS transport.

`DISPLAY_ROTATION=1` selects landscape. Verify `DISPLAY_INVERT`, `DISPLAY_RGB_ORDER`, `TOUCH_X_MIN/MAX`, `TOUCH_Y_MIN/MAX`, and `TOUCH_ROTATION` on the actual panel. There is no universal touch calibration.

## Runtime limits and verification

- The server collector defaults to 30 seconds; the panel reads its cache every 10 seconds and requests an extra refresh after a command. Short motion events can be missed without a persistent event channel.
- ACK is shown as accepted/waiting for status, without replacing observed state. Commands are not automatically retried or queued offline.
- Unknown/stale/disabled values are not Off, no motion, or zero. Control is disabled after 25 seconds without a successful server response.
- Up to 12 widgets and 12 distinct devices are allowed, including group members. Group writes are sequential and can partially fail.
- Numeric controls require bounds; color needs a supported HSV encoding. Draft sliders apply explicitly.
- API lists page in groups of eight. HTTP/snapshot limits are 32 KiB, list JSON 24 KiB, and the LVGL arena 48 KiB. Reduce selected capabilities for large payloads. PSRAM is not required.
- The 4 MB `huge_app` partition is used; OTA is not enabled. Build success does not verify pinout, touch, runtime RAM, or physical device control.

The included `panel_font.c` covers ASCII, Latin, and Cyrillic from Noto Sans Regular under [SIL OFL](fonts/OFL.txt). Regenerate with `lv_font_conv@1.5.3`, size 16, bpp 2, ranges `0x20-0x7f,0xa0-0x17f,0x400-0x4ff`, LVGL format, and no compression; include `lvgl.h`. Font source: [Noto](https://github.com/notofonts/latin-greek-cyrillic).
