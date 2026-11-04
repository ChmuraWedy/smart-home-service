# Screenshot gallery

[Project README](../../README.md) · [Localization examples](../../README.md#localization-examples)

Captured on **4 November 2026**, using the production frontend corresponding to revision `7f8cb0a` and real data from the deployed service. A separate, temporary localhost preview proxied read requests to that service. Device commands and configuration writes were blocked by the preview proxy. The browser used a dummy preview key; the real service key stayed in the proxy process.

English device examples are followed by actual Polish and Belarusian interface captures. Device names, aliases, room assignments, readings, and connection states remain as returned by the app. Public overview headings describe device types; configured room/device names are visible only as part of the app screenshots. Some readings are older cached reports; the images illustrate the interface rather than current measurements or guaranteed device reachability.

| File | View | Language | Theme | Size |
| --- | --- | --- | --- | --- |
| [device-overview-day.png](device-overview-day.png) | Main cards with bulbs and a two-channel switch | English | Day | 1440 × 1100 |
| [bulb-controls-day.png](bulb-controls-day.png) | Power, brightness, white temperature, color, and schedules | English | Day | 840 × 968 |
| [bulb-color-day.png](bulb-color-day.png) | Precise hue, saturation, and color brightness expanded | English | Day | 840 × 968 |
| [two-channel-switch-dark.png](two-channel-switch-dark.png) | Channels, existing aliases, timer, and additional settings | English | Dark | 840 × 968 |
| [room-overview-day.png](room-overview-day.png) | Room filter with temperature/humidity and motion cards | English | Day | 1440 × 1000 |
| [temperature-humidity-sensor-day.png](temperature-humidity-sensor-day.png) | Humidity, temperature, battery, and gateway context | English | Day | 840 × 606 |
| [motion-sensor-dark.png](motion-sensor-dark.png) | Motion status and activity log filtered to motion events | English | Dark | 840 × 858 |
| [bulb-color-polish-day.png](bulb-color-polish-day.png) | Localized bulb controls and precise color settings | Polish | Day | 840 × 968 |
| [motion-sensor-belarusian-dark.png](motion-sensor-belarusian-dark.png) | Localized motion state, activity filter, dates, and connection context | Belarusian | Dark | 840 × 840 |

## Refreshing the screenshots

1. Use a separate browser session so the user's language, theme, navigation, and connection settings remain unchanged. Prefer a read-only preview/proxy when connected to real hardware.
2. Select the language and theme listed above. Use a 1440px-wide desktop viewport. The device overview uses a height of 1100px; other captures use 1000px.
3. Filter the main screen to the relevant lights or sensor room. Use the installation's actual names without renaming records. Capture the viewport after device cards have loaded.
4. For detailed screenshots, open the appropriate bulb, two-channel switch, temperature/humidity sensor, or motion sensor. Capture the dialog element so browser chrome and device IDs in the address bar are excluded. Expand precise color settings without changing a value. For the switch, expand Channel 1's timer and Additional settings. For motion, select the Motion activity filter in the chosen language.
5. For localization examples, change the actual header language selector to Polish or Belarusian. Check the document locale (`pl` or `be`) and translated labels before capture. Do not translate image pixels or replace device data.
6. Leave all device values unchanged. Keep connection settings, account pages, network addresses, device IDs, local keys, API keys, QR login codes, and camera footage out of the images. Review every image visually before committing it.
7. Save PNGs under the existing filenames, update the capture date/revision and dimensions here, and check the README image links. Keep browser profiles, raw API responses, and authentication state files outside the repository.

The captures contain configured device/room names and existing channel aliases. No credentials, physical device IDs, network addresses, or camera video are included.
