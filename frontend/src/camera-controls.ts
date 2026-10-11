import type { ControlSpec } from './controls';
import type { JsonValue } from './api';

// Tuya's standard camera DP names. Availability and writable ranges still come
// exclusively from the selected device's API definitions.
export const CAMERA_LABELS: Record<string, string> = {
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
};

// Numeric strings have different meanings for different DPs; never translate
// them globally or change the original command value.
export const CAMERA_OPTIONS: Record<string, Record<string, string>> = {
  basic_nightvision: { '0':'Авто', '1':'Выключено', '2':'Включено' },
  basic_anti_flicker: { '0':'Выключено', '1':'50 Гц', '2':'60 Гц' },
  motion_sensitivity: { '0':'Низкая', '1':'Средняя', '2':'Высокая' },
  decibel_sensitivity: { '0':'Низкая', '1':'Высокая' },
  record_mode: { '1':'По событиям', '2':'Непрерывно' },
};

export const CAMERA_HELP: Record<string, string> = {
  basic_private: 'Режим приватности камеры. В этом режиме просмотр видео может быть недоступен.',
  basic_anti_flicker: 'Частота электросети помогает уменьшить мерцание от искусственного освещения.',
  humanoid_filter: 'Камера предоставляет параметр обнаружения человека. API не сообщает, нужна ли подписка и активирована ли функция. Наличие переключателя не подтверждает доступность распознавания; условия проверьте в Smart Life.',
  record_switch: 'Запись выполняется камерой на установленную карту памяти.',
  record_mode: 'Запись по событиям или непрерывная запись на карту памяти.',
  sd_storge: 'Камера сообщает общую, занятую и свободную ёмкость карты в своём формате.',
  sd_format: 'Форматирование удаляет записи с карты памяти.',
  motion_area: 'Область изображения, в которой камера обнаруживает движение.',
};

export const CAMERA_QUICK_LABELS: Record<string, string> = {
  basic_private:'Приватность', motion_switch:'Движение', decibel_switch:'Звук', siren_switch:'Сирена',
};

const GROUPS = [
  { title:'Изображение и звук', keys:['basic_private','basic_nightvision','basic_flip','basic_osd','basic_anti_flicker','basic_indicator','basic_wdr','basic_shimmer','basic_device_volume'] },
  { title:'Обнаружение и оповещения', keys:['motion_switch','motion_sensitivity','humanoid_filter','motion_area_switch','motion_area','decibel_switch','decibel_sensitivity','siren_switch'] },
  { title:'Запись и карта памяти', keys:['record_switch','record_mode','record_loop','sd_status','sd_storge','sd_format_state'] },
];

export function cameraStorage(status:Record<string,JsonValue>) {
  // sd_status is a categorical code, not a scaled measurement. Interpret only
  // the documented raw codes; never infer a mounted card from record_switch.
  const labels:Record<string,string>={'1':'Карта памяти готова','2':'Ошибка карты памяти','3':'Недостаточно места на карте','4':'Карта памяти форматируется','5':'Карта памяти не установлена'};
  const code=typeof status.sd_status==='number' || typeof status.sd_status==='string' ? String(status.sd_status) : '';
  return {ready:code==='1',canFormat:['1','2','3'].includes(code),label:labels[code] || 'Состояние карты памяти неизвестно'};
}

export const isStorageSetting=(key:string)=>['record_switch','record_mode','record_loop','ipc_mute_record','sd_format'].includes(key);

export function cameraSettingsGroups(specs: ControlSpec[]) {
  const grouped = new Set(GROUPS.flatMap(group => group.keys));
  return {
    groups: GROUPS.map(group => ({title:group.title, specs:group.keys.flatMap(key => specs.filter(spec => spec.key === key))})).filter(group => group.specs.length),
    additional: specs.filter(spec => !grouped.has(spec.key)),
  };
}
