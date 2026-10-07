# Проверка проекта

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

The owner approved the service QR login in Smart Life. A read-only metadata query returned 44 devices: 42 reported a local key, 42 reported local support, and 23 children had a node ID. Both displayed gateways had no local key, so this does not establish usable local Zigbee control. The saved session and User Code survived a real service restart. No device commands, scene writes or imports into the SQLite inventory were performed. Credential values and real device identifiers are excluded from this report and Git. Earlier sections above describe verification at their respective development stages before this authorization.

## Saved User Code field visibility / 2026-10-07

Verified the updated localhost page in the browser against the saved session: after checking the service access key, the User Code field is hidden and the «Хочу изменить» link is visible. Clicking the link reveals an empty field and focuses it. Reloading the page and checking the access key returns to the hidden-field state. No new User Code was submitted and no QR login or device command was initiated. This update changes only the page and documentation; the 212-test backend result above remains the last full test run.
