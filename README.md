# Smart Home Local REST API

Python RESTful-сервис для локального управления зданиями, комнатами, типами устройств и устройствами Tuya. Стек: FastAPI, синхронный SQLAlchemy 2, SQLite, TinyTuya и PyCryptodome с AES-GCM. Python 3.10+. Docker не требуется.

## Быстрый запуск

```sh
cd smart-home-service
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
umask 077
export SMART_HOME_DB="$PWD/data/smarthome.db"
export SMART_HOME_API_TOKEN='replace-with-a-long-random-token'
python -m uvicorn smarthome.main:app --host 127.0.0.1 --port 8000 --workers 1
```

SQLite-файл и таблицы создаются при запуске. Swagger UI: <http://127.0.0.1:8000/docs>, OpenAPI: <http://127.0.0.1:8000/openapi.json>. В Swagger нажмите **Authorize** и укажите `SMART_HOME_API_TOKEN`. `/health` и документация доступны без токена; все `/api/v1/*` защищены заголовком `X-API-Key`, если токен задан. Если переменная пустая, аутентификация отключена.

Для доступа из LAN используйте `--host 0.0.0.0`, задайте токен и разрешите порт только доверенной домашней сети. Внешний доступ организуйте через VPN или HTTPS reverse proxy: встроенный Uvicorn здесь слушает обычный HTTP. CORS по умолчанию не включён.

Настройки из `.env.example` — справочный пример; файл `.env` автоматически не загружается. Переменные среды:

| Переменная | По умолчанию | Значение |
|---|---|---|
| `SMART_HOME_DB` | `./data/smarthome.db` | Путь к SQLite |
| `SMART_HOME_API_TOKEN` | пусто | Токен `X-API-Key` |
| `SMART_HOME_TUYA_TIMEOUT` | `3` | Тайм-аут операции с сокетом, секунды |
| `SMART_HOME_LOCK_TIMEOUT` | `5` | Ожидание занятого устройства/шлюза, секунды |

Запускайте **один worker и один экземпляр сервиса**: синхронизация команд одного gateway хранится в памяти процесса. Ожидание блокировки и сетевой тайм-аут ограничены; полный запрос может занимать несколько сетевых операций, особенно при handshake 3.4/3.5. Не задавайте автоматические HTTP-повторы команд: при потере ответа команда могла уже выполниться.

## Модель данных

```text
Building
  ├─ Room
  │   ├─ Device (wifi, direct)
  │   └─ Device (zigbee, parent_id + cid)
  └─ Device (здание задано, комната ещё не назначена)

DeviceType ── capabilities ── Device.device_type_id
Device (wifi, is_gateway=true) ── children.parent_id
```

- `Building`: `name`, `address`, `description`.
- `Room`: `building_id`, `name`, `description`. Имена комнат уникальны внутри здания.
- `DeviceType`: уникальный `slug`, `name`, `description`, карта `capabilities`.
- `Device`: `name`, `description`, `device_type_id`, `building_id`, `room_id`, `device_id`, `local_key`, `ip`, `version`, `transport`, `is_gateway`, `parent_id`, `cid`/`node_id`, `enabled`, `product_id`, `category`, `mac`, карта `capabilities`.
- `device_id` — строковый идентификатор Tuya. `id` и `parent_id` в API — числовые идентификаторы SQLite, это разные поля.
- `Gateway` представлен устройством с `is_gateway=true`, `transport=wifi`. Список шлюзов: `GET /api/v1/devices?is_gateway=true`.
- `cid` — адрес дочернего узла, **не** его Tuya `device_id`. `node_id` — входной алиас `cid`; в ответе оба поля содержат одно значение. Пара `(parent_id, cid)` уникальна.
- При задании `room_id` здание выводится из комнаты. Если одновременно передать другое `building_id`, API вернёт 422. Смена комнаты без явного здания переносит устройство в здание новой комнаты. `room_id:null` убирает комнату и оставляет здание; для полного отвязывания передайте также `building_id:null`.
- Child и gateway могут находиться в разных комнатах, но при известных зданиях должны принадлежать одному зданию. Поддерживается один уровень шлюза; циклы и вложенные шлюзы отклоняются.
- Удаление объектов с зависимостями возвращает 409. Удаление здания не удаляет автоматически комнаты и устройства. Gateway нельзя удалить или лишить роли шлюза, пока у него есть children.

Обновления делаются через `PATCH`: не переданные поля сохраняются, `null` очищает только nullable-поля. Карта `capabilities` при PATCH заменяется целиком на соответствующем уровне.

## REST API

Префикс: `/api/v1`. Для `buildings`, `rooms`, `device-types`, `devices` доступны:

| Метод | Путь | Результат |
|---|---|---|
| POST | `/{resource}` | Создать, 201 |
| GET | `/{resource}` | Список, `offset=0&limit=100`, максимум 500 |
| GET | `/{resource}/{id}` | Получить объект |
| PATCH | `/{resource}/{id}` | Частичное обновление |
| DELETE | `/{resource}/{id}` | Удалить, 204 |

Дополнительные пути:

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/buildings/{id}/hierarchy` | Здание → комнаты → устройства + `unassigned_devices` |
| GET | `/buildings/{id}/rooms` | Комнаты здания |
| GET | `/rooms/{id}/devices` | Устройства комнаты |
| GET | `/devices/{id}/children` | Children шлюза |
| GET | `/devices/{id}/status` | Живой запрос статуса TinyTuya |
| POST | `/devices/{id}/commands/status` | Тот же запрос статуса |
| POST | `/devices/{id}/commands/on` | Включить через capability `switch` или явный `dp` |
| POST | `/devices/{id}/commands/off` | Выключить |
| POST | `/devices/{id}/commands/set_dps` | Записать DPS: `{"dps":{"1":true,"22":500}}` |
| PUT | `/devices/{id}/capabilities/{name}` | Установить capability: `{"value":...}` |
| POST | `/devices/{id}/commands/brightness` | Capability `brightness` |
| POST | `/devices/{id}/commands/color` | Capability `color` |
| POST | `/devices/{id}/commands/temperature` | Capability `temperature` |
| POST | `/imports/tinytuya` | Атомарный импорт JSON |

Фильтры устройств: `building_id`, `room_id`, `device_type_id`, `parent_id`, `is_gateway`, `transport=wifi|zigbee`, `unassigned=true` (нет ни комнаты, ни здания). Фильтр комнат: `building_id`. Вложенные списки и hierarchy возвращаются целиком; для большого инвентаря используйте списковые API с пагинацией.

Ошибки: 401 — токен, 404 — объект отсутствует, 409 — конфликт/нет нужной конфигурации, 422 — неверные поля/связи/значения capability, 502 — ошибка Tuya/непригодный ответ, 503 — занят gateway или БД, 504 — нет ответа/тайм-аут. Ошибки валидации возвращают путь поля и тип ошибки без исходного значения.

## Пример: здание, комната, Wi-Fi и Zigbee

Ниже пример для **пустой базы**; числовые `id` берите из реальных ответов. IP, device_id, ключи и cid в примере вымышленные. Эти ключи нужны только для демонстрации структуры.

```sh
export BASE=http://127.0.0.1:8000/api/v1
export TOKEN='replace-with-a-long-random-token'

curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Дом","address":"Warsaw"}' "$BASE/buildings"

curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Кухня","building_id":1}' "$BASE/rooms"

curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @examples/relay-type.json "$BASE/device-types"

# Wi-Fi напрямую: API id=1
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Розетка","device_id":"demo_wifi_outlet","room_id":1,"device_type_id":1,"ip":"192.168.1.40","version":"3.3","local_key":"fedcba9876543210"}' \
  "$BASE/devices"

# Gateway: API id=2
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Tuya gateway","device_id":"demo_gateway","building_id":1,"is_gateway":true,"ip":"192.168.1.20","version":"3.5","local_key":"0123456789abcdef"}' \
  "$BASE/devices"

# Zigbee child: API id=3. Собственные IP и local_key ему не нужны.
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Zigbee реле","device_id":"demo_zigbee_relay","room_id":1,"device_type_id":1,"transport":"zigbee","parent_id":2,"cid":"0011223344556677"}' \
  "$BASE/devices"

curl -sS -H "X-API-Key: $TOKEN" "$BASE/buildings/1/hierarchy"
curl -sS -H "X-API-Key: $TOKEN" "$BASE/devices/2/children"
curl -sS -H "X-API-Key: $TOKEN" "$BASE/devices?room_id=1"

# Реальные LAN-команды — выполняйте после замены тестовых реквизитов.
curl -sS -H "X-API-Key: $TOKEN" "$BASE/devices/1/status"
curl -sS -X POST -H "X-API-Key: $TOKEN" "$BASE/devices/3/commands/on"
curl -sS -X POST -H "X-API-Key: $TOKEN" "$BASE/devices/3/commands/off"
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"dps":{"1":true}}' "$BASE/devices/3/commands/set_dps"

# Явный номер DP, если capability switch ещё не настроена:
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"dp":"1"}' "$BASE/devices/3/commands/on"

# Переназначение/отвязывание и удаление:
curl -sS -X PATCH -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"room_id":null,"building_id":null}' "$BASE/devices/1"
curl -sS -X DELETE -H "X-API-Key: $TOKEN" "$BASE/devices/1"
```

## TinyTuya и gateway

Для Wi-Fi создаётся `tinytuya.Device(device_id, ip, local_key, version=...)`. Для Zigbee создаётся gateway с его IP, ключом и версией, затем `tinytuya.Device(child_device_id, parent=gateway, cid=child_cid)`. Собственные IP/ключ/версия child не используются для соединения. Это соответствует [официальному Gateway / Sub-Device API TinyTuya](https://github.com/jasonacox/tinytuya/blob/master/API.md#gateway--sub-device-pattern).

Версия протокола задаётся явно: 3.1/3.2/3.3/3.4/3.5. Импорт без версии допустим для инвентаря, но управление вернёт 409 до заполнения IP, ключа и версии **прямого устройства/шлюза**. Автоматический сетевой discovery в сервис не включён: используйте TinyTuya scan и импорт snapshot, либо DHCP reservation и PATCH IP.

На один запрос открывается одно соединение, выполняется команда и соединение закрывается. Операции gateway и всех его children выполняются последовательно внутри одного процесса. Другие программы или Tuya-приложения могут конкурировать за LAN-соединение устройства.

Ответ команды содержит только `device_id` (API id), `command`, `acknowledged`, `dps`, `observed_at`. `acknowledged=true` означает пригодный ответ протокола, но не гарантирует физическое исполнение. Пустой ACK возвращается с `dps:{}`. Запрошенные значения не подставляются как подтверждённые; `last_dps` обновляется только реально полученными DPS. `last_seen_at` — время последнего пригодного ответа; `last_dps` — накопленный кэш последних наблюдений, отдельные значения могут быть старыми. `GET /devices/{id}` читает инвентарь/кэш и не опрашивает сеть.

При ошибке/тайм-ауте после отправки результат физического действия может быть неизвестен. При сбое БД после успешной LAN-команды физическое действие также могло произойти. Проверяйте статус перед повтором. Некоторые спящие Zigbee-датчики не отвечают на polling: для них нужен будущий постоянный receive loop/event ingestion. Matter-шлюзы и отдельные firmware могут не поддерживать локальный Tuya-протокол; наличие parent/cid само по себе не обещает совместимость оборудования.

## Capabilities, brightness/color/temperature

Карта capability связывает смысловое имя с DPS и типом значения. Карта устройства перекрывает одноимённые записи DeviceType; остальные записи наследуются. Номера DPS не угадываются по категории или имени устройства.

Пример типа лампы: [`examples/bulb-type.json`](examples/bulb-type.json). Он иллюстрирует распространённые DP 20–24, но требует проверки на вашей модели. Включение/выключение использует `switch`; без этой capability или явно заданного `dp` API вернёт 409. `set_dps` — низкоуровневый доступ, обходящий ограничения карты capabilities; он проверяет формат номера DP и JSON, но ответственность за корректность payload остаётся у вызывающего.

Поддерживаются `boolean`, `integer`, `number`, `string`, `object`, `readable`, `writable`, `minimum`, `maximum`, `enum`, `unit`, `encoding`. `readable` — описание свойства; status возвращает сырые DPS независимо от него. Для чтения смысловых значений клиент использует карту capabilities и полученные DPS.

- `brightness` и `temperature` передают **сырые значения диапазона вашей модели**. Автоматического перевода процентов или Kelvin нет. Для термостата задайте отдельную capability, например `target_temperature`, с правильным DP и единицей. Не смешивайте её с цветовой температурой лампы.
- `color` с `encoding=tuya_hsv` принимает `{"h":0..360,"s":0..1000,"v":0..1000}` и кодирует 12 hex-символов. Старые модели с другим кодированием используйте через `encoding=raw` с `type=string` или `set_dps`.
- Для ламп режим `white`/`colour` задаётся отдельно через capability `mode`, если этого требует устройство. Автоматического переключения режимов нет.

```sh
# Создать тип и назначить существующей реальной лампе:
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @examples/bulb-type.json "$BASE/device-types"
# Далее подставьте реальные id вместо 10 (лампа) и 2 (тип).
curl -sS -X PATCH -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"device_type_id":2,"capabilities":{}}' "$BASE/devices/10"

curl -sS -X PUT -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":"white"}' "$BASE/devices/10/capabilities/mode"
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":500}' "$BASE/devices/10/commands/brightness"
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":300}' "$BASE/devices/10/commands/temperature"
curl -sS -X PUT -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":"colour"}' "$BASE/devices/10/capabilities/mode"
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":{"h":120,"s":1000,"v":500}}' "$BASE/devices/10/commands/color"
```

## Импорт devices.json / snapshot.json

Поддерживается список объектов или оболочка `{"devices":[...]}`. Для идентификатора принимаются `id`, `device_id`, `gwId`; ключа — `key`, `local_key`; версии — `version`, `ver`; child — `cid`, `node_id`; родителя — `parent`, `gateway_id`, `parent_device_id`. В исходных TinyTuya-файлах parent содержит строковый Tuya ID шлюза, который преобразуется в числовой `parent_id` базы.

Записи объединяются по Tuya device ID. Snapshot дополняет/обновляет IP, версию и доступные реквизиты. Пустые поля не стирают существующие реквизиты. В snapshot могут отсутствовать children; они сохраняются из devices.json. `data`, DPS snapshot и произвольные raw/cloud поля не импортируются: старый снимок не считается текущим статусом. Capabilities настраиваются отдельно после импорта. См. [формат snapshot TinyTuya](https://github.com/jasonacox/tinytuya/blob/master/tinytuya/scanner.py) и [parent-поля wizard](https://github.com/jasonacox/tinytuya/blob/master/tinytuya/wizard.py).

Импорт — upsert, повторный запуск не создаёт дубликаты. Явные поля размещения в запросе применяются ко всем импортируемым устройствам; не переданные сохраняются. Родители обрабатываются до children независимо от порядка строк; упомянутые прямые устройства помечаются шлюзами. Если parent неизвестен, импорт не угадывает его по ключу: передайте `parent_map` или исправьте `parent` в источнике. Нет parent/cid, конфликт идентификаторов или неверные поля — откат **всего** импорта. `dry_run=true` выполняет проверки и откатывает изменения; на новой базе таблицы всё равно создаются.

CLI, без работающего HTTP-сервера:

```sh
# requirements.txt достаточно для вызова модуля:
python -m smarthome.cli --devices examples/devices.example.json \
  --snapshot examples/snapshot.example.json --dry-run
python -m smarthome.cli --devices examples/devices.example.json \
  --snapshot examples/snapshot.example.json

# Реальные файлы, с размещением (существующие room/type) и уточнением родителя:
python -m smarthome.cli --devices devices.json --snapshot snapshot.json \
  --room-id 1 --device-type-id 1 --parent-map examples/parent-map.example.json

# Можно установить проект и использовать короткую команду:
python -m pip install .
smart-home --devices devices.json --snapshot snapshot.json --dry-run
```

Импорт по API не требует multipart-зависимостей и принимает уже прочитанный JSON. Чтобы собрать тело из двух файлов без jq:

```sh
python -c 'import json; from pathlib import Path; print(json.dumps({"devices":json.loads(Path("examples/devices.example.json").read_text()),"snapshot":json.loads(Path("examples/snapshot.example.json").read_text()),"dry_run":True}))' \
  > /tmp/smart-home-import.json
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/smart-home-import.json "$BASE/imports/tinytuya"
# После проверки для реального импорта замените dry_run на false.
rm /tmp/smart-home-import.json
```

## Ключи и данные

`local_key` — write-only поле: его можно создать, заменить через PATCH или очистить `null`. В обычных ответах, hierarchy, импорте и ошибках ключ не возвращается. Есть только `has_local_key`. Endpoint раскрытия ключа отсутствует. Gateway ключ используется для всех его children. Ключ должен содержать 16 печатных ASCII-символов. Исключения и сырые `Payload` TinyTuya не попадают в API-ответы; отладочное логирование TinyTuya не включено. IP — конкретный unicast IPv4, соответствующий LAN-транспорту TinyTuya; `0.0.0.0` не принимается, чтобы не запускать неявный discovery.

SQLite хранит ключи в открытом виде, поэтому файл базы создаётся с правами 0600. Используйте `umask 077` для запуска, импорта и резервных копий; не кладите реальную базу или TinyTuya JSON в Git. Примеры содержат только вымышленные реквизиты. Отдельное шифрование секретов и роли пользователей — возможное дальнейшее расширение. Для резервной копии остановите сервис и скопируйте базу или используйте штатный SQLite backup API. `create_all` создаёт начальную схему, но не выполняет миграции существующей схемы при будущих изменениях моделей.

## Orange Pi / OpenWrt

На Orange Pi с Debian/Armbian используйте Python из дистрибутива и обычное виртуальное окружение. Пример systemd: [`deploy/smart-home.service`](deploy/smart-home.service); создайте пользователя `smarthome`, каталог `/var/lib/smart-home` с его владельцем и правами 0700, положите проект/venv в `/opt/smart-home-service`. Токен можно задать в `/etc/smart-home-service.env` с правами 0600. После копирования unit запустите `systemctl daemon-reload` и `systemctl enable --now smart-home`. В примере bind остаётся `127.0.0.1`; для LAN измените его после настройки доступа.

На OpenWrt используйте внешний накопитель/extroot или достаточную flash, Python 3.10+ и пакеты под **вашу архитектуру и libc**. Имена/доступность пакетов зависят от версии OpenWrt. Pydantic 2 требует `pydantic-core` с нативным расширением; PyCryptodome также имеет нативную часть. В опубликованном TinyTuya дистрибутиве есть и зависимость `cryptography`; на архитектуре без готового пакета/колеса её сборка может требовать Rust. Поэтому этот FastAPI-проект нельзя обещать установить простым pip на любой MIPS-роутер с 16/32 MB flash. Бюджет RAM/flash на настоящем MT7628 здесь не измерялся. При дефиците flash нужна собственная сборка OpenWrt и/или облегчённый native daemon.

Пример procd: [`deploy/smart-home.init`](deploy/smart-home.init). Он использует системный `/usr/bin/python3`; зависимости должны быть доступны этому Python. Скопируйте проект в `/opt/smart-home-service`, script в `/etc/init.d/smart-home`, задайте права 0755. Необязательный `/etc/smart-home-service.conf` — shell-файл с правами 0600, например:

```sh
SMART_HOME_DB=/opt/smart-home-service/data/smarthome.db
SMART_HOME_API_TOKEN='replace-with-a-long-random-token'
SMART_HOME_BIND=127.0.0.1
SMART_HOME_PORT=8000
SMART_HOME_SERVICE_USER=root
```

Затем `/etc/init.d/smart-home enable` и `/etc/init.d/smart-home start`. При наличии отдельного service user задайте его и выдайте права только на каталог данных. Примеры systemd/procd включены для установки на целевое устройство; в этом окружении они не запускались.

## Проверки и дальнейшее расширение

```sh
python -m pip install -e '.[dev]'
python -m pytest -q
ruff check .
```

Тесты проверяют CRUD, hierarchy, ссылки и запрет удаления зависимостей, секреты, атомарный импорт/dry-run, Wi-Fi и gateway/cid, тайм-ауты, ACK без DPS, capability mapping и блокировку gateway. Отдельные проверки создают реальные объекты TinyTuya и проверяют child payload для 3.3/3.4/3.5 без сетевого соединения. Реальное оборудование не подключалось. Фактические результаты и версии окружения — в `VERIFICATION.md`.

Точки расширения: `tuya.py` — транспорт/receive loop, `service.py` — capability mapping и инварианты, `importer.py` — адаптер TinyTuya-файлов, `models.py` — хранилище. MQTT, расписания, сценарии, постоянный Zigbee event loop и multi-worker locks в первую версию не входят.

## Версионирование

Исходники хранятся в Git, основная ветка — `main`. Начальная версия отмечена тегом `v0.1.0`; изменения версий описаны в `CHANGELOG.md`. Базы данных, локальные настройки, реальные TinyTuya-файлы и виртуальные окружения исключены через `.gitignore`.

```sh
git status
git log --oneline --decorate
git show v0.1.0
```

Первый коммит создан от имени `Codex` с локальным техническим адресом `codex@localhost`. Перед своими коммитами задайте имя и email через `git config user.name` и `git config user.email`; глобальные настройки не менялись.

Git bundle содержит исходники, историю и теги и позволяет восстановить репозиторий без удалённого сервера:

```sh
git clone smart-home-service-v0.1.0.bundle smart-home-service
cd smart-home-service
git log --oneline --decorate
```

ZIP содержит исходники соответствующего тега без служебного каталога `.git`; для сохранения истории используйте bundle.
