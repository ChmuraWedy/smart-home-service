# Smart Home Local REST API

Python RESTful-сервис для локального управления зданиями, комнатами, типами устройств и устройствами Tuya. Стек: FastAPI, синхронный SQLAlchemy 2, SQLite, TinyTuya и PyCryptodome с AES-GCM. Python 3.10+. Docker не требуется.

Web UI вынесен в отдельное **React + TypeScript + Vite** приложение: [frontend/README.md](frontend/README.md). API и интерфейс запускаются независимо; production-сборка — обычные статические файлы, Node.js на OpenWrt/Orange Pi для их раздачи не нужен.

В React устройства и группы находятся в едином списке: выбор здания/комнаты, поиск по имени/алиасу, питание, яркость, цвет, режимы и числовые настройки по capabilities. Одна карточка объединяет локальную запись и облачные источники по Tuya Device ID. Датчики показывают статус без кнопок записи; группа раскрывает участников для индивидуального управления. CRUD/импорт/настройка возможностей выполняются через REST API. [Подробности управления](frontend/README.md#управление-устройствами).

Добавлены [прошивка Yellow Display / CYD](firmware/cyd/README.md), [группы и выбор устройств](docs/displays.md), [необязательный User Code + QR вход](docs/qr-login.md), [разбор интеграций Home Assistant](docs/integrations.md) и [возможности редактирования сценариев Tuya](docs/scenes.md). Изменения разделены на локальные Git-коммиты.

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

Для отдельного интерфейса перед запуском API задайте `SMART_HOME_CORS_ORIGINS='http://127.0.0.1:5173,http://localhost:5173'`. Затем в другом терминале выполните `cd frontend`, `pnpm install --frozen-lockfile`, `pnpm dev` и откройте <http://127.0.0.1:5173>. Адрес API и его ключ сохраняются в «Настройках подключения». Прежний `/cloud` больше не раздаёт HTML: необязательный `SMART_HOME_FRONTEND_URL='http://127.0.0.1:5173'` включает перенаправление к отдельному UI.

Настройки из `.env.example` — справочный пример; файл `.env` автоматически не загружается. Переменные среды:

| Переменная | По умолчанию | Значение |
|---|---|---|
| `SMART_HOME_DB` | `./data/smarthome.db` | Путь к SQLite |
| `SMART_HOME_API_TOKEN` | пусто | Токен `X-API-Key` |
| `SMART_HOME_TUYA_TIMEOUT` | `3` | Тайм-аут операции с сокетом, секунды |
| `SMART_HOME_LOCK_TIMEOUT` | `5` | Ожидание занятого устройства/шлюза, секунды |
| `SMART_HOME_CORS_ORIGINS` | пусто | Origins отдельного UI через запятую, без путей и завершающего `/` |
| `SMART_HOME_FRONTEND_URL` | пусто | Адрес отдельного UI для 307 redirect с `/cloud` |

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

- `Building`: `name`, `address`, `description`, `aliases`.
- `Room`: `building_id`, `name`, `description`, `aliases`. Имена комнат уникальны внутри здания.
- `DeviceType`: уникальный `slug`, `name`, `description`, карта `capabilities`.
- `Device`: `name`, `description`, `aliases`, `device_type_id`, `building_id`, `room_id`, `device_id`, `local_key`, `ip`, `version`, `transport`, `is_gateway`, `parent_id`, `cid`/`node_id`, `enabled`, `product_id`, `category`, `mac`, карта `capabilities`.
- `device_id` — строковый идентификатор Tuya. `id` и `parent_id` в API — числовые идентификаторы SQLite, это разные поля.
- `Gateway` представлен устройством с `is_gateway=true`, `transport=wifi`. Список шлюзов: `GET /api/v1/devices?is_gateway=true`.
- `cid` — адрес дочернего узла, **не** его Tuya `device_id`. `node_id` — входной алиас `cid`; в ответе оба поля содержат одно значение. Пара `(parent_id, cid)` уникальна.
- При задании `room_id` здание выводится из комнаты. Если одновременно передать другое `building_id`, API вернёт 422. Смена комнаты без явного здания переносит устройство в здание новой комнаты. `room_id:null` убирает комнату и оставляет здание; для полного отвязывания передайте также `building_id:null`.
- Child и gateway могут находиться в разных комнатах, но при известных зданиях должны принадлежать одному зданию. Поддерживается один уровень шлюза; циклы и вложенные шлюзы отклоняются.
- Удаление объектов с зависимостями возвращает 409. Удаление здания не удаляет автоматически комнаты и устройства. Gateway нельзя удалить или лишить роли шлюза, пока у него есть children.

Обновления делаются через `PATCH`: не переданные поля сохраняются, `null` очищает только nullable-поля. Карта `capabilities` при PATCH заменяется целиком на соответствующем уровне.

## Поиск по названию

Названия `name`, заданные при создании, используются для поиска зданий, комнат, типов и устройств:

- `GET /api/v1/devices?q=розетка` — часть названия; тот же `q` есть у `buildings`, `rooms`, `device-types`.
- `GET /api/v1/devices?name=Розетка` — точное название; возвращает список всех совпадений.
- `GET /api/v1/lookup/devices?name=Розетка&room_id=1` — получить один объект по точному названию с уточнением комнаты. Аналогичные `/lookup/buildings`, `/lookup/rooms`, `/lookup/device-types`.
- `GET /api/v1/devices/name:Розетка/status` и `POST /api/v1/devices/name:Розетка/commands/on` — обращение и управление по точному названию. Префикс `name:` работает также у зданий и комнат во всех существующих адресах, включая hierarchy, PATCH и DELETE.

Поиск Unicode-aware: кириллица, регистр и составная запись Unicode учитываются корректно; пробелы по краям сравниваемых названий игнорируются. В `q` символы `%`, `_`, кавычки и обратный слеш — обычный текст. Поиск выполняется по `name`, алиасы для него задаются отдельно через `alias`. Можно сочетать `q`/`name` с существующими фильтрами расположения, типа, parent и алиаса. Если передать одновременно `q` и `name`, должны выполняться оба условия. Пагинация применяется после фильтрации.

Названия не становятся глобально уникальными. Списковый поиск возвращает все совпадения. Обращение `name:...` и `/lookup/...` требуют ровно одного совпадения: 404 — ни одного, 409 — несколько. В 409 есть безопасный список до 20 вариантов (`id`, `name`, доступные ссылки на здание/комнату/parent/тип) и `more_matches`; локальные ключи туда не включаются. При неоднозначном названии команды не отправляются и изменения не выполняются.

Уточнения `/lookup/devices`: `building_id`, `room_id`, `parent_id`, `device_type_id`. Для `/lookup/rooms` доступен `building_id`; здания и типы не имеют этих уточнений. Неподдерживаемое уточнение возвращает 422. Для управления двумя одноимёнными устройствами найдите нужное через `/lookup/devices?name=...&room_id=...`, затем используйте его `id` или алиас. Типы устройств можно искать по названию, их собственные адреса остаются по числовому ID.

Названия в пути нужно URL-кодировать, особенно пробелы и кириллицу. Названия со слешем `/` ищите через query-параметр `/lookup/...`: они не помещаются в один сегмент пути. Явный префикс `name:` также позволяет отличить числовое название от ID, а название, совпавшее с чужим пользовательским алиасом, — искать только по имени. Обычный поиск по алиасу в таком случае вернёт 409. Назначать дополнительный алиас для поиска по `name` не нужно.

```sh
export BASE=http://127.0.0.1:8000/api/v1
export TOKEN='replace-with-a-long-random-token'
curl -sS -G -H "X-API-Key: $TOKEN" \
  --data-urlencode 'q=розетка' "$BASE/devices"
curl -sS -G -H "X-API-Key: $TOKEN" \
  --data-urlencode 'name=Розетка' --data-urlencode 'room_id=1' "$BASE/lookup/devices"
curl -sS -G -H "X-API-Key: $TOKEN" \
  --data-urlencode 'q=кухня' "$BASE/rooms"

# Управление по уникальному точному названию без отдельного алиаса:
DEVICE_NAME_PATH=$(python -c 'from urllib.parse import quote; print(quote("name:Свет кухня", safe=""))')
curl -sS -H "X-API-Key: $TOKEN" "$BASE/devices/$DEVICE_NAME_PATH/status"
curl -sS -X POST -H "X-API-Key: $TOKEN" "$BASE/devices/$DEVICE_NAME_PATH/commands/on"
```

Версия v0.3.0 не меняет таблицы или данные базы: Unicode-функция поиска регистрируется на SQLite-соединении при запуске. Дополнительных внешних библиотек не требуется.

## Алиасы зданий, комнат и устройств

Каждый Building, Room и Device имеет автоматический алиас — текущее `name` — и может иметь до 32 дополнительных алиасов, например `home`, `kitchen`, `kitchen_light`, `first-floor.lamp`. Алиасы передаются массивом `aliases` при создании или PATCH. Массив заменяется целиком; отсутствие поля сохраняет алиасы, `[]` очищает дополнительные алиасы, `null` отклоняется. В ответах `aliases` начинается с текущего имени в исходном регистре, затем идут отсортированные дополнительные алиасы. Массив из ответа можно передать обратно: имя распознаётся и не занимает лимит. При переименовании автоматический алиас обновляется; его нельзя удалить отдельно.

Дополнительные алиасы приводятся к нижнему регистру, пробелы по краям убираются. После нормализации допускается 1–64 символа: первая латинская буква `a-z`, далее `a-z`, цифры, `_`, `-`, `.`. Чисто числовые алиасы запрещены, поэтому они не конфликтуют с числовыми ID. Дубли внутри массива возвращают 422; занятый алиас — 409 без частичного изменения объекта.

Уникальность действует **в пределах типа сущности во всём сервисе**. У двух комнат даже в разных зданиях не может быть одинакового алиаса; используйте, например, `home.kitchen` и `office.kitchen`. Здание, комната и устройство могут использовать один и тот же алиас: их адреса различаются префиксом ресурса. DeviceType продолжает использовать числовой ID и свой `slug`.

Во всех адресах `buildings/{id}`, `rooms/{id}`, `devices/{id}`, включая hierarchy, children, status и команды, вместо ID можно передать алиас или явное точное название с префиксом `name:`. Числовые ссылки в JSON (`building_id`, `room_id`, `parent_id`) и существующие фильтры по ID остаются числовыми. Списки поддерживают дополнительный точный фильтр `?alias=...`; неизвестный алиас в адресе возвращает 404, а в фильтре — пустой список.

Отдельный endpoint поиска: `GET /api/v1/lookup/{resource}/alias?alias=...` для buildings, rooms, devices. Он ищет и дополнительные алиасы, и текущее имя, включая кириллицу/пробелы/слеши/числовые имена. Те же уточнения расположения, что у поиска по имени. Неоднозначность имени либо совпадение имени с чужим алиасом возвращает 409; выбор устройства не угадывается. Фильтр списка `?alias=...` возвращает все совпадения.

```sh
curl -sS -G -H "X-API-Key: $TOKEN" --data-urlencode 'alias=Лампа' \
  --data-urlencode 'room_id=1' "$BASE/lookup/devices/alias"
```

Для каждого из ресурсов `buildings`, `rooms`, `devices` также доступны:

| Метод | Путь | Результат |
|---|---|---|
| GET | `/{resource}/{id_or_alias}/aliases` | Массив алиасов |
| POST | `/{resource}/{id_or_alias}/aliases` | Добавить один: `{"alias":"..."}`, 201 и обновлённый объект |
| DELETE | `/{resource}/{id_or_alias}/aliases/{alias}` | Удалить один, 204 |

При удалении объекта освобождаются его алиасы. Алиасы не обходят проверки зависимостей, авторизацию или правила Zigbee. В TinyTuya передаётся исходный Tuya `device_id`, а child по-прежнему использует настоящий parent + cid.

```sh
export BASE=http://127.0.0.1:8000/api/v1
export TOKEN='replace-with-a-long-random-token'
# Здесь 1 и 3 — существующие числовые ID из вашего инвентаря.
curl -sS -X PATCH -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"aliases":["home"]}' "$BASE/buildings/1"
curl -sS -X PATCH -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"aliases":["kitchen"]}' "$BASE/rooms/1"
curl -sS -X PATCH -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"aliases":["kitchen_light","main_lamp"]}' "$BASE/devices/3"

curl -sS -H "X-API-Key: $TOKEN" "$BASE/buildings/home/hierarchy"
curl -sS -H "X-API-Key: $TOKEN" "$BASE/rooms/kitchen/devices"
curl -sS -H "X-API-Key: $TOKEN" "$BASE/devices?alias=kitchen_light"
curl -sS -H "X-API-Key: $TOKEN" "$BASE/devices/kitchen_light/status"
curl -sS -X POST -H "X-API-Key: $TOKEN" "$BASE/devices/kitchen_light/commands/on"
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"alias":"evening_light"}' "$BASE/devices/kitchen_light/aliases"
curl -sS -X DELETE -H "X-API-Key: $TOKEN" "$BASE/devices/kitchen_light/aliases/evening_light"
```

Обновление базы с v0.1.0 не требует экспорта/повторного импорта: при старте автоматически создаются только три новые таблицы алиасов, существующие таблицы и ключи сохраняются. После обновления у старых объектов `aliases:[name]`; отдельной записи имени в БД не требуется. Перед обновлением рабочей установки сделайте штатную резервную копию базы.

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

Фильтры устройств: `building_id`, `room_id`, `device_type_id`, `parent_id`, `is_gateway`, `transport=wifi|zigbee`, `unassigned=true` (нет ни комнаты, ни здания), `alias`, `name`, `q`. Фильтры комнат: `building_id`, `alias`, `name`, `q`; зданий — `alias`, `name`, `q`; типов — `name`, `q`. Вложенные списки и hierarchy возвращаются целиком; для большого инвентаря используйте списковые API с пагинацией.

Ошибки: 401 — токен, 404 — объект отсутствует, 409 — конфликт/нет нужной конфигурации, 422 — неверные поля/связи/значения capability, 502 — ошибка Tuya/непригодный ответ, 503 — занят gateway или БД, 504 — нет ответа/тайм-аут. Ошибки валидации возвращают путь поля и тип ошибки без исходного значения.

## Структура дома из Smart Life

На странице управления нажмите **«Синхронизировать Smart Life»** после QR-входа. Home становится Building, Room — Room, расположение устройства сопоставляется по Tuya Device ID. Облачные карточки участвуют в фильтре комнат ещё до локальной регистрации; мастер добавления подставляет здание и комнату. Access ID/Secret для этого пути не требуются.

Синхронизация выполняется в фоне с прогрессом. Результат хранится в SQLite; обычное открытие страницы читает кеш без запросов комнат в облако. Повторная синхронизация использует Tuya ID, сохраняет ручные имена, алиасы и размещение. Автоматически размещённые локальные устройства следуют изменениям в Smart Life, пока пользователь не изменил их расположение вручную. Ограничения групп/панелей и gateway/child сохраняются; пропущенные перемещения учитываются в предупреждениях. Локальные Device не создаются до регистрации, IP/ключи/capabilities синхронизация не меняет.

Защищённые API:

```sh
API=http://127.0.0.1:8000
KEY="$SMART_HOME_API_TOKEN"
# Неблокирующий запуск; повторный запрос при работающей задаче возвращает её прогресс.
curl -X POST "$API/api/v1/cloud/topology/sync" -H "X-API-Key: $KEY"
# Кеш структуры + job.status (idle/running/done/failed), processed/total, warnings.
curl "$API/api/v1/cloud/topology" -H "X-API-Key: $KEY"
```

При ошибке облака или смене аккаунта прежний снимок остаётся целым. Кеш и задачи разделены по аккаунтам. Перезапуск завершает фоновую задачу; сохранённая структура остаётся. Новые таблицы создаются автоматически, перед обновлением сделайте резервную копию SQLite. Используйте один worker; предел — 2000 устройств/100 домов и 5 минут на одну синхронизацию.

Текущий [Tuya Sharing SDK](https://github.com/tuya/tuya-device-sharing-sdk/blob/main/tuya_sharing/home.py) возвращает список домов и комнату **по устройству**, поэтому пустые комнаты впервые обнаружить нельзя. Известные комнаты и здания не удаляются при исчезновении устройства или дома из облака. Разные комнаты с одинаковым названием получают различающий суффикс. Это чтение структуры Smart Life: группы Zigbee, remote/multi-control и изменения структуры обратно в Smart Life сюда не входят.

Перенос кода и продолжение работы на Mac mini: [docs/mac-mini.md](docs/mac-mini.md).

## Опрос устройства перед регистрацией

В React есть **«Добавить в дом»** (облачная карточка) и **«Добавить устройство»** (ручной ввод). До сохранения открывается страница настройки и наблюдения: пользователь сам переключает устройство, сервис только читает значения. [Подробности и ограничения](frontend/README.md#опрос-перед-добавлением).

API под тем же `X-API-Key`:

- `POST /api/v1/commissioning` — `{draft: DeviceCreate, mode: "local"|"cloud", provider: "sharing"|"developer"|null}`. Если указан provider, метаданные и отсутствующий local_key берутся на сервере из выбранного аккаунта. Никакой Device пока не создаётся. Переданные capabilities должны быть пустыми.
- `POST /api/v1/commissioning/{session_id}/samples` — `{action: "observe"|"power"|"brightness"|"temperature"|"color"|"sensor"|"button"}`. Только status; выбор действия не отправляет команду. Возвращает `readings`, `changes`, `sample_count`, срок и интервал. Поле `can_write` означает проверенный номер/формат, не разрешение управления по умолчанию.
- `POST /api/v1/commissioning/{session_id}/register` — название, aliases, building_id/room_id, `reviewed: true`, необязательный список ключей параметров `writable`. Требует хотя бы одной успешной выборки с показаниями; неизвестные или неоднозначные DP нельзя включить для записи. После сохранения сессия закрывается.
- `DELETE /api/v1/commissioning/{session_id}` — отменить без сохранения.

Сессии в памяти ограничены 15 минутами, 16 одновременными, 64 параметрами и 100 изменениями; используйте один worker. Частые выборки получают 429, истёкшие сессии — 404. Смена выбранного аккаунта блокирует чтение и регистрацию старой сессии. Для Zigbee локальный опрос и регистрация требуют существующего direct Wi-Fi gateway + cid; root IP/key/version берутся из шлюза. Local_key не возвращается. Локальные показатели сохраняются с фактическим временем чтения; облачные значения не заполняют локальный кеш/capabilities. История изменений остаётся временной. Этот этап обязателен для нового UI-пути, существующие REST CRUD/import сохраняют совместимость.

Пример для подключённого аккаунта и Wi-Fi лампы (идентификаторы/адрес замените своими; ключ из аккаунта остаётся на сервере):

```sh
export BASE=http://127.0.0.1:8000/api/v1
export TOKEN='replace-with-a-long-random-token'
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"draft":{"name":"Новая лампа","device_id":"your-device-id","ip":"192.168.1.40","version":"3.5"},"mode":"local","provider":"sharing"}' \
  "$BASE/commissioning"
# Возьмите session_id из ответа. Первый status — исходная выборка.
export OBSERVATION='session-id-from-response'
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"observe"}' "$BASE/commissioning/$OBSERVATION/samples"
# Переключите лампу вручную; между запросами ждите минимум 3 секунды.
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"power"}' "$BASE/commissioning/$OBSERVATION/samples"
# После просмотра результатов сохраните. Без writable всё будет только для чтения.
curl -sS -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Новая лампа","aliases":["new_lamp"],"reviewed":true,"writable":[]}' \
  "$BASE/commissioning/$OBSERVATION/register"
```

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

Для наблюдения за переподключением есть отдельный `python tools/capture_tuya.py --seconds 900`: приватная запись исходных UDP-пакетов, декодирование discovery и список IP/версий без опроса и управления. Запуск, остановка и ограничения: [docs/packet-capture.md](docs/packet-capture.md).

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

Записи объединяются по Tuya device ID. Snapshot дополняет/обновляет IP, версию и доступные реквизиты. Пустые поля не стирают существующие реквизиты. В snapshot могут отсутствовать children; они сохраняются из devices.json. Дополнительное поле `aliases` импортируется для устройств: отсутствие сохраняет текущие алиасы, `[]` очищает. Конфликт алиасов откатывает весь импорт. `data`, DPS snapshot и произвольные raw/cloud поля не импортируются: старый снимок не считается текущим статусом. Capabilities настраиваются отдельно после импорта. См. [формат snapshot TinyTuya](https://github.com/jasonacox/tinytuya/blob/master/tinytuya/scanner.py) и [parent-поля wizard](https://github.com/jasonacox/tinytuya/blob/master/tinytuya/wizard.py).

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

SQLite хранит ключи в открытом виде, поэтому файл базы создаётся с правами 0600. Используйте `umask 077` для запуска, импорта и резервных копий; не кладите реальную базу или TinyTuya JSON в Git. Примеры содержат только вымышленные реквизиты. Отдельное шифрование секретов и роли пользователей — возможное дальнейшее расширение. Для резервной копии остановите сервис и скопируйте базу или используйте штатный SQLite backup API. `create_all` создаёт начальную схему и новые таблицы алиасов для обновления v0.1.0 → v0.2.0; изменение колонок в будущих версиях потребует отдельной миграции.

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

Тесты проверяют CRUD, hierarchy, ссылки и запрет удаления зависимостей, секреты, атомарный импорт/dry-run, Wi-Fi и gateway/cid, тайм-ауты, ACK без DPS, capability mapping и блокировку gateway. Для алиасов проверяются CRUD/поиск/команды, уникальность и откат конфликтов, удаление и повторное использование, импорт, авторизация и обновление существующей базы. Отдельные проверки создают реальные объекты TinyTuya и проверяют child payload для 3.3/3.4/3.5 без сетевого соединения. Реальное оборудование не подключалось. Фактические результаты и версии окружения — в `VERIFICATION.md`.

Точки расширения: `tuya.py` — транспорт/receive loop, `service.py` — capability mapping и инварианты, `importer.py` — адаптер TinyTuya-файлов, `models.py` — хранилище. MQTT, расписания, сценарии, постоянный Zigbee event loop и multi-worker locks в первую версию не входят.

## Версионирование

Исходники хранятся в Git, основная ветка — `main`. Начальная версия отмечена тегом `v0.1.0`, поддержка алиасов — `v0.2.0`, поиск по названию — `v0.3.0`; изменения версий описаны в `CHANGELOG.md`. Базы данных, локальные настройки, реальные TinyTuya-файлы и виртуальные окружения исключены через `.gitignore`.

```sh
git status
git log --oneline --decorate
git show v0.3.0
```

Первый коммит создан от имени `Codex` с локальным техническим адресом `codex@localhost`. Перед своими коммитами задайте имя и email через `git config user.name` и `git config user.email`; глобальные настройки не менялись.

Git bundle содержит исходники, историю и теги и позволяет восстановить репозиторий без удалённого сервера:

```sh
git clone smart-home-service-v0.3.0.bundle smart-home-service
cd smart-home-service
git log --oneline --decorate
```

ZIP содержит исходники соответствующего тега без служебного каталога `.git`; для сохранения истории используйте bundle.

## Профили и нормализованное управление

Сравнение LocalTuya, Tuya Local и официальной Tuya, реализованные категории и границы совместимости: [docs/integrations.md](docs/integrations.md).

```sh
# Явно выбранный профиль; DPS нужно сверить с вашим устройством.
curl -sS -H "X-API-Key: $TOKEN" "$BASE/profiles/bulb-v2"
curl -sS -H "X-API-Key: $TOKEN" "$BASE/devices/kitchen_light/state?refresh=true"
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"values":{"switch":true,"color":{"h":120,"s":1000,"v":500}}}' \
  "$BASE/devices/kitchen_light/commands/capabilities"
# Белый режим и цветовая температура:
curl -sS -X PUT -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":4600}' "$BASE/devices/kitchen_light/capabilities/color_temperature"
```

Новые capability поля: `read_dp`, `scale`, `offset`, `invert`, `raw_type`, `step`, `value_map`, `write_dps`; color encodings `tuya_hsv`, `tuya_rgbhsv`, `tuya_hsv_json`. Определения без этих полей сохраняют прежнюю семантику. На старте автоматически создаётся таблица наблюдений; каждая температура/влажность/статус имеет собственное время, ACK не обновляет показания.

## Панели комнат и группы

[docs/displays.md](docs/displays.md): выбор комнаты и произвольного списка устройств/групп для отображения, сохранение конфигурации каждой панели, CRUD групп устройств с общим питанием, компактный dashboard, фоновое получение показаний и curl-примеры. Главный экран формируется из выбранного списка, показания и управление определяются capabilities. `SMART_HOME_DISPLAY_POLL_INTERVAL=30` задаёт период опроса выбранных устройств; `0` — только явный refresh.

## Вход Tuya по QR

Optional бесплатный Sharing SDK режим: [docs/qr-login.md](docs/qr-login.md). После включения cloud extra и `SMART_HOME_CLOUD_ENABLED=1` откройте отдельный [React UI](frontend/README.md): при первом подключении браузера сохраните адрес API и ключ в «Настройках подключения», затем User Code → QR → подтверждение в приложении. Ключ автоматически используется через скрытое поле; User Code и токены остаются на сервере. Сохранённый User Code скрыт за ссылкой «Хочу изменить». Токены и local_key остаются на сервере. Облачные команды и импорт метаданных доступны через REST API.

Sharing получает отчёты открытых устройств через официальный MQTT SDK. React читает кеш сервиса каждые три секунды, пока форма управления видима; ручное обновление делает один HTTP-запрос выбранного устройства. Последние отчёты сохраняются в SQLite и не затираются старым HTTP-снимком. Время и источник показания видны в форме. Подробнее: [обновление статусов](docs/status-updates.md).

Второй способ на той же странице — **Access ID / Secret** проекта Tuya: выберите регион, отдельно сохраните реквизиты и нажмите «Проверить и подключить». Он работает с обычным `requirements.txt` при `SMART_HOME_CLOUD_ENABLED=1`, независимо от QR-сеанса. Сохранённые поля скрываются за «Хочу изменить», секреты остаются на сервере. Устройства, статус, функции, команды и импорт доступны с `provider=developer`; без него используется Sharing. Настройка проекта и curl-примеры: [docs/developer-login.md](docs/developer-login.md).

Проверка публичного Smart Life Web после реального входа: [docs/smart-life-web.md](docs/smart-life-web.md). Подтверждены доступ к списку/комнатам и связям шлюзов с дочерними устройствами; выдача `local_key` и `cid` веб-API пока не подтверждена.

Полное объявленное управление лампами, команды светомузыки/переходов, стандартные Raw-расписания v0, память питания и сохранение ручных связей с ID/code/DP обеих сторон описаны в [docs/device-linkage.md](docs/device-linkage.md). Сопоставления `remote`/`zigbee_group`/`multi_control` хранятся в SQLite и не применяют привязки в Smart Life; чтение существующих привязок через Sharing пока недоступно.


## Видео камер

Настройки камеры сгруппированы по изображению, обнаружению и записи; названия и стандартные режимы переведены. [Сравнение с референсом Smart Life и границы поддержки](docs/camera-controls.md).

На главной карточке камеры доступны приватность, обнаружение движения, обнаружение звука и сирена, если API устройства объявляет эти переключатели доступными для управления. Изменения отправляются сразу, без «Применить». В подробном плеере показываются разрешение HD/SD, состояние воспроизведения, скорость загрузки последнего видеосегмента и доступное показание Wi-Fi. Выбор качества использует реальные варианты HLS; если вариант один, переключение недоступно. Sharing не предоставляет отдельную команду HD/SD или отдельный запрос Wi-Fi. «Нет данных» не заменяется предполагаемыми процентами сигнала.

Камеры Tuya категорий `sp` и `dghsxj` получают значок камеры и кнопку «Видео» на главной плитке. Кнопка «Видео» раскрывает небольшой прямой эфир внутри главной плитки; сворачивание останавливает его. При открытии подробной карточки просмотр на плитке останавливается. В подробной карточке «Смотреть видео» запускает HLS-плеер; «Остановить», закрытие карточки и скрытие вкладки прекращают загрузку видео. Совместимые браузеры используют лениво загружаемый hls.js; при отсутствии MediaSource используется встроенный HLS. Звук изначально выключен, его можно включить в плеере. Микрофон и запись видео не используются.

`POST /api/v1/cloud/devices/{device_id}/stream?provider=sharing|developer` проверяет принадлежность устройства текущему аккаунту и категорию камеры, затем запрашивает временный HTTPS-адрес HLS только у выбранного подключения. Ответ защищён обычным ключом API и `Cache-Control: no-store`; адрес не сохраняется в БД. При истечении адреса или ошибке воспроизведения пользователь запускает подключение заново. Для Developer нужны соответствующие права сервиса видео Tuya.

Sharing использует `Manager.get_device_stream_allocate`, Developer — [официальный метод выдачи видеопотока](https://developer.tuya.com/en/docs/cloud/2ccd66883c?id=Kam7q5a9ug8b1). В приложении проверено воспроизведение Sleep Cam (640×360); HTTPS HLS-манифест доступен с CORS для браузера.
