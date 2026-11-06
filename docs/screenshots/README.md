# Screenshot gallery

[Project README](../../README.md) · [Localization examples](../../README.md#localization-examples)

Captured on **6 November 2026** from frontend revision `966c664` using real device data. A temporary localhost preview proxied passive reads and blocked device commands, configuration writes, and background watch requests. The browser used a dummy preview key, and the service key stayed in the proxy process.

The gallery includes the Large phone layout, bulb and camera bottom sheets, English device details, and Polish and Belarusian interface captures. The camera example uses the preview-only labels **Security Camera** and **Main Door** and shows the playback layout with a frame from **4 November 2026**. Some device readings are older cached reports.

| File | View | Language | Theme | Size |
| --- | --- | --- | --- | --- |
| [device-overview-day.png](device-overview-day.png) | Main cards with bulbs and a two-channel switch | English | Day | 1180 × 662 |
| [mobile-dashboard-large-day.png](mobile-dashboard-large-day.png) | Phone dashboard with Large cards | English | Day | 390 × 960 |
| [mobile-bulb-quick-controls-day.png](mobile-bulb-quick-controls-day.png) | Phone bottom sheet with bulb power, brightness, and white temperature | English | Day | 390 × 960 |
| [mobile-camera-bottom-sheet-dark.png](mobile-camera-bottom-sheet-dark.png) | Security Camera bottom sheet with a previously captured live frame | English | Dark | 390 × 844 |
| [bulb-controls-day.png](bulb-controls-day.png) | Power, brightness, white temperature, color, and schedules | English | Day | 840 × 1008 |
| [bulb-color-day.png](bulb-color-day.png) | Precise hue, saturation, and color brightness expanded | English | Day | 840 × 1008 |
| [two-channel-switch-dark.png](two-channel-switch-dark.png) | Channels, existing aliases, timer, and additional settings | English | Dark | 840 × 1008 |
| [room-overview-day.png](room-overview-day.png) | Room filter with temperature/humidity and motion cards | English | Day | 1180 × 596 |
| [temperature-humidity-sensor-day.png](temperature-humidity-sensor-day.png) | Humidity, temperature, battery, and gateway context | English | Day | 840 × 658 |
| [motion-sensor-dark.png](motion-sensor-dark.png) | Motion status and activity log filtered to motion events | English | Dark | 840 × 904 |
| [bulb-color-polish-day.png](bulb-color-polish-day.png) | Localized bulb controls and precise color settings | Polish | Day | 840 × 1008 |
| [motion-sensor-belarusian-dark.png](motion-sensor-belarusian-dark.png) | Localized motion state, activity filter, dates, and connection context | Belarusian | Dark | 840 × 908 |

## Refreshing the screenshots

1. Use a separate browser session so the user's language, theme, navigation, and connection settings remain unchanged. Prefer a read-only preview/proxy when connected to real hardware.
2. Select the language and theme listed above. Use a 1440-pixel desktop viewport and the phone viewport sizes listed in the table. Capture the app frame on desktop and the viewport on the phone. For the phone screenshots, choose Large in **Menu → Card size**.
3. Filter the main screen to the relevant lights or sensor room. Use the installation's actual names without renaming records. Capture the viewport after device cards have loaded. For the quick controls screenshot, tap the bulb card’s name to open the bottom sheet, then capture the phone viewport.
4. For detailed screenshots, open the appropriate bulb, two-channel switch, temperature/humidity sensor, or motion sensor. Capture the dialog element so browser chrome and device IDs in the address bar are excluded. Expand precise color settings without changing a value. For the switch, expand Channel 1's timer and Additional settings. For motion, select the Motion activity filter in the chosen language.
5. For localization examples, choose Polish or Belarusian in **Menu → Language**. Check the document locale (`pl` or `be`) and translated labels before capture. Do not translate image pixels or replace device data.
6. For the camera screenshot, use the display name **Security Camera** in the preview and tap the camera card. Review the frame for people and identifying details before saving the phone viewport. Label any reused frame as a previous capture.
7. Leave device values unchanged. Keep connection settings, account pages, network addresses, device IDs, local keys, API keys, and QR login codes out of the images. Review every image visually before committing it.
8. Save PNGs under the existing filenames, update the capture date/revision and dimensions here, and check the README image links. Keep browser profiles, raw API responses, and authentication state files outside the repository.

The captures contain configured device and room names, existing channel aliases, and one still from live camera playback.
