import type { CloudFunction, CloudFunctions, CloudSnapshot, JsonValue } from './api';
import type { Capability, Reading } from './home-api';
import { editableSchema, rawBytes, validateObject } from './lighting';
import type { JsonSchema } from './lighting';

export type HSV = { h: number; s: number; v: number };
export type ControlSpec = {
  key: string; label: string; kind: 'boolean' | 'number' | 'enum' | 'color' | 'text' | 'json' | 'raw' | 'unsupported';
  readable: boolean; writable: boolean; minimum?: number; maximum?: number; step?: number;
  integer?: boolean; choices?: JsonValue[]; unit?: string;
  factor?: number; colorScale?: { s: number; v: number }; reason?: string; help?: string; indicator?: 'motion'; advanced?: boolean;
  schema?: JsonSchema; maximumBytes?: number;
};

const MOTION_KEYS = new Set(['motion', 'pir', 'pir_state']);

const LABELS: Record<string, string> = {
  switch: 'Питание', switch_led: 'Питание', brightness: 'Яркость', bright_value: 'Яркость', bright_value_v2: 'Яркость',
  color: 'Цвет', colour_data: 'Цвет', colour_data_v2: 'Цвет', color_temperature: 'Цветовая температура',
  temp_value: 'Цветовая температура', temp_value_v2: 'Цветовая температура', target_temperature: 'Заданная температура',
  temp_set: 'Заданная температура', temp_set_f: 'Заданная температура', temperature: 'Температура', temp_current: 'Температура',
  humidity: 'Влажность', humidity_value: 'Влажность', target_humidity: 'Заданная влажность', motion: 'Движение',
  pir: 'Движение', pir_state: 'Движение', presence_state: 'Присутствие', battery: 'Батарея', battery_percentage: 'Батарея',
  mode: 'Режим', work_mode: 'Режим', speed: 'Скорость', fan_speed_enum: 'Скорость', position: 'Положение',
  percent_control: 'Положение', control: 'Действие', oscillation: 'Поворот', power: 'Мощность', cur_power: 'Мощность',
  voltage: 'Напряжение', current: 'Ток', child_lock: 'Блокировка', command: 'Команда', press: 'Нажатие',
  music_data: 'Светомузыка', control_data: 'Переход света', scene_data: 'Световой эффект', scene_data_v2: 'Световой эффект',
  countdown: 'Таймер', relay_status: 'Состояние после подачи питания', switch_backlight: 'Подсветка выключателя',
  switch_inching: 'Автовыключение (импульсный режим)', rhythm_mode: 'Суточный ритм света', sleep_mode: 'Свет перед сном',
  wakeup_mode: 'Свет для пробуждения', power_memory: 'Поведение после включения питания',
  do_not_disturb: 'Не беспокоить', remote_switch: 'Параметр пульта', random_timing: 'Случайное расписание',
};
const LIGHT_COMMAND_HELP: Record<string, string> = {
  music_data: 'Команды изменения света в такт музыке. Для синхронизации нужен источник аудио, который отправляет такие команды.',
  control_data: 'Команда быстрого или плавного изменения света. Текущее состояние смотрите в полях цвета и яркости.',
};
const OPTIONS: Record<string, string> = { white: 'Белый свет', colour: 'Цветной свет', scene: 'Сцена', music: 'Музыка',
  auto: 'Авто', manual: 'Вручную', open: 'Открыть', close: 'Закрыть', stop: 'Стоп', low: 'Низкая', medium: 'Средняя', high: 'Высокая', dock: 'На базу' };
export const labelFor = (key: string) => LABELS[key] || (/^switch_[1-9][0-9]*$/.test(key) ? 'Канал ' + key.slice(7) : /^countdown_[1-9][0-9]*$/.test(key) ? 'Таймер канала ' + key.slice(10) : /^relay_status_[1-9][0-9]*$/.test(key) ? 'Состояние канала ' + key.slice(13) + ' после подачи питания' : key.replaceAll('_', ' '));
const RELAY_OPTIONS: Record<string, string> = { power_off: 'Выключено', off: 'Выключено', power_on: 'Включено', on: 'Включено', last: 'Восстановить предыдущее состояние', memory: 'Восстановить предыдущее состояние' };
export const optionLabel = (value: JsonValue, key?: string) => typeof value === 'string' ? (key && /^relay_status(?:_[1-9][0-9]*)?$/.test(key) ? RELAY_OPTIONS[value] : undefined) || OPTIONS[value] || value : typeof value === 'boolean' ? (value ? 'Да' : 'Нет') : JSON.stringify(value);
const unitLabel = (unit: string | undefined) => unit === 's' ? 'с' : unit;
function controlHelp(key: string): string | undefined {
  if (key === 'relay_status' || /^relay_status_[1-9][0-9]*$/.test(key)) return 'Какое состояние восстановить после отключения и повторной подачи электропитания. Это настройка, а не текущий статус реле.';
  if (key === 'switch_backlight') return 'Включение и выключение подсветки клавиш выключателя.';
  if (/^countdown(?:_[1-9][0-9]*)?$/.test(key)) return 'Обратный отсчёт до переключения. Время задаётся в секундах.';
  if (key === 'switch_inching') return 'После включения выключатель автоматически отключается через заданное время. Например, через минуту. Настройка передаётся строкой; её формат не описан в API этого устройства.';
}
export const sameValue = (left: JsonValue, right: JsonValue) => JSON.stringify(left) === JSON.stringify(right);

export function limitsOf(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const rounded = (value: number) => Number(value.toPrecision(12));

export function localSpec(key: string, cap: Capability): ControlSpec {
  const base = { key, label: labelFor(key), readable: cap.readable, writable: cap.writable, unit: unitLabel(cap.unit || undefined), help: controlHelp(key),
    indicator: !cap.writable && MOTION_KEYS.has(key) && cap.type === 'boolean' ? 'motion' as const : undefined };
  if (cap.enum?.length) return { ...base, kind: 'enum', choices: cap.enum };
  switch (cap.type) {
    case 'boolean': return { ...base, kind: 'boolean' };
    case 'integer': case 'number': return { ...base, kind: 'number', integer: cap.type === 'integer',
      minimum: cap.minimum ?? undefined, maximum: cap.maximum ?? undefined, step: cap.step ?? (cap.type === 'integer' ? 1 : undefined) };
    case 'string': return { ...base, kind: 'text' };
    case 'object': return { ...base, kind: cap.encoding && cap.encoding !== 'raw' ? 'color' : 'json' };
  }
}

function cloudColorScale(fn: CloudFunction, limits: Record<string, unknown>): { s: number; v: number } | undefined {
  if (!['colour_data', 'colour_data_v2'].includes(fn.code) || fn.type !== 'Json') return;
  if (!Object.keys(limits).length) {
    // Tuya's published standard instruction set; only these exact Json codes.
    const maximum = fn.code === 'colour_data' ? 255 : 1000;
    return { s: maximum, v: maximum };
  }
  const h = limitsOf(limits.h), s = limitsOf(limits.s), v = limitsOf(limits.v);
  if ([h, s, v].some(axis => axis.min !== 0 || (axis.scale ?? 0) !== 0 || (axis.step ?? 1) !== 1)) return;
  if (h.max !== 360 || !finite(s.max) || !finite(v.max) || !Number.isInteger(s.max) || !Number.isInteger(v.max) || s.max <= 0 || v.max <= 0) return;
  return { s: s.max, v: v.max };
}

export function cloudSpec(fn: CloudFunction, writable: boolean): ControlSpec {
  // These two documented lighting DPs are send-only, even when the cloud
  // includes an empty/echoed value in its cached status range.
  const commandHelp = ['String', 'Json'].includes(fn.type) ? LIGHT_COMMAND_HELP[fn.code] : undefined;
  const base = { key: fn.code, label: labelFor(fn.code), readable: !commandHelp, writable,
    advanced: Boolean(commandHelp) || fn.type === 'Raw' || fn.code === 'remote_switch', help: commandHelp || controlHelp(fn.code),
    indicator: !writable && MOTION_KEYS.has(fn.code) && ['Boolean', 'Enum'].includes(fn.type) ? 'motion' as const : undefined };
  const limits = limitsOf(fn.values);
  const unit = typeof limits.unit === 'string' ? unitLabel(limits.unit) : undefined;
  if (fn.type === 'Boolean') return { ...base, kind: 'boolean', help: fn.code === 'remote_switch' ? 'Связанные устройства добавляются в Smart Life. Здесь доступен параметр лампы «вкл/выкл»; управление списком привязок пока не реализовано.' : base.help };
  if (fn.type === 'Integer') {
    const scale = limits.scale ?? 0;
    const validScale = Number.isInteger(scale) && (scale as number) >= 0 && (scale as number) <= 9;
    let factor = validScale ? 10 ** -(scale as number) : 1;
    let displayUnit = unit;
    if (validScale && scale === 0 && finite(limits.max) && limits.max > 0 && ['bright_value', 'bright_value_v2', 'temp_value', 'temp_value_v2'].includes(fn.code)) {
      factor = 100 / limits.max; displayUnit = '%';
    }
    const validBounds = Number.isInteger(limits.min) && Number.isInteger(limits.max) &&
      (limits.min as number) <= (limits.max as number) && validScale &&
      (limits.step === undefined || (Number.isInteger(limits.step) && (limits.step as number) > 0));
    return { ...base, kind: 'number', writable: writable && validBounds, factor,
      minimum: finite(limits.min) ? limits.min * factor : undefined,
      maximum: finite(limits.max) ? limits.max * factor : undefined,
      step: (finite(limits.step) ? limits.step : 1) * factor, unit: displayUnit,
      help: !writable && ['battery', 'battery_value', 'battery_percentage'].includes(fn.code) && !displayUnit ? 'Единица измерения не указана устройством.' : base.help,
      reason: !writable || validBounds ? undefined : 'Нет корректного диапазона; управление недоступно.' };
  }
  if (fn.type === 'Enum') {
    const choices = Array.isArray(limits.range) && limits.range.every(value => typeof value === 'string') ? limits.range as string[] : [];
    return { ...base, kind: 'enum', writable: writable && choices.length > 0, choices, reason: !writable || choices.length ? undefined : 'Нет списка допустимых режимов.' };
  }
  if (fn.type === 'String') return { ...base, kind: 'text' };
  if (fn.type === 'Json') {
    const colorScale = cloudColorScale(fn, limits);
    return { ...base, kind: colorScale ? 'color' : 'json', colorScale, advanced: !colorScale, schema: colorScale ? undefined : editableSchema(limits) };
  }
  if (fn.type === 'Raw') {
    const maximum = limits.maxlen === undefined ? 16384 : Number(limits.maxlen);
    const valid = Number.isInteger(maximum) && maximum >= 0;
    return { ...base, kind: 'raw', writable: writable && valid, maximumBytes: valid ? Math.min(maximum,16384) : undefined,
      reason: valid ? undefined : 'Не указан корректный размер данных производителя.' };
  }
  return { ...base, kind: 'unsupported', writable: false, reason: 'Этот формат доступен только для просмотра.' };
}

export function cloudSpecs(definitions: CloudFunctions, snapshot: CloudSnapshot): ControlSpec[] {
  const result = new Map<string, ControlSpec>();
  for (const fn of [...(definitions.status_range || []), ...(snapshot.status_range || [])]) result.set(fn.code, cloudSpec(fn, false));
  for (const fn of definitions.functions) result.set(fn.code, cloudSpec(fn, true));
  for (const key of Object.keys(snapshot.status)) if (!result.has(key)) result.set(key, { key, label: labelFor(key), kind: 'unsupported', readable: true, writable: false,
    indicator: MOTION_KEYS.has(key) ? 'motion' : undefined });
  return [...result.values()];
}

export function cloudReading(spec: ControlSpec, raw: JsonValue | undefined, observation?: {observed_at:string|null; received_at:string}): Reading {
  if (!spec.readable) return { value: null, known: false, stale: true };
  let value: JsonValue = raw ?? null;
  let known = raw !== undefined && raw !== null;
  if (spec.kind === 'number') {
    known = finite(raw);
    value = known ? rounded((raw as number) * (spec.factor ?? 1)) : null;
  } else if (spec.kind === 'boolean') {
    known = typeof raw === 'boolean'; value = known ? raw! : null;
  } else if (spec.kind === 'color') {
    const color = limitsOf(raw), scale = spec.colorScale!;
    known = finite(color.h) && finite(color.s) && finite(color.v) && color.h >= 0 && color.h <= 360 && color.s >= 0 && color.s <= scale.s && color.v >= 0 && color.v <= scale.v;
    value = known ? { h: Math.round(color.h as number), s: Math.round((color.s as number) * 1000 / scale.s), v: Math.round((color.v as number) * 1000 / scale.v) } : null;
  } else if (spec.kind === 'json' && typeof raw === 'string') {
    try { value = JSON.parse(raw); known = Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
    catch { known = false; }
    if (!known) value = null;
  } else if (spec.kind === 'raw') {
    try { known = typeof raw === 'string'; if (known) rawBytes(raw as string, spec.maximumBytes); }
    catch { known = false; }
    if (!known) value = null;
  }
  if (spec.indicator === 'motion') {
    const validMotion = spec.kind === 'enum' ? (raw === 'pir' || raw === 'none') && (!spec.choices?.length || spec.choices.includes(raw)) : typeof raw === 'boolean' || raw === 'pir' || raw === 'none';
    known = known && validMotion;
    value = known ? raw! : null;
  }
  return { value, known, stale: !known, ...(observation && known ? {source:'tuya_event',observed_at:observation.observed_at,received_at:observation.received_at} : {}) };
}

export function motionState(spec: ControlSpec, reading: Reading | undefined): boolean | null | undefined {
  if (spec.indicator !== 'motion') return;
  if (!reading?.known || reading.value === null) return null;
  if (reading.value === true || reading.value === 'pir') return true;
  if (reading.value === false || reading.value === 'none') return false;
  return null;
}

export function isStale(reading: Reading | undefined, now: number, local: boolean): boolean {
  if (!reading?.known || reading.stale) return true;
  if (!local) return false; // Cloud snapshots do not supply per-DP observation times.
  const observed = reading.observed_at ? Date.parse(reading.observed_at) : NaN;
  return !Number.isFinite(observed) || now - observed > 60_000;
}

export function displayReading(spec: ControlSpec, reading: Reading | undefined): string {
  if (!reading?.known || reading.value === null) return 'Нет данных';
  const motion = motionState(spec, reading);
  if (motion !== undefined) return motion === null ? 'Нет данных' : motion ? 'Движение обнаружено' : 'Движения нет';
  const value = reading.value;
  if (typeof value === 'boolean') return ['switch', 'switch_led'].includes(spec.key) || spec.key.startsWith('switch_') ? (value ? 'Включено' : 'Выключено') : (value ? 'Да' : 'Нет');
  if (spec.kind === 'color' && typeof value === 'object' && !Array.isArray(value)) return `Тон ${value.h}°, насыщенность ${rounded(Number(value.s) / 10)}%, яркость ${rounded(Number(value.v) / 10)}%`;
  return (typeof value === 'number' ? String(rounded(value)) : optionLabel(value, spec.key)) + (spec.unit ? ' ' + spec.unit : '');
}

export function validateControlValue(spec: ControlSpec, value: JsonValue): void {
  if (!spec.writable) throw new Error('Эта возможность доступна только для чтения.');
  if (spec.kind === 'enum') {
    if (!spec.choices?.some(option => sameValue(option, value))) throw new Error('Выберите допустимое значение.');
  } else if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('Нужно логическое значение.');
  } else if (spec.kind === 'number') {
    if (!finite(value) || (spec.integer && !Number.isInteger(value))) throw new Error('Введите корректное число.');
    if ((spec.minimum !== undefined && value < spec.minimum - 1e-6) || (spec.maximum !== undefined && value > spec.maximum + 1e-6)) throw new Error('Значение вне допустимого диапазона.');
    if (spec.step) {
      const ticks = (value - (spec.minimum ?? 0)) / spec.step;
      if (Math.abs(ticks - Math.round(ticks)) > 1e-5) throw new Error('Значение не соответствует допустимому шагу.');
    }
  } else if (spec.kind === 'color') {
    const hsv = limitsOf(value);
    if (!Number.isInteger(hsv.h) || !Number.isInteger(hsv.s) || !Number.isInteger(hsv.v) ||
      (hsv.h as number) < 0 || (hsv.h as number) > 360 || (hsv.s as number) < 0 || (hsv.s as number) > 1000 || (hsv.v as number) < 0 || (hsv.v as number) > 1000) throw new Error('Цвет должен содержать тон 0–360 и насыщенность/яркость 0–1000.');
  } else if (spec.kind === 'text') {
    if (typeof value !== 'string') throw new Error('Введите текст.');
  } else if (spec.kind === 'json') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Введите JSON-объект.');
    if (spec.schema) validateObject(value,spec.schema);
  } else if (spec.kind === 'raw') {
    if (typeof value !== 'string') throw new Error('Нужны данные производителя (base64).');
    rawBytes(value,spec.maximumBytes);
  } else throw new Error('Формат управления пока не поддержан.');
}

export function cloudCommands(spec: ControlSpec, value: JsonValue, definitions: CloudFunctions): { code: string; value: JsonValue }[] {
  validateControlValue(spec, value);
  let raw = value;
  if (spec.kind === 'number') raw = Math.round((value as number) / (spec.factor ?? 1));
  if (spec.kind === 'color') {
    const hsv = value as HSV, scale = spec.colorScale!;
    raw = { h: hsv.h, s: Math.round(hsv.s * scale.s / 1000), v: Math.round(hsv.v * scale.v / 1000) };
  }
  const commands = [{ code: spec.key, value: raw }];
  const mode = definitions.functions.find(fn => fn.code === 'work_mode' && fn.type === 'Enum');
  const wanted = spec.kind === 'color' ? 'colour' : spec.key === 'music_data' ? 'music' : spec.key === 'scene_data_v2' ? 'scene' : ['bright_value', 'bright_value_v2', 'temp_value', 'temp_value_v2'].includes(spec.key) ? 'white' : undefined;
  const modes = mode ? limitsOf(mode.values).range : undefined;
  if (wanted && Array.isArray(modes) && modes.includes(wanted)) commands.unshift({ code: 'work_mode', value: wanted });
  return commands;
}

export function hsvToHex(hsv: HSV): string {
  const h = (hsv.h % 360) / 60, s = hsv.s / 1000, v = hsv.v / 1000;
  const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
  const channels = h < 1 ? [c,x,0] : h < 2 ? [x,c,0] : h < 3 ? [0,c,x] : h < 4 ? [0,x,c] : h < 5 ? [x,0,c] : [c,0,x];
  return '#' + channels.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('');
}
export function hexToHsv(hex: string): HSV {
  const [r,g,b] = [1,3,5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r,g,b), delta = max - Math.min(r,g,b);
  let h = !delta ? 0 : max === r ? 60 * (((g-b)/delta) % 6) : max === g ? 60 * ((b-r)/delta + 2) : 60 * ((r-g)/delta + 4);
  if (h < 0) h += 360;
  return { h: Math.round(h), s: Math.round((max ? delta / max : 0) * 1000), v: Math.round(max * 1000) };
}
