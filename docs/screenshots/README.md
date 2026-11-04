# Screenshot gallery

[Project README](../../README.md)

Captured on **4 November 2026**, using the production frontend corresponding to revision `7f8cb0a` and real data from the deployed service. A separate, temporary localhost preview proxied read requests to that service. Device commands and configuration writes were blocked by the preview proxy. The browser used a dummy preview key; the real service key stayed in the proxy process.

The interface is in English. Device names, aliases, room assignments, readings, and connection states are shown as returned by the app, without renaming devices or replacing values. WC2 is named **Bathroom Second** in this installation. Some readings are older cached reports; the images illustrate the interface, not a current measurement or a guarantee that every device is reachable.

| File | View | Theme | Size |
| --- | --- | --- | --- |
| [workroom-overview-day.png](workroom-overview-day.png) | Main screen filtered by “Work”; lamps and two-channel switch | Day | 1440 × 1100 |
| [workroom-bulb-day.png](workroom-bulb-day.png) | WorkRoomLamp1: power, brightness, white temperature, color, and schedules | Day | 840 × 968 |
| [workroom-bulb-color-day.png](workroom-bulb-color-day.png) | WorkRoomLamp1: precise hue, saturation, and color brightness expanded | Day | 840 × 968 |
| [workroom-switch-dark.png](workroom-switch-dark.png) | WorkroomLigthSwith: channels, existing aliases, timer, and additional settings | Dark | 840 × 968 |
| [wc2-overview-day.png](wc2-overview-day.png) | Bathroom Second room cards, including temperature/humidity and motion | Day | 1440 × 1000 |
| [wc2-temperature-day.png](wc2-temperature-day.png) | Bath2 temperature: humidity, temperature, battery, and gateway context | Day | 840 × 606 |
| [wc2-motion-dark.png](wc2-motion-dark.png) | Bath2 motion: motion status and activity log filtered to motion events | Dark | 840 × 858 |

## Refreshing the screenshots

1. Use a separate browser session so the user's language, theme, navigation, and connection settings remain unchanged. Prefer a read-only preview/proxy when connected to real hardware.
2. Select English and the appropriate theme. Use a 1440px-wide desktop viewport. The lighting overview uses a height of 1100px; the other captures use 1000px.
3. On the main screen, search for “Work” for the lighting overview. For WC2, clear the search and select “Bathroom Second”. Capture the viewport after device cards have loaded.
4. Open WorkRoomLamp1, WorkroomLigthSwith, Bath2 temperature, or Bath2 motion. Capture the dialog element so browser chrome and device IDs in the address bar are excluded. For the color screenshot, expand Precise color settings without changing a value. For the switch, expand Channel 1's timer and Additional settings. For motion, select Motion in the activity log filter.
5. Leave all device values unchanged. Keep connection settings, account pages, network addresses, device IDs, local keys, API keys, QR login codes, and camera footage out of the images. Check each image visually before committing it.
6. Save as PNG under the existing filenames, update the capture date/revision and dimensions here, and check the README image links. Keep browser profiles, raw API responses, and authentication state files outside the repository.

The captures contain the configured device/room names and existing channel aliases. No credentials, device identifiers, network addresses, or camera video are included.
