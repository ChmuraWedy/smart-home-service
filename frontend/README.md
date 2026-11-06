# Smart Home interface

React + TypeScript + Vite frontend for the [Smart Home service](../README.md). The API and interface can run independently; the production build is static files. Docker packages both behind nginx.

## Development and build

Use the Node.js and pnpm versions in [package.json](package.json).

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm lint
pnpm test
pnpm build
```

The frontend build, including the Docker image build, runs ESLint before compilation. The configuration extends Airbnb’s JavaScript, React, and Hooks rules through ESLint’s compatibility adapters, with overrides for TypeScript and the JSX runtime.

Each JSX tag in a tree gets its own line. A leaf can keep its opening tag, text or interpolation, and closing tag together, such as `<p>{label}</p>`. This rule has no baseline exemptions.

The committed ESLint baseline tracks existing violations of other rules by file and rule. After fixing a recorded violation, run `pnpm exec eslint src --prune-suppressions` and include the baseline reduction with the fix.

Development serves `http://127.0.0.1:5173`. Configure the API's allowed origins accordingly. Save the API URL and service access key under connection settings. A production `VITE_API_BASE_URL=same-origin` build uses the current host; otherwise the configured base or development API default is used. The old Python `/cloud` page can redirect to this separate frontend.

## Language and themes

The header offers English, Russian, Polish, and Belarusian. Initial language follows the browser with an English fallback. Changes apply without reloading React or discarding device drafts. Device names, aliases, IDs, and command values are not translated. Dates follow the chosen locale. See the [localization guide](src/i18n/README.md).

System, Dark, and Day themes are available in all four languages. System follows the OS, including later changes. Explicit choices persist independently of credentials in `smart-home.ui.theme.v1` and synchronize across tabs. Theme initialization runs before React paints. If storage is unavailable, an in-memory preference works for that page session.

Both palettes use semantic variables in `src/styles.css`. New colors need values in both themes. Video stays black and detection outlines stay red. Device dialogs use a fixed flex header and a scrolling `.control-dialog-body`. Header refresh/info/close icons have a consistent borderless appearance, 44px hit targets, and keyboard focus indicators.

## Navigation and device cards

The menu opens Devices, Network and packets, Local connections, and Connections. Inventory combines local devices, connected cloud accounts, and groups. Physical Tuya device IDs merge the same hardware into one card; equal names do not merge different devices. Search uses names/aliases/IDs, with building and room filters.

Cards expose the main power switches or sensor readings. Bulbs have immediate power controls; full cards add brightness, temperature, color, effects, and schedules where supported. Multi-channel switches expose each real channel. Sensors show compact values and icons; details provide labels, units, timestamps, battery, and activity logs. Clicking a card opens details; child buttons retain their own actions.

Each card has a stable `device-<encoded Tuya ID>` HTML ID. Device links preserve the chosen control method on reload. Missing devices and unavailable control methods display an error. Closing a device panel returns to the dashboard context, and browser navigation is blocked during a running command.

### Frontend URLs

| URL | Screen |
| --- | --- |
| `/` | All rooms |
| `/rooms/:roomId` or `/rooms/none` | One room or devices without a room |
| `/?page=2` or `/rooms/:roomId?page=2` | A page of dashboard cards |
| `/devices/:deviceId?route=local` | Full device details. `route` accepts `local`, `sharing`, or `developer`. |
| `/devices/:deviceId/quick?route=sharing` | The bulb quick controls or camera preview |
| `/groups/:groupId` | Group controls |
| `/settings` | Language, theme, and card size |
| `/settings/dashboard` | Dashboard filters and tools |
| `/settings/connections` | Service access and Smart Life connection |
| `/settings/connections?provider=developer` | Tuya Developer connection |
| `/network` | Network and packet observation |
| `/local-connections` | Local connection wizard |

Room and device URLs use stable IDs. An overlay opened from a filtered dashboard carries its room and page in the URL. Existing `#device/...`, `#network`, and `#local-connections` bookmarks redirect to the corresponding routes.

If multiple routes exist, the selector explicitly chooses home-network, Smart Life, or Developer control. Cloud routes work without a local IP/key import. Local control needs verified inventory connection details; Zigbee uses its saved gateway and child address. The app never retries an uncertain command through another route.

## Editing controls

Definitions come from the selected route's writable Tuya functions or effective local capabilities. Supported editors include Boolean switches, bounded numbers, enums, color, string/JSON, and validated raw data. Unknown or read-only parameters do not gain invented write controls.

Full cards keep edits as drafts and use one **Apply** action, sending only values changed from the initial state. Refreshes preserve drafts. Main-screen power controls send immediately. ACK, readback, failure, and an unknown physical outcome are kept distinct. Missing readings are not converted to false or zero.

The color picker can expand into hue, saturation, and color-brightness controls. Device-declared ranges determine percentages; Kelvin is shown only where the definition provides a real conversion. White brightness and temperature can select white mode, and color can select color mode, when the device declares those writable modes.

Lighting schedules and effects use popup wizards. Circadian, random, wake-up, sleep, effect, music, and transition editors keep drafts until the card's Apply action. Schedule steps cover repetition, points, and review; cancellation preserves the original. Unknown versions/formats remain intact rather than being replaced with fabricated settings. See [lighting controls](../docs/device-linkage.md).

Channel clock buttons expand timers. Power restoration, switch backlight, and unknown inching strings belong in Additional settings. Device and channel aliases edit inline and remain separate from real names. See [aliases](../docs/device-aliases.md) and [switch controls](../docs/switch-controls.md).

## Status, activity, and battery

Initial local views read SQLite cache. Explicit refresh polls the selected device. Sharing reports arrive through the server SDK, while visible controls read our cache every three seconds. Off-screen/hidden views stop browser polling. Developer and local routes are not automatically cloud-polled by React.

Per-value timestamps and known/stale flags distinguish fresh reports from old snapshots. Accepted targets are not immediately erased by an older cache response. See [status updates](../docs/status-updates.md).

Motion logs are prominent in sensor details; other logs start collapsed. Logs offer applicable event filters and cursor pagination, poll only while open, and retain up to 2,000 events per device/source. They are received reports and available snapshots, not a complete Smart Life archive. Battery appears in the upper-right detail header and on tiles when known; raw battery values do not acquire invented units. See [activity logs](../docs/device-activity.md).

## Smart Life topology

**Sync Smart Life** starts a background homes/rooms sync with progress. The saved topology supplies cloud-card room filters and local setup defaults. Reopening the page reads the cache instead of re-querying every room. Manual local placement takes priority; empty rooms are not initially discoverable with this SDK. No devices are registered or switched by synchronization. See the [API policy](../docs/api-reference.md#smart-life-topology).

## Local connections

The wizard replaces an unwieldy all-device dropdown with discovery and review:

1. Choose a real network interface and whether already-configured devices should be included.
2. Observe LAN announcements during the search period.
3. Review identified devices in a table, select rows with individual/header checkboxes, and verify their connections.
4. Confirm which verified configurations to save. Search and verification alone do not save them.
5. Inspect per-device results, links to configured device cards, and remaining unconfigured devices. Rerun discovery when needed.

Exact physical IDs and confirmed routing determine matches. The server handles keys privately; the UI receives only presence/source/change indicators. Gateways and direct devices share find/save logic; unknown parent links require a real mapping. Existing names, aliases, placement, and capabilities remain intact. See [find/verify/save](../docs/api-reference.md#find-verify-and-save-local-connections).

## Optional commissioning

The API also supports sampling before local registration, including manually entered device details. Observing a changed DP alone cannot prove its function. Known functions are enabled from confirmed metadata without the obsolete per-function approval screen; unknown DPS remain read-only. Saving still requires explicit registration/configuration confirmation.

## Network and packets

`/network` operates without Smart Life. Choose the interface/subnet, start observation, filter devices/sources, and inspect IP, Tuya ID, MAC, mDNS/SSDP services, and the event log. An explicit discovery action sends standard announcements requests, not switch commands. Export saves a JSON report locally. Leaving the page or hiding it stops observation. This is LAN discovery, not a Zigbee radio sniffer. See [network capture](../docs/packet-capture.md).

## Cameras and connections

Camera tiles can expand a small video preview. Privacy, motion, sound, and siren controls appear only when exposed by the device. Details provide the player, supported HD/SD stream variants, available network data, image/detection settings, and SD-card state. Missing features or storage do not gain fictional controls. See [camera details and limitations](../docs/camera-controls.md).

Connection settings keep the service key separate from Tuya login. Saved fields are hidden behind an edit action, and secrets are not filled back into inputs. The Sharing User Code/QR flow and Developer credential flow have separate save/check actions. Seven Developer regions are supported. See [QR login](../docs/qr-login.md) and [Developer login](../docs/developer-login.md).

Cloud account tokens and device local keys stay on the server. The browser stores the service access key for this origin. API key rotation requires reconnecting browsers; changing language or theme does not change credentials or device drafts.
