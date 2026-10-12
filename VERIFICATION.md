# Проверка проекта

## Gateway key discovery — 2026-10-12

**394 Python tests and 184 frontend tests passed**; Ruff, TypeScript, production build and `git diff --check` passed. Thirty new backend checks cover candidate deduplication and real gateway categories despite `sub=true`, explicit foreign-parent exclusion, one-IP/private-address guards, protocol and time limits, failed/no-key cleanup, serialized verification, account/key/source changes, expiry/cancel, explicit review and server-only persistence. Installed TinyTuya 1.20.0 is exercised with genuine 3.4/3.5 HMAC negotiation and 3.3 AES decoding over simulated responses, including wrong keys; 3.1 is never accepted as key proof. Two new UI checks cover IP confirmation, verification without DPS/polling, explicit save and editable failures.

Browser verification showed the new action in WorkGtZb setup. The local API was restarted with the existing settings/database and its schema exposes `discover_gateway_key`; the browser reloaded all 46 Smart Life devices. Local inventory remains empty. No physical gateway was probed because its IP has not been supplied, and no device state was changed. The feature requires the owner to identify the actual gateway IP; matching a key does not establish a sensor's parent or confirm the gateway name.

## Unified device list and connection settings — 2026-10-08

**77 frontend tests passed**; TypeScript, production build and `git diff --check` passed. Seven additional checks cover restoring directly to management, settings without a second device list, merging local/Sharing/Developer identities by physical Tuya ID rather than name or database ID, room/alias filtering, explicit cloud-provider versus local-record command routing, retained route choice after closing a control, no retry through another transport, cloud-only operation without import, partial-source failures, and hiding cancelled/server-replaced records. The existing fixture for a motion sensor now has its own physical ID rather than incorrectly reusing the Zigbee lamp's ID. Build: JS 301.34 kB (91.83 kB gzip), CSS 12.57 kB (3.57 kB gzip). No dependency or backend transport changed.

The real API on 8765 and React dev server on 5173 were restored from the temporary historical comparison to the current repository. Authenticated read-only checks confirmed the saved Tuya account/User Code, 401 without a service key, the allowed frontend CORS origin, 46 cloud devices, preserved channel-2 report and connected report stream. Local-device and manual-mapping tables still contain zero rows. Browser verification showed the unified 46-device list without an import instruction, searched BedMain, opened its controls from Management and confirmed Connections contains only account/service settings. Screenshot: workspace `deliverables/react-unified-devices.png`; settings screenshot: `deliverables/react-connections-settings.png`. No credential change, inventory import, binding/scene mutation or agent-issued real device command was performed.

Multiple-route deduplication and command delivery were exercised with fictitious devices and simulated transports. Only Sharing is connected in the real runtime, so it has no physical local/Developer path to compare. Local groups continue to use the existing LAN endpoints. Room assignments and aliases come from existing local metadata; cloud-only devices are shown without a room. This UI consolidation does not establish that BedMain3 brightness/temperature commands physically work; that investigation remains unresolved.

## BedMain3 control investigation — 2026-10-08

**70 frontend tests passed**; TypeScript and production build passed. Two regressions use the observed shape of this lamp's metadata: six writable functions, an on/off-only snapshot and no verified DP for the numeric controls. Applying brightness 65% sends `work_mode=white` with `bright_value_v2=650`; temperature 40% sends `work_mode=white` with `temp_value_v2=400`. After acknowledgement followed by an unchanged snapshot, the selected input/slider value remains visible, Apply becomes disabled until another edit, and the actual reading remains unknown. A third check verifies that friendly lamp properties and collapsed mapping diagnostics are separate. These automated checks use fictitious device identifiers and a simulated cloud transport; they do not demonstrate physical lamp control.

The real Sharing API and the unmodified SDK's full device loader both currently return six functions for the owner's BedMain3: power, mode, v2 brightness, v2 color temperature, countdown and do-not-disturb. Both return only `switch_led` in the status/range and only DP 1 → `switch_led` in local_strategy. Brightness limits are 10–1000, temperature 0–1000, scale 0 and step 1. Missing DP numbers were not guessed. The ordinary properties list now shows the device type and connection; codes/types/verified DP numbers remain available in collapsed diagnostics for mapping.

During owner-initiated checks, the current API recorded `work_mode=white, temp_value_v2=533` and an isolated API snapshot from commit `cbd4710` recorded `work_mode=white, temp_value_v2=488`; both Tuya responses were `success=true, result=true`, while the owner reported no physical change. The previous API-only comparison retained the current React UI and therefore was not a complete application rollback. The command endpoint, percentage conversion and white-mode batching are unchanged since the first React controls (`7afe69c`). A speculative removal of mode batching did not help in the owner's check and was reverted.

Diagnostic records contain only the lamp name, a timestamp, lighting command codes/values and the response's Boolean fields/types. Keys, tokens, real device identifiers, response bodies and unrelated device commands are excluded. Runtime tracing is temporary and is not part of the application. The absence of a cloud reading and an accepted cloud request do not establish the lamp's physical state or explain why Smart Life still controls it.

## Sharing status latency and received reports — 2026-10-08

**290 Python tests passed**; Ruff and `git diff --check` passed. Seven new checks cover bounded lazy inventory/metadata queries using the installed SDK's real Manager and DeviceRepository, per-device refresh, cached reads without HTTP, malformed-response atomicity, unknown-device rejection, real SDK DP-to-code message decoding, older-report rejection, ACK without fabricated state, local MQTT shutdown/logout, persistence across restart, account isolation, online/offline/delete events and a late token callback after logout. Network responses and MQTT transport are simulated in automated tests; protocol decoding uses the actual SDK.

**67 frontend tests passed**; TypeScript and production build passed. Two new regressions cover three-second cache-only polling, a channel report and its timestamp, preserving an edited brightness draft, loading definitions once, cancelling on unmount and preventing a late cached response from overwriting an explicit refresh. Latest build: JS 300.64 kB (91.57 kB gzip), CSS 12.48 kB (3.54 kB gzip). No new runtime dependency was added.

Read-only inspection found that one Sharing status refresh previously updated the entire 46-device account, including four extra HTTP requests per device (roughly 186 sequential requests). The HTTP detail endpoint itself returned a stale `switch_2=false` for the owner's `WorkroomLigthSwith`; its verified mapping is DP 2 → `switch_2`, with no inversion. After the owner toggled it with the listener connected, the official MQTT stream reported `switch_2=true` at `2026-10-08T07:13:43.426Z`, received at `07:13:43.692560Z`. The first channel also reported true. No physical device command was issued by the agent.

Measured cold inventory: 0.73 s; individual HTTP refresh: 0.114–0.236 s; cached status: 0.001–0.002 s. Before the final restart, an online private SQLite backup was made and the exact already-received reports (values and original timestamps) copied to the new report cache. After restart, authenticated checks confirmed the account and saved User Code, 401 without the key, the allowed 5173 CORS origin, `switch_2=true` from persisted reports, a connected MQTT stream, and priority over the stale HTTP snapshot. Post-restart selected refresh took 0.108 s and cache reads 0.002 s; those inventory/definition reads were already warm because the open UI had resumed polling. These timings describe this network/account, not a guaranteed latency.

The real React page visibly showed both channels enabled with their device report timestamps, including after a manual read-only status refresh. Screenshot: workspace `deliverables/react-switch-status.png`. The real API on 8765 and React on 5173 remain running with the original database/key/session; local inventory and manual-map tables still contain zero records. No fresh login, credential change, mapping mutation, scene/binding change, device import or agent-issued actuator command was performed. Last-known reports do not certify the current physical state indefinitely; other device models' event delivery remains unverified.

## Lighting functions and manual device maps — 2026-10-08

**283 Python tests passed**; Ruff passed. Seven new checks cover DP metadata and ambiguity without disclosing local_strategy/config_item, manual mapping CRUD for all three kinds, incoming/outgoing visibility, account isolation/authentication, missing devices/codes and mismatched DP rejection, and Raw/base64 byte limits plus actual JSON effect ranges. Saving a map issues no cloud device command or association request. OpenAPI includes the four mapping operations; existing databases gain one new table without modifying device/token records.

**65 frontend tests passed**; TypeScript and production build passed. Twelve additional checks cover send-only lighting commands, structured music/control fields with actual 0–255 HSV limits, mode batching, version-0 golden byte vectors for rhythm/sleep/wakeup/random schedules, captured empty formats, unknown-version/length rejection and big-endian power memory. Mapping UI checks create/delete and both directions with both IDs/codes/DPs, lazy loading and no device command. Latest build: JS 298.35 kB (90.91 kB gzip), CSS 12.48 kB (3.54 kB gzip). No runtime dependency was added.

The owner's authorized account was inspected read-only. `WorkRoomLamp0` exposed 16 writable functions, with a verified local_strategy code→DP map (20–28, 30–34, 41, 210); music/control JSON specifies s/v 0–255. The cached music/control values were empty strings, consistent with the documented send-only functions. Standard v0 empty Raw lengths: rhythm 5 bytes, sleep/wakeup 2 bytes each, random 2 bytes; power memory 12 bytes. All values are excluded from Git except these nonsecret format observations. SDK device fields contained no remote/group/association metadata, and Sharing 0.2.15 public methods expose no binding read/write interface. This does not establish absence of bindings in Smart Life.

Browser verification used the production UI and an isolated real FastAPI app with a temporary SQLite database, fictitious lamp/switch and fake cloud transport. Verified structured music input, accepted command and separate mode snapshot, and an incoming `demo-switch / switch_1 / DP 1 → demo-lamp / switch_led / DP 20` record persisting after page reload. Screenshots: workspace `deliverables/react-lighting-effects.png` and `deliverables/react-device-mapping.png`. No real device command, Raw schedule application, Smart Life binding/scene mutation, fresh login, microphone permission or credential change was performed. Extended firmware behavior remains unverified on physical hardware. Manual map records do not execute automation or apply Tuya bindings.

A private SQLite backup was created before restarting the actual localhost API on 8765 with its original database, API key and Tuya session. Read-only HTTP checks confirmed health, retained account/User Code, 401 without the service key, the allowed 5173 CORS origin, all 16 live lamp function definitions with DP metadata, and the mapping endpoint. Both actual inventory and mapping tables remain empty. The React dev server on 5173 remains running. The temporary preview tab/API/static server were closed/stopped; no live credentials were changed.

## Restored account presentation — 2026-10-08

**53 frontend tests passed**; TypeScript and production build passed. Existing connection journeys now verify a restored authenticated account is identified as connected without a new QR request, an unloaded inventory is not mistaken for a missing account, and a fresh QR flow changes the heading after confirmation. Credentials, authentication checks and device transport are unchanged. The real backend was inspected read-only: Sharing connected, saved User Code present, cloud transport through the internet. No Tuya login or device command was performed.

## PIR sensor properties and presentation — 2026-10-08

Read-only inspection of the authorized Sharing API found one matching device, `Bath2 motion`: category `pir`, sub-device through a gateway, online, no writable functions. Its actual status definitions were `pir` Enum (`pir`/`none`) and legacy `battery` Integer (unit empty, range 0–500, scale 0, step 1); the inspected snapshot reported `pir` and battery 90. The active SQLite database `data/qr-check/smarthome.db` contained **zero devices** and no matching local record. No import, mapping, credential change, LAN query or device command was performed. The documented Tuya PIR status set confirms separate legacy unitless battery and explicit `battery_percentage` definitions; this implementation does not assume a percentage for the legacy value.

**53 frontend tests passed**, with four new regressions: both PIR code variants, unknown/absent/wrong-type motion, legacy battery versus explicit percent metadata, and read-only gateway sensor display/refreshed motion without writes. TypeScript and production build passed: JS 273.85 kB (83.95 kB gzip), CSS 11.61 kB (3.38 kB gzip). Screenshot verification used production assets and an isolated FastAPI instance with a fictitious sensor matching the observed property definitions. Verified movement indicator, numeric battery with unit note, readonly properties and snapshot receipt time. Screenshot: workspace `deliverables/react-motion-sensor.png`. Snapshot receipt time is not the time of a sensor event. Backend is unchanged; no live event stream is implemented.

## Saved service-key UI — 2026-10-08

All **49 frontend tests passed** after updating the existing connection checks for the hidden saved-key message, empty focused replacement, required key for another API address, invalid replacement preserving the working connection, and cancellation without requests or credential changes. TypeScript and production build passed (JS 271.73 kB, 83.43 kB gzip). Browser verification on the running React UI confirmed the message/link, opening an empty password field and cancellation restoring the summary. The check used a separate temporary tab; the user's open device control was left alone. No real key replacement, device command or Tuya login was performed. Screenshot: workspace `deliverables/react-saved-service-key.png`. Backend is unchanged.

## React device controls — 2026-10-08

**276 Python tests passed**; Ruff passed. Two new backend checks verify read-only cloud sensor range metadata, scaling/unit preservation, field whitelisting, credential non-disclosure, optional ranges, authentication and rejection of sensor writes. Existing Wi-Fi and gateway/child transport checks remain in the full suite.

**49 frontend tests passed**, including 29 added control checks: legacy/v2/advertised HSV and RGB vectors, cloud percentages and decimal temperature/step, actual writable mode batching, malformed/unsupported metadata, typed enum/JSON, unknown motion and browser-side expiry, explicit Sharing/Developer commands, staged values, ACK without fabricated status, offline/disabled devices, accepted command followed by failed status, duplicate-click/close guard, direct/child inventory ID addressing, partial group receipt, room/alias filtering, group/member/back navigation without LAN polling, timeout without command retry, and clearing the old inventory during API-server changes. TypeScript and production Vite build passed: JS 271.05 kB (83.29 kB gzip), CSS 11.03 kB (3.22 kB gzip). No runtime dependency was added.

Browser checks used production static files on 5174 and an isolated instance of the real FastAPI application on 8766, with a temporary SQLite database and fictitious transports/account. Verified cloud power, percentage brightness, HSV color with mode changes, separate normalized read-only temperature/humidity, room selection, local group power and refreshed member states, group → Zigbee member → color/off → back, and the resulting mixed group state. Local data naturally expired after 60 seconds; explicit refresh restored fresh readings. No actual device, scene or account mutation was performed. Example screenshot: workspace `deliverables/react-group-controls.png`. Physical device compatibility and mobile/display hardware remain unverified.

The real API on 8765 was restarted with its original database/key/session. Read-only checks confirmed health, the saved connected account/User Code and the localhost UI CORS origin. The actual React dev server remains on 5173. Real credential values were compared in memory against React source/dist; there were zero matches and no values were printed. Local keys stay on the service; frontend commands carry only inventory IDs/capability values or explicit cloud codes/provider. The temporary demo API and static server were stopped after verification. Firmware is unchanged.

## Separate React frontend — 2026-10-08

**274 Python tests passed**, including 13 new origin/preflight/header/authentication/default-disabled/redirect/configuration checks. Ruff passed. **20 frontend tests passed**: server/key restoration and verified saving, invalid replacement rollback, requiring a new key when changing API hosts, independent User Code/Developer saves, explicit providers, cross-origin QR URL resolution and rejection of unrelated URLs, confirmation/expiry/blob cleanup, disabled cloud and invalid access, device name/ID search and text escaping, error handling and request timeout without retry. `pnpm build` passed TypeScript checking and production compilation with pinned React 19.3.0 / Vite 8.3.3 / TypeScript 7.0.2. Output JS: 238.73 kB (74.53 kB gzip); CSS: 7.10 kB (2.33 kB gzip). Dependencies are fixed in pnpm-lock.yaml.

Browser verification used the production dist served by a plain Python static server on 5174 and a separate fake API on 8766. Verified initial access saving and collapsed settings, saved User Code hidden, QR SVG loading across ports and confirmation, two Sharing devices and search, saving Developer credentials with us-e and hidden fields, explicit connect and three Developer devices. No actual cloud authorization or hardware commands were used in these browser checks. Screenshot with fake devices: workspace deliverables/react-ui.png. Responsive CSS is included; no physical mobile/display test was performed.

The real API was restarted on 8765 using its original database/session/key, with only localhost UI origins allowed. Read-only HTTP checks confirmed the saved Tuya session and User Code, actual CORS response, compatibility 307 redirect from /cloud, and the independent React dev server on 5173. The browser's new UI origin requires entering the service key once; no new Tuya QR login is needed. Real credentials/device data were not placed in frontend source, bundle, screenshots or Git. A Python wheel built from a clean source copy contains neither React assets nor embedded HTML. Firmware and device transports are unchanged.

## First-time Tuya device pairing capture — 2026-10-07

Recorded 216 decoded UDP packets and nine discovered devices: 163 device messages, 51 discovery requests from another client (`from=app`), and two own standard REQ_DEVINFO requests. A read-only Sharing inventory query returned 46 devices against the previous snapshot's 45. The one new direct record (`kg`, `sub=false`) had creation/activation times after capture began; its ID matched one UDP 7000 / `6699` discovery response with Tuya version 3.5.

The new response contained no local_key/localKey/key field; `token` was Boolean. A current local key was available through the authorized Sharing API, and its value was not saved in metadata snapshots or the report. Capture stopped after the user's completion message. No LAN status/control, scene change, SQLite import, full TLS registration capture or Zigbee RF capture was performed. Raw files, names, IPs and IDs remain in the private Git-ignored capture directory. This update changes documentation only; no test run was needed, and the prior verification results below remain unchanged.

## Tuya discovery capture — 2026-10-07

Seven new capture tests passed; Ruff passed. Tests cover plain/ECB/GCM discovery decoding without a device key, malformed/nonobject packets, replacement-file permissions, private raw/decoded output, unknown version handling, closed sockets and no payload/ID/token disclosure in stdout. Core service and firmware were unchanged; the prior 254 service tests remain the latest full-suite result.

Real capture: 498 decoded UDP packets (496 device messages plus two own discovery requests), discovering 13 devices, including all three recently re-paired Wi-Fi lamps after a standard discovery probe. Sharing metadata matched their IDs and confirmed current local-key availability; a recently activated Zigbee remote had node_id. No local_key was present in the captured lamp packets; `token` was Boolean. Capture stopped after the user's completion message. No device control, LAN status query, scene change or SQLite import was performed. No full TLS or Zigbee RF capture was obtained. Private raw files and exact IDs/keys are excluded from Git; see [packet-capture.md](docs/packet-capture.md).

## Developer authorization update — 2026-10-07

**254 Python tests passed**, including 32 new Developer checks; Ruff passed. Tests cover both published Tuya signature vectors, signed request bodies and sorted/encoded queries, token expiry, all seven fixed HTTPS regions, timeouts and one command attempt, pagination and cursor rejection, sample Device ID → account UID, secure credential persistence/restart, atomic-write rollback, malformed/symlink files, authentication, secret non-disclosure, independent QR state, writable-function validation/ACK, and gateway/cid import with dry-run and WAN-IP rejection. OpenAPI updated. No new runtime dependency was introduced.

Browser verification used an isolated local app with fake Tuya responses: saved service access, selected Developer, saved the pair with `us-e`, verified fields became hidden, connected and listed three fake devices, opened empty replacement fields, cancelled, reloaded and restored the saved region/connection; QR login remained available. The real localhost page was reloaded and left on the new Developer form with empty credentials. The user's existing QR session was preserved; no real Developer credentials, Developer account login, hardware command or real inventory import was used. Screenshot: workspace `deliverables/tuya-developer-login.png`. Firmware is unchanged.

Дата: 7 октября 2026. Версия сервиса: 0.8.3. Среда проверки: macOS ARM64, Python 3.14.7. Ниже сохранены проверки предыдущих этапов. Linux/OpenWrt и физические Tuya-устройства в этой среде не проверялись.

- `python -m pytest -q`: **117 passed** (45 первоначальных, 41 проверка алиасов и 31 проверка поиска по названию).
- `ruff check .`: **All checks passed**.
- `sh -n deploy/smart-home.init`: синтаксис корректен. Реальный procd/systemd не запускался.
- Пакет собран из `pyproject.toml` и установлен во временное виртуальное окружение. Команда `smart-home` работает из другого каталога.
- Импорт примеров `devices.example.json` + `snapshot.example.json`: 3 устройства, без предупреждений; dry-run не сохраняет устройства.
- Для v0.1.0 настоящий Uvicorn запускался на localhost: `/health`=200, анонимный inventory=401, авторизованный inventory, parent/cid и hierarchy. В v0.2.0 новые адреса алиасов проверены через FastAPI TestClient; реальный LAN-транспорт в тестах не вызывается.
- Алиасы проверены для зданий, комнат и устройств: нормализация, уникальность, создание/замена/удаление, освобождение после удаления объекта, hierarchy и guard-проверки, фильтр `alias`, команды Wi-Fi и Zigbee, API-токен, импорт/dry-run/откат конфликтов и сохранение после перезапуска.
- Проверено обновление базы v0.1.0: автоматически добавляются три таблицы алиасов, существующий device_id и local_key сохраняются, алиасы работают после повторного запуска.
- Поиск проверен для зданий, комнат, типов и устройств: кириллица/регистр/NFC, точное и частичное совпадение, пагинация, обычные `%`/`_`/кавычки, уточнение расположения, пустые/длинные запросы, конфликты с алиасами и числовыми названиями, bounded-список неоднозначных совпадений, авторизация, name-адреса CRUD/hierarchy и команды Wi-Fi/Zigbee без реальной сети.
- OpenAPI-схема сохранена в `openapi.json`; это снимок схемы, актуальная версия доступна у запущенного сервера.

В тестах используются поддельные ответы транспорта для контроля Wi-Fi, Zigbee, timeout/error и ACK. Дополнительно реальные объекты TinyTuya создаются без сетевого соединения, и проверяется структура child control payload и наследование версии gateway для 3.3/3.4/3.5. Это проверка интеграции с библиотекой, не подтверждение совместимости конкретного шлюза или устройства.

Установленные версии:

```text
fastapi==0.142.2
uvicorn==0.54.0
SQLAlchemy==2.0.54
pydantic==2.13.5
tinytuya==1.20.0
pycryptodome==3.24.0
pytest==9.1.1
httpx==0.28.1
ruff==0.16.10
```

Тестовая среда выдала одно предупреждение Starlette о будущей замене `httpx` в TestClient; тесты прошли. Файл `requirements.txt` содержит диапазоны совместимых версий: на Python 3.10/другой архитектуре resolver может выбрать другие версии зависимостей. Работоспособность всего диапазона версий отдельно не проверялась. Ресурсы RAM/flash на OpenWrt не измерялись; Python и нативные crypto/Pydantic-пакеты нужно учитывать в образе устройства.

## Alias lookup update

123 API/transport/import/search tests passed; ruff check passed. Added tests for automatic Cyrillic names, alias query lookup, ambiguity scopes, rename, read/write round trip and capacity. No physical Tuya device was used.

## Device variants update

178 tests passed, including 55 new representative device/profile checks. Wi-Fi and parent/cid Zigbee commands use a fake transport; color vectors also match installed TinyTuya helpers. Ruff passed. Physical hardware and all third-party catalog entries have not been tested.

## Room dashboard update

193 tests passed, including 15 room/group/display checks. Tested partial command failure, ACK without fabricated state, stale motion, selection constraints, deletion/move restrictions, background polling deduplication and persistence across restart. No physical display was attached.

## Optional cloud QR update

204 tests passed; 11 new cloud checks use fake login/manager APIs. Real cloud credentials/QR approval were not supplied, so no real account was connected. Tested local SVG rendering, session file 0600, token refresh persistence, non-disclosure, parent/cid import, command validation and checked acknowledgements. No remote terminal revocation was performed.

## CYD firmware / current checks

- **206 Python tests passed**; Ruff and `git diff --check` passed. Added compact room/building selection and independent group/device pagination checks. OpenAPI snapshot regenerated for 0.8.0.
- Native C++11 model compiled with `-Wall -Wextra -pedantic`, assertions passed: selection, group/device/color navigation, bounds/step and missing/stale/disconnected readings.
- Full LVGL application built successfully for **all five** PlatformIO environments: cyd-028r, cyd-028r-st7789, cyd-028c, cyd-035r, cyd-035c. Pinned espressif32 6.12.0 / Arduino ESP32 2.0.17, LVGL 8.4.0, LovyanGFX 1.2.7, ArduinoJson 6.21.5.
- Static RAM reported by linker: **115340–115396 bytes of 327680**; application flash **1085357–1094561 bytes of 3145728**. These are build figures, not measured free heap under Wi-Fi/HTTP/LVGL load. The firmware includes bounded responses and JSON documents; runtime operation needs a physical board test.
- No display was flashed, no hardware pins/touch calibration were verified on a physical board, and no real Tuya command or cloud account login was performed.
- Built wheel `smart_home_service-0.8.0-py3-none-any.whl` and installed it into a separate directory. A real localhost Uvicorn process using that installed package passed HTTP checks for health/version, authentication, packaged `/cloud` page, automatic name alias lookup, room/building selection and a three-lamp group dashboard. The process was stopped after the check; no real device command was sent.

## Panel selection fix / 0.8.1

206 Python tests passed again; Ruff passed. Native C++ assertions now also verify cancellation restores the previously saved room and tiles. All five full firmware builds passed after the fix: static RAM 115444–115500 bytes, flash 1087981–1097145 bytes. Built the 0.8.1 wheel; OpenAPI and package metadata updated. Actual board, touch, device and cloud login limitations remain as above.

## Arbitrary panel selection / 0.8.2

207 Python tests passed; Ruff and whitespace checks passed. Added a different-room selection test with a cover, a fan group and a metering plug: room-scoped options, exact selected widget order, position/power readings, group members and removal of unselected tiles. Generic firmware summaries now iterate readable capabilities rather than a list limited to the initial room example. Native C++ assertions cover safe UTF-8 status text bounds; all five full firmware builds passed. No physical board was available.

## Saved User Code / 0.8.3

212 Python tests passed, including 16 cloud checks; Ruff passed. Repeated QR login accepts an omitted or null User Code and uses the code from the previously confirmed session. Tests cover no saved session, restart, non-disclosure in responses, QR expiration, pending account changes and explicit logout. The existing session file remains `0600`; changing accounts replaces the saved code only after successful confirmation. A real localhost service was restarted with its saved session: the updated page detected the saved code while its field stayed empty. OpenAPI and package metadata updated. Firmware is unchanged in this update.

## Real Sharing SDK authorization / 2026-10-07

The owner approved the service QR login in Smart Life. A read-only metadata query returned 44 devices: 42 reported a local key, 42 reported local support, and 23 records with `sub=true` had a node ID. Both displayed gateway records had no local key; the shared-child-key investigation below qualifies this observation. The saved session and User Code survived a real service restart. No device commands, scene writes or imports into the SQLite inventory were performed. Credential values and real device identifiers are excluded from this report and Git. Earlier sections above describe verification at their respective development stages before this authorization.

## Saved User Code field visibility / 2026-10-07

Verified the updated localhost page in the browser against the saved session: after checking the service access key, the User Code field is hidden and the «Хочу изменить» link is visible. Clicking the link reveals an empty field and focuses it. Reloading the page and checking the access key returns to the hidden-field state. No new User Code was submitted and no QR login or device command was initiated. This update changes only the page and documentation; the 212-test backend result above remains the last full test run.

## Separate credential save buttons / 2026-10-07

**222 Python tests passed**; Ruff passed. Ten added checks cover saving User Code before authorization without contacting Tuya, `0600` persistence and restart, non-disclosure, legacy session loading, preserving the current account during a code change and token refresh, invalid inputs and authorization, rejection of malformed preference files, and atomic-write failure with rollback and temporary-file cleanup. The OpenAPI snapshot includes the new authenticated `PUT /api/v1/cloud/user-code` endpoint.

In the real localhost browser page, verified both save buttons and change links. Saved the existing service access key in browser storage and saved the already-confirmed User Code again on the server; both fields disappeared. An invalid replacement access key was rejected without overwriting the saved key. Reloading restored the valid key automatically and kept both fields hidden. No new account authorization, device command or scene change was performed; credentials remain excluded from Git and screenshots.

## Hidden service access token / 2026-10-07

Verified the revised localhost page in the browser: reload automatically restored the saved token and read the authorized User Code status. The token input has type `hidden`, the access-key editor is invisible in the normal form, and «Настройки подключения» is collapsed. Expanding settings reveals the empty editor and its save button; closing settings restores the normal form. The server still requires `X-API-Key`, and the page source does not contain the configured server token. This update changes only HTML/JavaScript and documentation; the 222-test backend run above remains the last full test run. No new credential was saved, QR login initiated or device command sent during this check.

## Shared child keys as gateway candidates / 2026-10-07

A further read-only Sharing SDK metadata query returned 44 devices and 42 nonempty keys. Of 23 records flagged `sub=true`, 21 had a key; those 21 records shared only two distinct keys, with group sizes 16 and 5. Both keys encoded to 16 bytes. The two `wg2` records had no key, so the other two `sub=true` records were gateways themselves. Keys were compared in memory, and only aggregate counts were printed. This matches the documented possibility that Sharing API places a gateway key on its children; it does not confirm which key belongs to which physical gateway or whether either gateway accepts LAN control. No LAN request, device command or inventory import was performed. No implementation changed, so the 222-test result remains the last full test run.

## Reported ESP32-2432S028 board / 2026-10-08

The owner reported `ESP32-2432S028 XXSR69` and two USB connectors. The existing `cyd-028r-st7789` environment is now the initial default, based on the Sunton R v3 definition and witnessmenow CYD2USB setup. The README records this as a provisional choice, retains the ILI9341 alternative, and distinguishes the panel's direct REST API connection from the separate React frontend. No verified LCD/revision mapping was found for `XXSR69`.

`pio run -d firmware/cyd` selected the new default and completed successfully using the example Wi-Fi/API placeholders, with no private `panel_config.h` present. Linker figures: 115444 bytes static RAM of 327680, 1089121 bytes application flash of 3145728. `git diff --check` passed. This configuration/documentation update does not change panel logic or the backend; no hardware was flashed, no LCD/touch behavior was verified, and no device command was sent.

## Standalone LAN observations and explicit network selection / 2026-10-12

414 backend tests and 192 frontend tests passed; Ruff, production build and `git diff --check` passed. Coverage includes authenticated LAN-only endpoints with cloud access forbidden, malformed/bounded mDNS and SSDP, secret/raw-payload exclusion, neighbor cache handling, identity/IP changes, leases/session limits, shared sockets and release, explicit discovery throttling, actual interface prefixes, exclusion of other subnets, selected-interface discovery, menu navigation without a Tuya account, delayed-start cancellation, hidden-tab cleanup, filters and report contents.

Real browser verification initially found mDNS on the computer's `192.168.20.x` network. The owner identified the required network as `40.x`; actual interface inspection confirmed a second interface on `192.168.40.0/24`. Added mandatory interface selection: multicast joins the selected interface, packet/neighbor results are filtered by its actual prefix, and discovery broadcasts originate only there. No Wi-Fi settings were changed and no Smart Life metadata was queried for this page.

On the selected `40.x` interface, the browser received 59 packets, recognized 38 and showed ten actual Tuya IDs (protocols 3.4/3.5). Observation was stopped explicitly. The browser's JSON download was found and parsed: ten records, every device IP in the selected subnet, selected-interface metadata included and private scan ID excluded. A separate short API observation saved a private report under ignored `data/network-reports/` and was also stopped. No gateway/child associations or friendly names were inferred, no actuator commands or key probes were sent, and no inventory records were imported. Real IDs and report data remain outside Git. The screenshot records the selected subnet and stopped result; download automation itself timed out once, but a subsequent bounded click produced a verified file.

## WorkGtZb local gateway setup / 2026-10-12

At the owner's request, matched the gateway's exact authorized device ID to a Tuya announcement on the selected `40.x` network. A candidate key from authorized child metadata passed the protocol 3.5 cryptographic handshake against that exact gateway. The existing commissioning flow saved one local gateway with the verified address/protocol, existing aliases and Smart Life room placement; readback confirmed those fields and server-side key presence. No key or real device ID is recorded here or in Git. No actuator commands were sent and no child associations were assigned.

Browser verification confirmed the local route in the gateway detail card and WorkGtZb as an available gateway in a sensor's local-setup selector; the sensor wizard was cancelled without saving. Gateways without their own DPS now explain where child controls belong, instead of asking for capabilities through REST. The detail card's unknown-state badge reflects its empty cached readings, rather than a failed commissioning handshake. Both existing control test suites passed (36 tests), TypeScript and production build passed, and `git diff --check` passed. The backend was unchanged; the preceding 414-test result remains the latest full backend run.

## Backend gateway setup orchestration / 2026-10-12

445 backend tests passed, including 31 new gateway-setup checks; the new suite was rerun after its fixture cleanup and passed again. Ruff and `git diff --check` passed. Tests cover exact ID membership, explicit interface/subnet selection, real announcement parsing using peer IP rather than payload IP, the existing read-only cryptographic controller, own/child keys and both providers, scoped aliases and cached placement, idempotent retries, connection-only updates with child/configuration preservation, account/key/parent/category/interface changes, concurrent inventory writes, alias conflicts and atomic rollback, listener readiness/throttling, unsupported protocol/address conflicts, timeout cleanup, authentication and request validation. The OpenAPI snapshot includes the new endpoint and its request/response schemas.

Restarted the real localhost API against its existing database and invoked `POST /api/v1/gateways/setup` for WorkGtZb with its actual ID and selected interface. The server independently discovered the address, verified the child-sourced key, and returned `verified: true, action: unchanged`. Readback confirmed the same local ID, name, aliases, room, capabilities, connection fields and update timestamp; inventory remained one device. No actuator commands or child associations were sent. Private identifiers, addresses and keys are excluded from this report. Frontend code was unchanged: the existing wizard remains in use until this backend API is wired to a UI action.

## Separate gateway find and confirmed save / 2026-10-12

Replaced the preceding automatic-save endpoint with `POST /api/v1/gateways/find` and `POST /api/v1/gateways/save`. Find produces a credential-free preview and a random handle, with proposed changes held in a separate bounded in-memory store for five minutes. It never creates or updates inventory. Save requires the handle and the actual Boolean `confirmed: true`, rechecks the exact connection and context, and consumes a successful finding. The old `/gateways/setup` route is absent. Pending findings are cleared on shutdown; restart requires a fresh find.

467 backend tests passed, including 53 gateway-flow cases; Ruff and `git diff --check` passed. Added checks cover read-only previews for new/existing devices, rejection of missing/false/string/numeric confirmations and client overrides, account/key/parent/network/category and preview metadata changes between requests, failed fresh connection proof, expiry before/during save, bounded pending capacity, single use, manual edits, old-route removal and separation from commissioning tokens. Existing discovery, secret handling, atomicity, topology and child-preservation checks remain covered. The OpenAPI request/response contracts match the two new routes.

After restarting the real local API, called only `/gateways/find` for WorkGtZb: `verified: true`, proposed action `unchanged`, no changed fields. Full inventory readback was identical before and after finding. A save request with no confirmation was rejected with HTTP 422 and inventory again remained identical. No confirmed save or actuator command was sent during this real-device verification. Frontend code remains unchanged.
