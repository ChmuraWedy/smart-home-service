import { localizeMessages, t } from "./i18n";
import type { ControlSpec } from './controls';
import type { JsonValue } from './api';

// Tuya's standard camera DP names. Availability and writable ranges still come
// exclusively from the selected device's API definitions.
export const CAMERA_LABELS: Record<string, string> = localizeMessages({
  basic_private: 'Режим приватности', basic_nightvision: 'Ночное видение',
  basic_flip: 'Перевернуть изображение', basic_osd: 'Дата и время на видео',
  basic_anti_flicker: 'Устранение мерцания', basic_indicator: 'Индикатор камеры', basic_wdr: 'Расширенный динамический диапазон',
  basic_shimmer: 'Цветное изображение при слабом освещении', basic_device_volume: 'Громкость камеры',
  motion_switch: 'Обнаружение движения', motion_sensitivity: 'Чувствительность к движению',
  humanoid_filter: 'Обнаружение человека', motion_area_switch: 'Ограничить область обнаружения', motion_area: 'Область обнаружения',
  decibel_switch: 'Обнаружение звука', decibel_sensitivity: 'Чувствительность к звуку', decibel_upload: 'Событие обнаружения звука',
  siren_switch: 'Сирена', alarm_message: 'Сообщение тревоги', movement_detect_pic: 'Материалы события движения',
  record_switch: 'Запись на карту памяти', record_mode: 'Режим записи', record_loop: 'Циклическая запись',
  sd_storge: 'Ёмкость карты памяти', sd_status: 'Состояние карты памяти',
  sd_format: 'Форматирование карты памяти', sd_format_state: 'Состояние форматирования',
});

// Numeric strings have different meanings for different DPs; never translate
// them globally or change the original command value.
export const CAMERA_OPTIONS: Record<string, Record<string, string>> = localizeMessages({
  basic_nightvision: { '0':'Авто', '1':'Выключено', '2':'Включено' },
  basic_anti_flicker: { '0':'Выключено', '1':'50 Гц', '2':'60 Гц' },
  motion_sensitivity: { '0':'Низкая', '1':'Средняя', '2':'Высокая' },
  decibel_sensitivity: { '0':'Низкая', '1':'Высокая' },
  record_mode: { '1':'По событиям', '2':'Непрерывно' },
});

export const CAMERA_HELP: Record<string, string> = localizeMessages({
  basic_private: 'Отключает аудио- и видеосоединения камеры для защиты приватности. Для просмотра снова выключите режим приватности.\n\nКнопка отправляет команду сразу; общая кнопка «Применить» не требуется.',
  basic_nightvision: 'Инфракрасная подсветка позволяет получать чёрно-белое изображение в темноте.\n\nАвто — камера выбирает ночной режим по освещению. Включено — ночное видение включено постоянно. Выключено — инфракрасное ночное видение отключено.',
  basic_flip: 'Переворачивает изображение камеры. Используйте эту настройку, если камера установлена в перевёрнутом положении.',
  basic_osd: 'Добавляет дату и время непосредственно на изображение камеры. Это отметка времени в видео, отдельная от времени обновления показаний в приложении.',
  basic_anti_flicker: 'Уменьшает мерцание изображения от искусственного освещения. Выберите частоту местной электросети: 50 Гц или 60 Гц. «Выключено» отключает коррекцию мерцания.',
  motion_switch: 'Включает тревоги при обнаружении движения в кадре. При выключении уведомления о таких тревогах в Smart Life перестают поступать.\n\nЧувствительность задаётся отдельно. Ограничение области и фильтр человека уточняют, какие события следует учитывать.',
  motion_sensitivity: 'Чем выше чувствительность, тем менее заметное движение камера может обнаружить.\n\nНизкая — реагирует на значительные движения и помогает уменьшить ложные тревоги. Средняя — баланс обнаружения и ложных срабатываний. Высокая — реагирует на небольшие изменения движения.\n\nНизкая чувствительность не выключает обнаружение. Чувствительность звука настраивается отдельно.',
  humanoid_filter: 'Фильтрует события движения: уведомлять при обнаружении человека, исключая другие движения. В Smart Life это Human Detection (Only Human Events). Это обнаружение человеческого силуэта, а не установление личности.\n\nTuya описывает параметр как фильтр человека. SDK допускает обработку на устройстве, но возможности зависят от оборудования и прошивки. Наше подключение не сообщает условия подписки для Sleep Cam: наличие переключателя не доказывает ни платность, ни бесплатность функции. Условия конкретной камеры проверьте в Smart Life.',
  motion_area_switch: 'Ограничивает обнаружение выбранной областью изображения. В Smart Life эта функция называется Activity Area. Задайте нужную зону через «Область обнаружения».',
  motion_area: 'Задаёт участок изображения, который нужно контролировать. В редакторе переместите красную рамку и измените её размер.\n\n«Сохранить» отправляет выбранную область камере. Для использования зоны включите «Ограничить область обнаружения».',
  decibel_switch: 'Включает обнаружение звуковых событий камерой. В Smart Life можно отдельно выбрать чувствительность к изменениям звука. Обнаружение звука и обнаружение движения настраиваются независимо.',
  decibel_sensitivity: 'Задаёт чувствительность обнаружения звука. Чем она выше, тем более тихие звуки камера может заметить.\n\nНизкая — менее чувствительный режим. Высокая — обнаружение более слабых звуков. Эта настройка не меняет чувствительность движения.',
  siren_switch: 'Включает или выключает звуковую сирену камеры. Это управление сиреной, отдельное от обнаружения движения и звука.',
  record_switch: 'Включает запись видео самой камерой на установленную исправную карту памяти. Без готовой карты запись недоступна.\n\nСохранённое значение «Включено» само по себе не подтверждает, что запись сейчас ведётся. Это отдельная функция от просмотра видео и облачного архива Smart Life.',
  record_mode: 'По событиям — камера записывает на карту при обнаружении движения. Непрерывно — камера ведёт постоянную запись на карту.\n\nОба режима требуют готовой карты памяти и включённой записи.',
  record_loop: 'Включает циклическую запись на карту памяти: после заполнения карты старые записи заменяются новыми.',
  sd_storge: 'Камера сообщает общую, занятую и свободную ёмкость карты в своём формате.',
  sd_status: 'Состояние карты сообщает сама камера: готова, ошибка, недостаточно места, форматирование или карта не установлена.\n\nЗапись доступна только при состоянии «Карта памяти готова». Неизвестное состояние не считается подтверждением готовности.',
  sd_format: 'Форматирование удаляет все записи с карты памяти. Перед отправкой команды приложение попросит подтвердить удаление.\n\nКоманда недоступна без карты, при неизвестном состоянии и во время уже выполняющегося форматирования.',
  sd_format_state: 'Камера сообщает ход или ошибку форматирования. По документации Tuya положительное значение обозначает прогресс; −2000 — форматирование идёт, −2001 — ошибка форматирования, −2002 — карта отсутствует, −2003 — ошибка карты.\n\nЭто показание камеры, а не кнопка запуска форматирования.',
});

export const CAMERA_QUICK_LABELS: Record<string, string> = localizeMessages({
  basic_private:'Приватность', motion_switch:'Движение', decibel_switch:'Звук', siren_switch:'Сирена',
});

const GROUPS = localizeMessages([
  { title:'Изображение и звук', keys:['basic_private','basic_nightvision','basic_flip','basic_osd','basic_anti_flicker','basic_indicator','basic_wdr','basic_shimmer','basic_device_volume'] },
  { title:'Обнаружение и оповещения', keys:['motion_switch','motion_sensitivity','humanoid_filter','motion_area_switch','motion_area','decibel_switch','decibel_sensitivity','siren_switch'] },
  { title:'Запись и карта памяти', keys:['record_switch','record_mode','record_loop','sd_status','sd_storge','sd_format_state'] },
]);

export function cameraStorage(status:Record<string,JsonValue>) {
  // sd_status is a categorical code, not a scaled measurement. Interpret only
  // the documented raw codes; never infer a mounted card from record_switch.
  const labels:Record<string,string>={'1':t("Карта памяти готова"),'2':t("Ошибка карты памяти"),'3':t("Недостаточно места на карте"),'4':t("Карта памяти форматируется"),'5':t("Карта памяти не установлена")};
  const code=typeof status.sd_status==='number' || typeof status.sd_status==='string' ? String(status.sd_status) : '';
  return {ready:code==='1',canFormat:['1','2','3'].includes(code),label:labels[code] || t("Состояние карты памяти неизвестно")};
}

export const isStorageSetting=(key:string)=>['record_switch','record_mode','record_loop','ipc_mute_record','sd_format'].includes(key);

export function cameraSettingsGroups(specs: ControlSpec[]) {
  const grouped = new Set(GROUPS.flatMap(group => group.keys));
  return {
    groups: GROUPS.map(group => ({title:group.title, specs:group.keys.flatMap(key => specs.filter(spec => spec.key === key))})).filter(group => group.specs.length),
    additional: specs.filter(spec => !grouped.has(spec.key)),
  };
}

export function cameraPrivacyBlock(value:boolean | null | undefined) {
  return value===true ? t("Режим приватности включён. Выключите его для просмотра видео.") : value===null ? t("Проверяем режим приватности. Дождитесь показания камеры.") : undefined;
}
