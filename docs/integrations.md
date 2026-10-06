# Сравнение Tuya-интеграций и совместимость

Проверено 2026-10-07. LocalTuya: `59c95cd06c2696afc98f6bc52d5fa060f3c517da`; Tuya Local: `908c133d110a80d9b8dca7da76d55b9017aa62cf`. Источники используются для исследования; файлы интеграций и их каталоги не скопированы в проект.

| Интеграция | Транспорт и настройка | Что берём в сервис |
|---|---|---|
| [LocalTuya](https://github.com/rospogrigio/localtuya) | LAN, вручную выбранные DPS; push статуса, optional cloud для ключей | Каналы реле, яркость с диапазонами, инверсия штор, scaling температур, enum режимы |
| [Tuya Local](https://github.com/make-all/tuya-local) | TinyTuya, каталог конфигураций конкретных продуктов; optional QR cloud для настройки | Явные профили, read-only датчики, подмена значений, отдельные DPS записи/обратной связи, gateway + node_id |
| [Официальная Tuya](https://www.home-assistant.io/integrations/tuya/) | Облако, User Code + QR; `tuya-device-sharing-sdk` | Сравнение возможностей и отдельный optional cloud adapter; не обязательная зависимость локального управления |

Платформы LocalTuya в [const.py](https://github.com/rospogrigio/localtuya/blob/59c95cd06c2696afc98f6bc52d5fa060f3c517da/custom_components/localtuya/const.py): binary_sensor, climate, cover, fan, light, number, select, sensor, switch, vacuum. Tuya Local дополнительно содержит платформы humidifier, water_heater, remote/infrared, lock, button, siren, valve и другие; наличие платформы не означает поддержку каждого товара.

Официальная интеграция зависит от функций, раскрываемых SDK; `status`, `status_range`, `function` могут оказаться пустыми. Это ограничение описано в [официальной документации HA](https://www.home-assistant.io/integrations/tuya/). Её облачный токен и локальный ключ устройства — разные данные. [Manifest](https://github.com/home-assistant/core/blob/dev/homeassistant/components/tuya/manifest.json) указывает `cloud_push`; [config_flow](https://github.com/home-assistant/core/blob/dev/homeassistant/components/tuya/config_flow.py) сохраняет access/refresh tokens после сканирования QR.

## Реализованные варианты

| Вариант | Поддержка / тест |
|---|---|
| Реле, розетка, многоканальный выключатель | boolean `switch` или `switch_1..3`; единый DPS пакет нескольких каналов |
| Dimmer | Числовая яркость с масштабом и допустимым диапазоном |
| RGBCCT v1/v2/JSON | RGB+HSV8, HSV16, JSON HSV; режим `colour` отправляется вместе с цветом, `white` — вместе с белой яркостью/цветовой температурой |
| Шторы | open/close/stop, инверсия позиции; `read_dp` для отдельного feedback DPS |
| Вентилятор | Enum скорости, oscillation, питание |
| Термостат | Температура с scale/offset/step, питание, enum режимы |
| Температура/влажность/движение/presence | Нормализованное чтение и read-only capabilities; неизвестное показание не превращается в false/0 |
| Энергомониторинг | Отдельные DPS voltage/current/power с масштабом; упакованные бинарные meter frames пока требуют отдельного декодера |
| Увлажнитель | Целевая влажность и питание |
| Пылесос | Явные enum команды clean/pause/dock; карты уборки и vendor-протоколы не реализованы |
| Кнопка | Write-only импульс; ACK не создаёт фиктивного наблюдаемого состояния |

Все команды этих вариантов проверены через прямой Wi-Fi и через parent + cid Zigbee на управляемом тестовом транспорте. Также проверены режимы ламп, отказ до отправки при конфликтующих DPS, read-only, недопустимые значения, неизвестный ответ датчика и независимая свежесть DPS. Форматы цвета сверены с установленным TinyTuya. Это программные проверки, **не испытание каждого физического устройства**.

Профили `GET /api/v1/profiles` — примеры явных карт DPS. Автоматического определения по `category` нет. Их номера и диапазоны нужно сверить с реальными `devices.json.mapping`, snapshot/живым status и документацией товара. Например, [RGBCW Tuya Local](https://github.com/make-all/tuya-local/blob/908c133d110a80d9b8dca7da76d55b9017aa62cf/custom_components/tuya_local/devices/rgbwc_lightbulb.yaml) описывает DPS 20–24, а [TH05Z](https://github.com/make-all/tuya-local/blob/908c133d110a80d9b8dca7da76d55b9017aa62cf/custom_components/tuya_local/devices/th05z_temphumidity.yaml) — температуру DPS 1 с делением на 10 и влажность DPS 2. Даже направление цветовой температуры может различаться: у профиля `bulb-v2` по умолчанию прямой диапазон 2700–6500 K; для товара с обратным диапазоном включите `invert:true`.

`scale` нашего сервиса означает `API = raw * scale + offset`. В Tuya Local поле scale используется как делитель — его нельзя механически скопировать. У `minimum`, `maximum`, `step` единицы API, а `raw_type:integer` округляет обратное преобразование до сырого целого tick. Для boolean `invert` меняет true/false; для чисел отражает диапазон minimum..maximum.

`value_map` — список `{value:...,raw:...}` с однозначным обратным чтением; `write_dps` добавляет необходимые постоянные режимы в тот же пакет. `POST /devices/{ref}/commands/capabilities` принимает `{values:{capability:value,...}}`. Конфликт значений одного DPS отклоняется до отправки. Для устройств, требующих только одного DPS в пакете, используйте отдельные операции с подходящей паузой; совместимость пакетной записи нужно подтвердить на товаре. [Tuya Local описывает эти различия](https://github.com/make-all/tuya-local/blob/908c133d110a80d9b8dca7da76d55b9017aa62cf/README.md).

Для яркости в цветном режиме меняйте `v` в capability color; профиль brightness управляет белым режимом. Объект HSV в API: h=0..360, s/v=0..1000. Уровень brightness обычно 1..100%, color_temperature в K. Старые определения без scale/offset сохраняют прежние сырые единицы.

## Датчики и свежесть

`GET /devices/{ref}/state` возвращает только сохранённые показания; `?refresh=true` запрашивает status. Каждый capability содержит value, known, stale, observed_at. На стороне БД добавляется таблица `device_observations`; старые last_dps остаются, но свежесть не выдумывается без наблюдения.

ACK команды не доказывает новую физическую позицию/включение. Новый DPS влажности не обновляет timestamp температуры. Sleeping Zigbee датчик может не отвечать на опрос: экран должен показать неизвестное/устаревшее значение. Для таких устройств нужен фактический push через gateway или облачные события; периодический опрос сам по себе не гарантирует получение событий движения.

Камеры/видеопотоки, защищённое отпирание замков, binary/base64 vendor payload, IR learning, условия сложных конфигураций Tuya Local и некоторые нестандартные RGB-форматы не покрываются готовыми адаптерами. `set_dps` остаётся низкоуровневым интерфейсом для известных команд, но не является обещанием полной поддержки этих категорий.
