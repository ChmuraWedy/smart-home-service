# Changelog

Entries below describe the changes at the stated date; later entries can supersede earlier intermediate UI behavior.

## After 0.8.3 — 2026-11-04

- Added actual Polish bulb and Belarusian motion-sensor localization examples, with English documentation captions. Renamed overview headings and screenshot assets by device type rather than installation-specific rooms.

- Replaced the Russian documentation with English guides and an OpenAPI-derived endpoint index. Expanded the README into seven individually visible screenshots, including Workroom bulb color controls and WC2 motion status/activity.
- Added a project overview, setup instructions, and real-device screenshot gallery; moved the detailed API reference out of the root README.
- `feat/themes-and-detail-header`: System, Dark, and Day palettes, persisted choice, OS updates, and cross-tab synchronization. Detail headers no longer scroll with content. Header SVG actions are consistently borderless with 44px targets; mobile toggles no longer overlap refresh controls.
- Added `deploy/activate-dell.py`: a new random service key on every deployment, synchronized private local/Dell environment files, authorization/health checks, and key/image rollback. Keys are not printed and backups are excluded from Git.
- `feat/localisation-be`: Belarusian localization added over Polish, with 1,002 messages at introduction, `be-BY` dates, browser detection, and persistence. Shared checks cover all four languages.
- `feat/localisation-pl`: complete Polish catalog, browser language, dates, persistence, and cross-tab changes without losing drafts or changing command values.
- `feat/localisation`: English/Russian header selection, browser defaults, persistence, and cross-tab updates across controls, values, cameras, wizards, network pages, and known errors. Names, aliases, identifiers, and commands retain their original values.
- Deployed on Dell Wyse 5070 / Debian 13, migrated nine local devices and the Smart Life session, and verified LAN access, authorization, IoT interfaces, and restart preservation.
- Added a React/Python/nginx Docker image with one web/API address, required key, persistent volume, health check, and coordinated shutdown. Compose uses port 8080; a Linux LAN override exposes real host interfaces. Secrets and runtime databases are excluded from build context.

## After 0.8.3 — 2026-10-13

- Removed the separate function-review screen and permission checkboxes. Save is available directly after readings arrive and includes all verified functions; unknown parameters remain read-only. Saving still confirms the write.
- In the preceding iteration, verified functions were selected by default and optional deselection survived further sampling.
- Added function setup for existing local records without capabilities, using actual DPS and the selected account's schema. It updates the existing record without changing identity, name, aliases, room, connection, or key. Changed connection/parent/schema invalidates stale previews.
- Discovery results became a table with a header checkbox and partial-selection state. Removed separate select-all/clear actions and final-step search. Successful results link to local device cards.
- Added stable card IDs and `#device/<Tuya ID>?route=local|sharing|developer` deep links, reload/history support, and explicit errors rather than route substitution.
- Reworked local setup into a wizard: interface/reconfigure choice, 15-second LAN observation, actual discovered-device selection, key verification, separate save confirmation, and results/unconfigured items. Exact account IDs only, up to 16 connections per pass, receiver cleanup on cancel, and no automatic save retry.

## After 0.8.3 — 2026-10-12

- Local setup initially hid configured devices by default, with search, counts, and an explicit configured-device group. Incomplete records and cloud-key-only devices still required setup; successful saves updated the list immediately.
- Added the separate Local connections menu/page with account, device, and real-interface selection, verification, preview, and confirmed saving. Changed selection, cancellation, or expiry invalidates previews. Zigbee clearly identifies the gateway; Network and packets stays independent of Smart Life.
- Added generic `/api/v1/local-connections/find` and `/save`. Wi-Fi verification uses only the device's own key. Zigbee routes through an explicit/saved gateway without changing child keys or associations. Preview identifies the actual configured device.
- Split gateway setup into `/gateways/find` and `/gateways/save` with a single-use, five-minute `finding_id` and strict Boolean `confirmed:true`. Revalidation occurs before saving; the old auto-saving `/gateways/setup` route was removed.
- Gateways without their own DPS now explain that child cards contain the readings/controls rather than requiring meaningless gateway capabilities.
- Added the independent Network and packets page: actual interface/subnet, Tuya/mDNS/SSDP announcements, neighbors, identity/address/service rows, events/IP changes, explicit standard discovery, and local JSON export. No cloud-derived names or guessed Zigbee links; hidden/abandoned sessions stop.
- Added gateway-key candidates from authorized child metadata when the gateway lacks a key. Verification against one confirmed IP uses read-only TinyTuya 3.3–3.5 proof, with server-only keys and account/source invalidation. A verified gateway without DPS can be saved; sensor associations are not guessed.
- Known cloud gateway categories now lock the wizard to Gateway; manual device setup retains a type choice.
- Resumed TRACER FOCUS 3 setup and removed the name-based deferred-device list. The preceding WorkGtZb iteration had resumed gateway setup while TRACER remained deferred.
- Gateway selectors include actual account gateways even when Sharing marks the gateway itself `sub=true`. Nested gateway verification/save can return to the sensor draft. Empty lists explain the missing prerequisite.
- Renamed Add to home to Set up local connection and replaced its plus with a network icon, clarifying that cloud devices already work without local registration.
- Removed the duplicate main-screen management heading/introduction beneath navigation.
- Privacy buttons show their current state. Enabled/pending privacy blocks tile/detail/region video, stops playback and pending allocation, and requires confirmation of disabled privacy before manually restarting video.

## After 0.8.3 — 2026-10-11

- Added camera information popups for Smart Life reference settings, sensitivity, and SD functions. Clarified `humanoid_filter` as human-event filtering without claiming the model's subscription status. Popups work for disabled controls; preview collapse became an accessible arrow.
- Privacy became a button beside Video. Reading age/refresh layout was corrected. Recording/formatting require a ready card; cached recording-on does not imply active recording. Added the rectangular detection-area editor with move/resize and draft saving.
- Camera quick controls moved from an initial single-row layout to two aligned rows. Clicking unused device/group card space opens details while nested controls retain their own actions; navigation is blocked during commands.
- Earlier camera changes added immediate privacy/motion/sound/siren controls, a separate confirmed formatting action, and human-detection help under an info icon.
- The detail player shows actual resolution, buffering/playback, and segment download speed. HD/SD uses available HLS variants only; a single stream has no fabricated quality switch. Wi-Fi is shown only when a real numeric reading exists.
- Grouped known camera settings into image, detection, and recording sections, retaining unknown functions in additional settings and preserving device codes/ranges and changed-only submission.
- Added main-card mini live preview; collapsing, opening details, or hiding the page stops it.
- Added explicit Tuya HLS allocation/start/stop through the selected provider, camera icons, player cleanup, and temporary URLs without database storage or secret-bearing errors.
- Sensor tiles now show icons/values without labels; labels remain in details/tooltips.
- Channel timer editors moved to details only; removed clock actions from main tiles.
- Reduced vertical margins around room/status and main controls, including touch layouts. Moved tile refresh to bottom-right without overlapping adjacent actions.
- Moved room, online state, and battery to the upper-right of the tile above main controls/readings.
- The earlier three-row tile layout separated icon/main control, name/aliases, and room/status with compact details/setup actions while retaining both channels and transport selection.

## After 0.8.3 — 2026-10-10

- Effects, music, and transitions gained descriptive popup wizards with review and draft return. Close is top-right; cancel/navigation stay at the bottom. Detail connection fields moved to the header center, actions to top-right, and duplicate provider text was removed.
- Restored the Aliases label in detail cards and made room, physical connection, selected route, and online state visible without opening the explanatory popup.
- Removed connection-route text from main tiles while keeping rooms. Temperature/humidity labels were temporarily restored there. Connection help became a dismissible balloon. Switch labels/controls moved closer, channel aliases below labels, and clocks opened per-channel timers while preserving collapsed drafts.
- Exposed declared lighting schedules separately from effects. Channel labels became clickable switch labels without redundant On/Off text; unknown/stale markers remained. Refresh initially moved top-right.
- Set tile minimum width to 340px with mobile adaptation and automatic columns. Removed visible alias prefixes on compact tags and added explanatory connection information.
- Compact tiles gained type-based icons and immediate power actions; secondary settings stayed in details. TRACER FOCUS 3 and WorkGtZb were temporarily deferred without loading quick controls.
- Added visible-card metadata loading and cached updates without physical polling; scrolling preserved drafts. Details close became an accessible 44px icon, with an arrow when returning to a group.
- Activity filters now match real capabilities; temperature sensors no longer show an irrelevant Motion filter.
- Circadian/random/wake-up/sleep settings gained repetition/points/review wizards. Done returns a draft; cancel preserves original data. Boolean parameters use one switch, and precise color controls move to a row expander.
- Added persistent device reports/command activity: motion logs open prominently, others collapsed, up to 2,000 events, filters, and earlier-event pagination. Sharing receives reports with cards closed; snapshots, reports, and command outcomes remain distinct.
- Battery moved into upper-right details and network-status tile context. Bath2 temperature labels/icons became compact without inventing percentage units. Nine backend and ten frontend checks were added.
- One Apply per card validates/sends changed values together; reverting removes an edit and failure retains drafts. Eight batch-apply checks were added. Precise color sliders expand from the picker row.
- Simplified parameter rows without individual borders, aligned smaller numeric inputs over sliders, and adopted the initial dark/blue bulb appearance. Reading help starts collapsed.
- Alias editing stays inside its tag, with accessible save/delete/cancel icons. Unicode device/channel aliases support Russian, Belarusian, and Polish with normalized duplicate checks.
- Moved power-on state, backlight, and inching to additional settings. Combined numeric input/slider rows and removed repeated report/range labels.
- Preserved timer, brightness, temperature, and mode targets when an old cloud cache follows a command, pending real confirmation. Manual mappings are explicitly our database records in technical data.
- A contradictory cloud offline flag no longer blocks an explicit command. Tuya 2001 is shown as device connection failure; commands are not automatically retried.

## After 0.8.3 — 2026-10-09

- Added inline device alias create/edit/delete, list tags, and alias search. Registered records reuse existing storage; cloud-only devices need no inventory import. Real names and channel aliases remain separate.
- Added per-device passive UDP discovery watches showing observed IP, last announcement, and address changes. Zigbee watches require a known parent. Close, lease loss, or 15 minutes stops reception without changing saved IPs.
- Persisted cloud channel aliases per account/device as separate tags beneath original labels. Removing an alias does not rename Smart Life or send a command.
- Added localized backlight, power-restoration, channel timer, and inching names/values/help while preserving source command codes.

## After 0.8.3 — 2026-10-08

- Unified local/Sharing/Developer device and group inventory by physical Tuya ID, using local room/alias data and explicit route choice. Connections now contains login/service settings; cloud devices need no import to display. Partial failures preserve other sources, inventory browsing does not poll LAN, and failed commands do not switch providers. Seven frontend checks added.
- Fixed accepted brightness/temperature drafts reverting when the cloud returns only power. Two checks reproduce a six-function bulb with power-only status.
- Kept normal bulb connection/type properties separate from technical function/DP mappings without guessing missing numbers.
- Sharing inventory became lightweight; functions and one HTTP snapshot load for the selected device. Added MQTT reports, old-message/snapshot guards, independent DP timestamps, account-scoped persistence, logout cleanup without remote revocation, and protection against late token refresh restoring logout. Seven backend checks added.
- Open Sharing forms read our cache every three seconds, preserving drafts and ignoring cancelled responses. Two frontend checks added. A real owner-operated second-channel report survived restart.
- Exposed known DP metadata without private strategies and added account-scoped CRUD for manual remote/group/multi-control mappings. These do not execute commands or apply Tuya bindings.
- Added schema-based lighting JSON/scene editors, power memory, and standard raw-v0 schedules with fallback for other formats. Music/transition fields are command-only and use device-specific ranges. Incoming/outgoing mapping views show both function/DP sides. Seven backend and 12 frontend checks added without new runtime dependencies.
- Connection UI now explains restored server authorization; reconnect/login remains explicit. PIR states distinguish unknown from no motion, and raw battery values do not become assumed percentages. Four tests cover the real read-only PIR/battery definitions.
- Saved API keys became hidden behind edit actions like User Code, with empty replacement fields, cancel, and separate credentials when changing servers.
- Added generic Boolean/number/enum/HSV/string/JSON controls, sensor reading age, post-ACK reads, partial group outcomes, duplicate protection, and no automatic retries. Twenty-nine frontend checks include inventory isolation across servers.
- Added read-only `status_range` scaling/units without making sensor functions writable; two backend privacy/read/auth checks added.
- Provisionally selected `cyd-028r-st7789` for the reported two-USB XXSR69 board and documented hardware uncertainty/ILI9341 alternatives.
- Split the Tuya UI into standalone React/TypeScript/Vite with independent launch/build, API address, service access, QR/User Code, Developer login, inventory, and search.
- Added explicit CORS origins and optional `/cloud` redirect; removed embedded Python HTML/wheel assets without new required Python dependencies. Thirteen backend and 20 frontend boundary tests plus browser checks used fake Tuya data.

## After 0.8.3 — 2026-10-07

- Correlated a newly paired Wi-Fi device's exact Sharing ID/activation time with UDP discovery; its local key came from authorized cloud access, not discovery packets. Private data stays outside Git.
- Added private passive UDP capture/decoding, IP/version summaries, and seven safe-write/decode tests; documented a real three-bulb/remote reconnection capture without control commands.
- Added independent Developer credentials, seven regions, separate save/connect, mode-0600 storage, HTTPS/HMAC, timeout/ACK handling, explicit provider routing, parent/cid import, and 32 tests.
- Hid saved User Code and service-key inputs behind empty replacement editors. Separate verified saves restore hidden state on reload. `PUT /cloud/user-code` saves for the next QR login without replacing the active account until confirmation.
- Restored the saved key automatically through a hidden field, leaving connection settings collapsed while maintaining authorization checks.
- Corrected gateway-key research: shared child keys are candidates requiring LAN verification, not impossible-to-obtain gateway keys or automatic parent assignments.

## 0.8.3 — 2026-10-07

- Reuse the saved server-side User Code for QR relogin when no new code is supplied, including after restart.
- Explain saved-code location/status without returning its value.
- Cover persistence, expiry, confirmed account change, and session deletion.

## 0.8.2 — 2026-10-07

- Panel tiles show selected readable capabilities without a fixed example-only set.
- Added generic group labels and UTF-8-safe reading limits.
- Document arbitrary room/device/group selection and test a room with covers, fans, and an outlet.

## 0.8.1 — 2026-10-07

- Cancelled panel room selection restores the saved configuration.
- Re-saving preserves retained widgets' explicit capability selections.
- Added native C++ selection/back-navigation checks.

## 0.8.0 — 2026-10-07

- LVGL/LovyanGFX firmware for five CYD profiles: room/widgets, persistence, groups, lamps/color/brightness/temperature, sensors, and unknown states.
- Added compact room/building lists and independent device/group pagination for MCUs.
- Added native C++ navigation/selection/freshness tests, ESP32 builds, and REST pagination tests.

## 0.7.0 — 2026-10-07

- Optional official Sharing SDK with User Code/QR, private server storage, and token refresh.
- Added the original `/cloud` page, safe metadata, selected-device import, and cloud-code commands.
- Researched public integration/client terms and added separate SDK tests.

## 0.6.0 — 2026-10-07

- Group CRUD and on/off/mixed/unknown state with per-member command results.
- Saved display room/widgets, compact dashboard, placement/limit checks, and background polling without blocking display reads.
- Tested a three-lamp/switch/temperature/humidity/motion room and restart persistence.

## 0.5.0 — 2026-10-07

- Explicit profiles, normalized DPS, limits, inversion, enums, and HSV v1/v2/JSON.
- Multi-capability commands with conflicting-DP checks and required lamp-mode writes.
- Independent observation timestamps without fabricated post-ACK state.
- Compared three Home Assistant integrations and tested direct/parent+cid variants.

## 0.4.0 — 2026-10-07

- Dedicated alias lookup and automatic current-name aliases.
- Round-trip alias lists, scoped ambiguous-name lookup, and old-database preservation.

## 0.3.0 — 2026-10-07

- Unicode-aware case-insensitive substring/exact name search for buildings, rooms, types, and devices.
- Scoped `/lookup/{resource}?name=...` and `name:...` paths for CRUD, hierarchy, and TinyTuya commands.
- Ambiguity returns 409 with safe candidates and no mutation/command. Name search needs no added alias and changes no stored data/schema.

## 0.2.0 — 2026-10-07

- Up to 32 normalized aliases per building/room/device, unique within the entity type.
- Alias CRUD/filter/path addressing, hierarchy, and device commands.
- Atomic alias import preserving omitted values and rolling back conflicts.
- Automatic alias-table creation over v0.1.0 without changing records/keys; numeric IDs continue working.
- Updated documentation, OpenAPI, and tests.

## 0.1.0 — 2026-10-07

- Building/room/type/device REST CRUD, hierarchy, and gateway/child links.
- SQLite/FastAPI/SQLAlchemy/TinyTuya with direct Wi-Fi and parent/cid Zigbee.
- Capability maps and status/on/off/set_dps/brightness/color/temperature commands.
- Write-only local keys, API token, atomic devices/snapshot import, and dry run.
- README, examples, OpenAPI, systemd/procd templates, and 45 passing tests.
