# Бесплатный User Code + QR вход Tuya

На 2026-10-07 Tuya описывает Smart Life Integration как бесплатную для разработчиков, без необходимости создавать cloud development project и продлевать IoT Core resources: [официальный README Tuya](https://github.com/tuya/tuya-home-assistant/blob/main/README.md). [Официальная инструкция](https://developer.tuya.com/en/docs/iot/Smart_Life_Integration?id=Kd0gk9baikbb7) описывает User Code, сканирование QR и подтверждение в приложении. Это не гарантия неизменных тарифов/доступности и не подтверждение условий отдельного коммерческого продукта.

Сервис использует optional [tuya-device-sharing-sdk](https://github.com/tuya/tuya-device-sharing-sdk), версию 0.2.15, и локальный SVG-рендер QR. Опубликованный клиент `HA_3y9q4ak7g4ephrvke` / schema `haauthorize` взят как совместимый интеграционный режим из [HA const.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/tuya/const.py); [Tuya Local](https://github.com/make-all/tuya-local/blob/main/custom_components/tuya_local/const.py) использует тот же режим. Это публичный идентификатор приложения, не ваш секрет. В приложении Tuya разрешение может называться Home Assistant. Для собственного коммерческого клиента нужно получить подходящий client_id/schema и проверить условия у Tuya; сервис позволяет задать их переменными среды.

## Запуск

```sh
python -m pip install -e '.[cloud]'
# Или: python -m pip install -r requirements-cloud.txt
export SMART_HOME_CLOUD_ENABLED=1
export SMART_HOME_API_TOKEN='your-service-token'
export SMART_HOME_CLOUD_SESSION="$PWD/data/tuya-cloud.json"
python -m uvicorn smarthome.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Откройте `http://<server>:8000/cloud`. Введите API-ключ нашего сервиса и User Code из Smart Life/Tuya Smart → Я → настройки → аккаунт и безопасность. Нажмите «Получить QR-код», сканируйте код через приложение и подтвердите вход там. Затем нажмите «Я подтвердил вход в приложении». Пароль Tuya не запрашивается. QR живёт не более 120 секунд; протухший код нужно создать заново.

User Code находится внизу экрана «Аккаунт и безопасность». После успешного входа он сохраняется вместе с сеансом. После ввода ключа доступа страница проверяет наличие сохранённого кода: если он есть, поле скрыто и достаточно нажать «Получить QR-код», в том числе после перезапуска сервиса или истечения токена. Ссылка «Хочу изменить» открывает поле для ввода другого User Code; прежний сеанс заменяется только после успешного подтверждения. Подтвердить новый QR в приложении всё равно необходимо. До первого подтверждённого входа код хранится только в памяти ожидающего QR-сеанса.

QR не отправляется стороннему генератору изображений. User Code и token_info сохраняются на сервере в файле 0600, запись атомарная; обновлённые access/refresh tokens сохраняются для рестарта. Это обычный файл с секретами, а не шифрованное хранилище. API их не возвращает. Страница не сохраняет API-ключ в localStorage. Доступ к облачным endpoints требует настроенного API-ключа. По умолчанию cloud disabled и optional SDK не нужен для локального режима.

| Метод | Endpoint `/api/v1/cloud` | Результат |
|---|---|---|
| GET | `/status` | Enabled/connected и `has_saved_user_code`, без кода и токенов |
| POST | `/login/qr` | `{user_code:...}` или `{}` для сохранённого кода → session_id, URL локального QR |
| GET | `/login/{session_id}/qr.svg` | Авторизованное SVG, Cache-Control no-store |
| POST | `/login/{session_id}/confirm` | Завершить подтверждённый вход |
| DELETE | `/session` | Удалить только локальный сеанс |
| GET | `/devices?refresh=true` | Устройства/доступные функции, has_local_key, без ключа |
| GET | `/devices/{tuya_id}/status?refresh=true` | Облачный snapshot статуса по кодам |
| POST | `/devices/{tuya_id}/commands` | Команды `{commands:[{code:...,value:...}]}` |
| POST | `/imports/local-inventory` | Скопировать выбранную метаинформацию/ключи в локальный инвентарь |
| GET | `/scenes` | Список cloud scenes; редактор в бесплатном sharing SDK отсутствует |

`/session` не вызывает SDK unload с удалённым отзывом terminal, чтобы не затронуть общую авторизацию другой интеграции. Для удалённого отзыва используйте настройки разрешений Tuya. Сервис не извлекает токены уже установленного Home Assistant.

Удаление локального `/session` удаляет также сохранённый User Code. Значение кода не выдаётся API и не сохраняется в браузерном localStorage.

Пример повторного входа с уже сохранённым кодом:

```sh
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' 'http://127.0.0.1:8000/api/v1/cloud/login/qr'
```

## Импорт для локального режима

```sh
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"device_ids":["tuya_gateway_id","tuya_child_id"],"parent_map":{"tuya_child_id":"tuya_gateway_id"},"dry_run":true}' \
  'http://127.0.0.1:8000/api/v1/cloud/imports/local-inventory'
```

Выберите фактические ID из `/cloud/devices`; parent_map и node_id необходимы для child. Dry-run откатывает изменения. Для сохранения повторите с `dry_run:false`. Local_key попадает сразу в БД сервера и не выдаётся клиенту. WAN IP не переносится: принимаются только RFC1918 IPv4. Версия LAN-протокола не угадывается, прежние локальные IP/version/aliases сохраняются при отсутствии новых пригодных данных. После импорта настройте IP/version и сверенные capabilities обычным API.

Облачные команды используют **Tuya code**, локальные — числовые DPS. Это разные адреса управления; автоматического переключения транспорта нет, чтобы при неопределённом результате LAN-команды не выполнить её второй раз через облако. Cloud endpoint проверяет наличие code в writable function и тип/диапазон/enum, возвращает ACK отдельно от реального статуса. Облачный snapshot не гарантирует получение push для sleeping sensors — событийный мост пока не включён.

Проверены fake SDK login, QR, обновление токена, рестарт, отсутствие секретов в ответах, explicit gateway import и cloud ACK. Эти тесты отдельно проверяют поведение приложения и не подтверждают физическое выполнение команды.

## Реальный вход и метаданные — 2026-10-07

Владелец подтвердил QR через Smart Life, после чего локальный сервис прочитал метаданные через установленный `tuya-device-sharing-sdk==0.2.15`. Получен следующий снимок одного аккаунта:

| Данные | Результат |
|---|---|
| Устройства | 44 |
| Online в момент чтения | 22 |
| `has_local_key=true` | 42 |
| `support_local=true` | 42 |
| `sub=true` | 23 |
| Children с непустым `node_id` | 23 |
| Шлюзы без `local_key` | 2 из 2 показанных шлюзов |

Сервис вывел только признаки наличия ключа; значения ключей и токенов не включены в ответы, отчёт и Git. Проверка подтверждает выдачу доступных метаданных через Sharing SDK, а не совместимость всех устройств с TinyTuya или успешное выполнение LAN-команд. `sub=true` сам по себе не определяет Zigbee: у аккаунта есть и другие дочерние устройства.

Особенно важно отсутствие ключа у обоих шлюзов: ключ child не заменяет ключ родительского шлюза. Для локальных Zigbee-команд нужны реквизиты gateway и проверенный `cid`, поэтому этот вход пока не даёт полного локального управления children. Родители для импорта по-прежнему задаются явно через `parent_map`; LAN IP и версию протокола нужно подтвердить в сети.

После перезапуска сервиса подтверждённый сеанс сохранился, а страница `/cloud` обнаружила сохранённый User Code без заполнения его поля. Реальные устройства в SQLite-инвентарь не импортировались, команды и изменения сценариев не отправлялись.
