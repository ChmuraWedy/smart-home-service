# Access ID / Access Secret

Второй способ авторизации работает независимо от QR-сеанса. На `/cloud` выберите **Access ID / Secret**, введите реквизиты проекта Tuya и его дата-центр, нажмите **Сохранить реквизиты**, затем **Проверить и подключить**. После успешной проверки доступен список устройств.

Access ID / Client ID и Access Secret / Client Secret находятся в Overview облачного проекта на [Tuya Developer Platform](https://iot.tuya.com/). Привяжите Smart Life через Devices → Link Tuya App Account и авторизуйте необходимые API IoT Core и авторизации. Доступ зависит от разрешений и действующего плана проекта; сервис не создаёт проект и не покупает подписку. [Инструкция TinyTuya Wizard](https://github.com/jasonacox/tinytuya#setup-wizard---getting-local-keys).

Для запуска достаточно обычного `requirements.txt`, `SMART_HOME_CLOUD_ENABLED=1` и непустого `SMART_HOME_API_TOKEN`. QR-входу по-прежнему нужен extra `.[cloud]`. Developer-клиент использует стандартную библиотеку Python и [официальную подпись HMAC-SHA256](https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g), без нового SDK.

Поддерживаются `eu`, `eu-w`, `us`, `us-e`, `cn`, `in`, `sg`. Выбирайте регион проекта, а не местоположение сервера. Необязательный Device ID позволяет получить UID устройства и список его аккаунта. Без Device ID используется постраничный список устройств привязанных аккаунтов проекта. Если проект ограничивает этот API, попробуйте Device ID устройства, уже видимого в проекте. Используются [список связанных устройств](https://developer.tuya.com/en/docs/archived-documents/fc19523d18?id=Kakr4p8nq5xsc) и [устройства аккаунта](https://developer.tuya.com/en/docs/cloud/device-management?id=K9g6rfntdz78a).

Сохранение не обращается к Tuya. Поля очищаются и скрываются за **Хочу изменить**; для замены повторно введите всю пару, **Отменить изменение** возвращает прежнее состояние. Пустой Device ID очищает старое ограничение аккаунта. Успешная замена сбрасывает только Developer-подключение и кэш; ошибка записи сохраняет прежнее состояние.

Реквизиты сохраняются атомарно в JSON-файле `0600`, по умолчанию `<путь QR-сеанса>.developer.json`. Переменная `SMART_HOME_DEVELOPER_SESSION` меняет путь; он должен отличаться от `SMART_HOME_CLOUD_SESSION`. Стандартный каталог `data/` исключён из Git, другой путь нужно исключить самостоятельно. Файл содержит секреты без шифрования. Access ID/Secret не выдаются API, не подставляются в форму и не записываются в браузерное хранилище.

Токен хранится только в памяти и получается заново перед запросом после истечения срока. После перезапуска реквизиты восстановятся; нажмите **Проверить и подключить**. `connected` означает успешную проверку в текущем процессе. Таймаут — `SMART_HOME_CLOUD_TIMEOUT`, по умолчанию 10 секунд, допустимо >0 и ≤30. HTTPS-адреса фиксированы, TLS проверяется, перенаправления запрещены. Ошибки не раскрывают исходные ответы/секреты. Команды автоматически не повторяются.

Все endpoints защищены `X-API-Key`:

| Метод | Endpoint `/api/v1/cloud` | Назначение |
|---|---|---|
| GET | `/developer/status` | configured/connected, регион и признак Device ID; без реквизитов |
| PUT | `/developer/credentials` | Сохранить `{access_id,access_secret,region,sample_device_id?}` без сети |
| POST | `/developer/connect` | Получить токен, проверить список, вернуть число устройств |
| DELETE | `/developer/credentials` | Удалить локальные реквизиты/кэш, без отзыва разрешений проекта |
| GET | `/devices?provider=developer&refresh=true` | Метаданные и has_local_key, без ключей |
| GET | `/devices/{id}/status?provider=developer` | Прочитать статус по Tuya code |
| GET | `/devices/{id}/functions?provider=developer` | Writable functions и допустимые значения |
| POST | `/devices/{id}/commands?provider=developer` | Проверить команды и отправить один запрос |
| POST | `/imports/local-inventory?provider=developer` | Импорт выбранных устройств/ключей в SQLite |

Без `provider` используется Sharing. В `/status` добавлено отдельное поле `developer`; прежнее `connected` относится к QR-сеансу. Developer-список не загружает функции каждого устройства: они читаются отдельно и перед командой. Developer-сценарии пока не реализованы (`scenes?provider=developer` → `501`); Sharing-список сохраняется. Удаление реквизитов не удаляет импортированные устройства из SQLite.

Примеры с демонстрационными реквизитами:

```sh
curl -sS -X PUT -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"access_id":"example-id","access_secret":"example-secret","region":"eu","sample_device_id":null}' \
  'http://127.0.0.1:8000/api/v1/cloud/developer/credentials'
curl -sS -X POST -H "X-API-Key: $TOKEN" \
  'http://127.0.0.1:8000/api/v1/cloud/developer/connect'
curl -sS -H "X-API-Key: $TOKEN" \
  'http://127.0.0.1:8000/api/v1/cloud/devices?provider=developer&refresh=true'
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"device_ids":["gateway-id","child-id"],"parent_map":{"child-id":"gateway-id"},"dry_run":true}' \
  'http://127.0.0.1:8000/api/v1/cloud/imports/local-inventory?provider=developer'
curl -sS -H "X-API-Key: $TOKEN" \
  'http://127.0.0.1:8000/api/v1/cloud/devices/device-id/status?provider=developer'
curl -sS -H "X-API-Key: $TOKEN" \
  'http://127.0.0.1:8000/api/v1/cloud/devices/device-id/functions?provider=developer'
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"commands":[{"code":"switch_led","value":true}]}' \
  'http://127.0.0.1:8000/api/v1/cloud/devices/device-id/commands?provider=developer'
```

Импорт использует `gateway_id`, если Tuya его возвращает; явный `parent_map` имеет приоритет. Child требует настоящий node_id/cid и родителя в импорте или инвентаре. Связи по совпадению ключей не угадываются. Ключ попадает только в SQLite, WAN IP отбрасывается, прежние LAN IP/version/aliases сохраняются. Для записи повторите с `dry_run:false`, затем настройте IP/version/capabilities. Версия протокола не угадывается.

`switch_led` — пример, он должен присутствовать в functions вашего устройства. ACK означает принятие запроса Tuya; статус проверяется отдельно. Локальные команды TinyTuya используют прежние числовые DPS, прямой Wi-Fi или parent gateway + cid. Автоматического переключения между Developer, Sharing и LAN нет. Реальный Developer-вход требует действующего проекта: fake API тесты не подтверждают доступ к вашему проекту.
