import { MSG, localizeMessages, rawMessages, t } from "./i18n";
import type { CloudFunction, CloudFunctions, CloudSnapshot, JsonValue } from './api';
import type { Capability, Reading } from './home-api';
import { editableSchema, rawBytes, validateObject } from './lighting';
import type { JsonSchema } from './lighting';
import { CAMERA_HELP, CAMERA_LABELS, CAMERA_OPTIONS } from './camera-controls';

export type HSV = { h: number; s: number; v: number };
export type ControlSpec = {
  key: string; label: string; kind: 'boolean' | 'number' | 'enum' | 'color' | 'text' | 'json' | 'raw' | 'unsupported';
  readable: boolean; writable: boolean; minimum?: number; maximum?: number; step?: number;
  integer?: boolean; choices?: JsonValue[]; unit?: string;
  factor?: number; colorScale?: { s: number; v: number }; reason?: string; help?: string; indicator?: 'motion'; advanced?: boolean;
  schema?: JsonSchema; maximumBytes?: number; aliases?: string[];
};

const TUYA_LIGHT_PERCENTAGE_CODES = new Set(['bright_value', 'bright_value_v2', 'temp_value', 'temp_value_v2']);
const MOTION_KEYS = new Set(['motion', 'pir', 'pir_state']);

const LABELS: Record<string, string> = localizeMessages({
  ...rawMessages(CAMERA_LABELS),
  switch: MSG.POWER, switch_led: MSG.POWER, brightness: MSG.BRIGHTNESS, bright_value: MSG.BRIGHTNESS, bright_value_v2: MSG.BRIGHTNESS,
  color: MSG.COLOR, colour_data: MSG.COLOR, colour_data_v2: MSG.COLOR, color_temperature: MSG.COLOR_TEMPERATURE,
  temp_value: MSG.COLOR_TEMPERATURE, temp_value_v2: MSG.COLOR_TEMPERATURE, target_temperature: MSG.TARGET_TEMPERATURE,
  temp_set: MSG.TARGET_TEMPERATURE, temp_set_f: MSG.TARGET_TEMPERATURE, temperature: MSG.TEMPERATURE, temp_current: MSG.TEMPERATURE,
  humidity: MSG.HUMIDITY, humidity_value: MSG.HUMIDITY, target_humidity: MSG.TARGET_HUMIDITY, motion: MSG.MOTION,
  va_temperature: MSG.TEMPERATURE, va_humidity: MSG.HUMIDITY, va_battery: MSG.BATTERY, battery_value: MSG.BATTERY, battery_state: MSG.BATTERY, battery_level: MSG.BATTERY,
  temp_unit_convert: MSG.TEMPERATURE_UNIT, temp_unit: MSG.TEMPERATURE_UNIT, temp_sensitivity: MSG.TEMPERATURE_SENSITIVITY, humidity_sensitivity: MSG.HUMIDITY_SENSITIVITY,
  temp_calibration: MSG.TEMPERATURE_CALIBRATION, humidity_calibration: MSG.HUMIDITY_CALIBRATION, max_temp: MSG.MAXIMUM_TEMPERATURE, min_temp: MSG.MINIMUM_TEMPERATURE, max_humidity: MSG.MAXIMUM_HUMIDITY, min_humidity: MSG.MINIMUM_HUMIDITY,
  pir: MSG.MOTION, pir_state: MSG.MOTION, presence_state: MSG.PRESENCE, battery: MSG.BATTERY, battery_percentage: MSG.BATTERY,
  mode: MSG.MODE, work_mode: MSG.MODE, speed: MSG.SPEED, fan_speed_enum: MSG.SPEED, position: MSG.POSITION,
  percent_control: MSG.POSITION, control: MSG.ACTION, oscillation: MSG.OSCILLATION, power: MSG.POWER_CONSUMPTION, cur_power: MSG.POWER_CONSUMPTION,
  voltage: MSG.VOLTAGE, current: MSG.CURRENT, child_lock: MSG.LOCK, command: MSG.COMMAND, press: MSG.PRESS,
  music_data: MSG.MUSIC_LIGHTING, control_data: MSG.LIGHT_TRANSITION, scene_data: MSG.LIGHTING_EFFECT, scene_data_v2: MSG.LIGHTING_EFFECT,
  countdown: MSG.TIMER, relay_status: MSG.POWER_ON_STATE, switch_backlight: MSG.SWITCH_BACKLIGHT,
  switch_inching: MSG.AUTO_OFF_INCHING_MODE, rhythm_mode: MSG.CIRCADIAN_LIGHTING, sleep_mode: MSG.SLEEP_LIGHT,
  wakeup_mode: MSG.WAKE_UP_LIGHT, power_memory: MSG.POWER_ON_BEHAVIOR,
  do_not_disturb: MSG.DO_NOT_DISTURB, remote_switch: MSG.REMOTE_PARAMETER, random_timing: MSG.RANDOM_SCHEDULE,
});
const LIGHT_COMMAND_HELP: Record<string, string> = localizeMessages({
  music_data: MSG.COMMANDS_THAT_CHANGE_THE_LIGHT_IN_TIME_WITH,
  control_data: MSG.COMMAND_FOR_AN_IMMEDIATE_OR_SMOOTH_LIGHTING_CHANGE,
});
const OPTIONS: Record<string, string> = localizeMessages({
  white: MSG.WHITE_LIGHT,
  colour: MSG.COLOR_LIGHT,
  color: MSG.COLOR_LIGHT,
  scene: MSG.SCENE,
  music: MSG.MUSIC,
  auto: MSG.AUTO,
  manual: MSG.MANUAL,
  open: MSG.OPEN,
  close: MSG.CLOSE,
  stop: MSG.STOP_LABEL,
  low: MSG.LOW,
  medium: MSG.MEDIUM,
  high: MSG.HIGH,
  dock: MSG.RETURN_TO_DOCK,
});
export const labelFor = (key: string) => LABELS[key] || (/^switch_[1-9][0-9]*$/.test(key) ? t(MSG.CHANNEL, [key.slice(7)]) : /^countdown_[1-9][0-9]*$/.test(key) ? t(MSG.CHANNEL_TIMER, [key.slice(10)]) : /^relay_status_[1-9][0-9]*$/.test(key) ? t(MSG.CHANNEL_POWER_ON_STATE, [key.slice(13)]) : key.replaceAll('_', ' '));
const RELAY_OPTIONS: Record<string, string> = localizeMessages({ power_off: MSG.OFF, off: MSG.OFF, power_on: MSG.ON, on: MSG.ON, last: MSG.RESTORE_PREVIOUS_STATE, memory: MSG.RESTORE_PREVIOUS_STATE });
export const optionLabel = (value: JsonValue, key?: string) => typeof value === 'string' ? (key ? CAMERA_OPTIONS[key]?.[value] : undefined) || (key && /^relay_status(?:_[1-9][0-9]*)?$/.test(key) ? RELAY_OPTIONS[value] : undefined) || OPTIONS[value] || value : typeof value === 'boolean' ? (value ? t(MSG.YES) : t(MSG.NO)) : JSON.stringify(value);
const unitLabel = (unit: string | undefined) => unit === 's' ? t(MSG.S) : unit === '℃' ? '°C' : unit === '℉' ? '°F' : unit;
function controlHelp(key: string): string | undefined {
  if (CAMERA_HELP[key]) return CAMERA_HELP[key];
  if (key === 'relay_status' || /^relay_status_[1-9][0-9]*$/.test(key)) return t(MSG.WHICH_STATE_TO_RESTORE_AFTER_ELECTRICAL_POWER_IS);
  if (key === 'switch_backlight') return t(MSG.TURNS_THE_SWITCH_BUTTON_BACKLIGHT_ON_OR_OFF);
  if (/^countdown(?:_[1-9][0-9]*)?$/.test(key)) return t(MSG.COUNTDOWN_UNTIL_THE_SWITCH_CHANGES_STATE);
  if (key === 'switch_inching') return t(MSG.AFTER_TURNING_ON_THE_SWITCH_TURNS_OFF_AUTOMATICALLY);
}
export const sameValue = (left: JsonValue, right: JsonValue) => JSON.stringify(left) === JSON.stringify(right);
export const cloudLabel = (fn: CloudFunction) => labelFor(fn.code);
export function withChannelLabels(definitions: CloudFunctions, labels: Record<string, string>): CloudFunctions {
  const apply = (fn: CloudFunction) => ({ ...fn, user_label: labels[fn.code] });
  return { ...definitions, functions: definitions.functions.map(apply), status_range: definitions.status_range?.map(apply) };
}

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
    case 'integer': case 'number': {
      const { minimum, maximum } = cap;
      const step = cap.step ?? (cap.type === 'integer' ? 1 : undefined);
      if (!base.unit && TUYA_LIGHT_PERCENTAGE_CODES.has(key) && finite(minimum) && finite(maximum)
        && minimum >= 0 && minimum < maximum) {
        const factor = 100 / maximum;
        return {
          ...base,
          kind: 'number',
          unit: '%',
          factor,
          minimum: rounded(minimum * factor),
          maximum: 100,
          step: step === undefined ? undefined : rounded(step * factor),
        };
      }
      return { ...base, kind: 'number', integer: cap.type === 'integer', minimum: minimum ?? undefined, maximum: maximum ?? undefined, step };
    }
    case 'string': return { ...base, kind: 'text' };
    case 'object': return { ...base, kind: cap.encoding && cap.encoding !== 'raw' ? 'color' : 'json' };
  }
}

export function localReading(spec: ControlSpec, reading: Reading | undefined): Reading | undefined {
  if (!spec.factor || !reading?.known || !finite(reading.value)) return reading;
  return { ...reading, value: rounded(reading.value * spec.factor) };
}

export function localCommandValue(spec: ControlSpec, value: JsonValue): JsonValue {
  return spec.factor && finite(value) ? rounded(value / spec.factor) : value;
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
  const base = { key: fn.code, label: cloudLabel(fn), readable: !commandHelp, writable,
    aliases: /^switch_[1-9][0-9]*$/.test(fn.code) && fn.user_label ? [fn.user_label] : undefined,
    advanced: Boolean(commandHelp) || fn.type === 'Raw' || fn.code === 'remote_switch', help: commandHelp || controlHelp(fn.code),
    indicator: !writable && MOTION_KEYS.has(fn.code) && ['Boolean', 'Enum'].includes(fn.type) ? 'motion' as const : undefined };
  const limits = limitsOf(fn.values);
  const unit = typeof limits.unit === 'string' ? unitLabel(limits.unit) : undefined;
  if (fn.type === 'Boolean') return { ...base, kind: 'boolean', help: fn.code === 'remote_switch' ? t(MSG.LINKED_DEVICES_ARE_ADDED_IN_SMART_LIFE) : base.help };
  if (fn.type === 'Integer') {
    const scale = limits.scale ?? 0;
    const validScale = Number.isInteger(scale) && (scale as number) >= 0 && (scale as number) <= 9;
    let factor = validScale ? 10 ** -(scale as number) : 1;
    let displayUnit = unit;
    if (validScale && scale === 0 && finite(limits.max) && limits.max > 0 && TUYA_LIGHT_PERCENTAGE_CODES.has(fn.code)) {
      factor = 100 / limits.max; displayUnit = '%';
    }
    const validBounds = Number.isInteger(limits.min) && Number.isInteger(limits.max) &&
      (limits.min as number) <= (limits.max as number) && validScale &&
      (limits.step === undefined || (Number.isInteger(limits.step) && (limits.step as number) > 0));
    return { ...base, kind: 'number', writable: writable && validBounds, factor,
      minimum: finite(limits.min) ? limits.min * factor : undefined,
      maximum: finite(limits.max) ? limits.max * factor : undefined,
      step: (finite(limits.step) ? limits.step : 1) * factor, unit: displayUnit,
      help: !writable && ['battery', 'battery_value', 'battery_percentage'].includes(fn.code) && !displayUnit ? t(MSG.THE_DEVICE_DID_NOT_SPECIFY_A_UNIT) : base.help,
      reason: !writable || validBounds ? undefined : t(MSG.NO_VALID_RANGE_CONTROL_UNAVAILABLE) };
  }
  if (fn.type === 'Enum') {
    const choices = Array.isArray(limits.range) && limits.range.every(value => typeof value === 'string') ? limits.range as string[] : [];
    return { ...base, kind: 'enum', writable: writable && choices.length > 0, choices, reason: !writable || choices.length ? undefined : t(MSG.NO_LIST_OF_ALLOWED_MODES) };
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
      reason: valid ? undefined : t(MSG.NO_VALID_MANUFACTURER_DATA_SIZE_SPECIFIED) };
  }
  return { ...base, kind: 'unsupported', writable: false, reason: t(MSG.THIS_FORMAT_IS_READ_ONLY) };
}

export function cloudSpecs(definitions: CloudFunctions, snapshot: CloudSnapshot): ControlSpec[] {
  const result = new Map<string, ControlSpec>();
  for (const fn of [...(definitions.status_range || []), ...(snapshot.status_range || [])]) result.set(fn.code, cloudSpec(fn, false));
  for (const fn of definitions.functions) result.set(fn.code, cloudSpec(fn, true));
  for (const key of Object.keys(snapshot.status)) if (!result.has(key)) result.set(key, { key, label: labelFor(key), kind: 'unsupported', readable: true, writable: false,
    indicator: MOTION_KEYS.has(key) ? 'motion' : undefined });
  for (const fn of [...(definitions.status_range || []), ...definitions.functions]) {
    const spec = result.get(fn.code);
    if (spec && /^switch_[1-9][0-9]*$/.test(fn.code) && fn.user_label) spec.aliases = [fn.user_label];
  }
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
  if (!reading?.known || reading.value === null) return t(MSG.NO_DATA);
  const motion = motionState(spec, reading);
  if (motion !== undefined) return motion === null ? t(MSG.NO_DATA) : motion ? t(MSG.MOTION_DETECTED) : t(MSG.NO_MOTION);
  const value = reading.value;
  if (typeof value === 'boolean') return ['switch', 'switch_led'].includes(spec.key) || spec.key.startsWith('switch_') ? (value ? t(MSG.ON) : t(MSG.OFF)) : (value ? t(MSG.YES) : t(MSG.NO));
  if (spec.kind === 'color' && typeof value === 'object' && !Array.isArray(value)) return t(MSG.HUE_SATURATION_BRIGHTNESS, [value.h, rounded(Number(value.s) / 10), rounded(Number(value.v) / 10)]);
  return (typeof value === 'number' ? String(rounded(value)) : optionLabel(value, spec.key)) + (spec.unit ? ' ' + spec.unit : '');
}

export function validateControlValue(spec: ControlSpec, value: JsonValue): void {
  if (!spec.writable) throw new Error(t(MSG.THIS_CAPABILITY_IS_READ_ONLY));
  if (spec.kind === 'enum') {
    if (!spec.choices?.some(option => sameValue(option, value))) throw new Error(t(MSG.SELECT_AN_ALLOWED_VALUE));
  } else if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(t(MSG.A_BOOLEAN_VALUE_IS_REQUIRED));
  } else if (spec.kind === 'number') {
    if (!finite(value) || (spec.integer && !Number.isInteger(value))) throw new Error(t(MSG.ENTER_A_VALID_NUMBER));
    if ((spec.minimum !== undefined && value < spec.minimum - 1e-6) || (spec.maximum !== undefined && value > spec.maximum + 1e-6)) throw new Error(t(MSG.VALUE_OUTSIDE_THE_ALLOWED_RANGE));
    if (spec.step) {
      const ticks = (value - (spec.minimum ?? 0)) / spec.step;
      if (Math.abs(ticks - Math.round(ticks)) > 1e-5) throw new Error(t(MSG.VALUE_DOES_NOT_MATCH_THE_ALLOWED_STEP));
    }
  } else if (spec.kind === 'color') {
    const hsv = limitsOf(value);
    if (!Number.isInteger(hsv.h) || !Number.isInteger(hsv.s) || !Number.isInteger(hsv.v) ||
      (hsv.h as number) < 0 || (hsv.h as number) > 360 || (hsv.s as number) < 0 || (hsv.s as number) > 1000 || (hsv.v as number) < 0 || (hsv.v as number) > 1000) throw new Error(t(MSG.COLOR_MUST_CONTAIN_HUE_0360_AND_SATURATION_BRIGHTNESS));
  } else if (spec.kind === 'text') {
    if (typeof value !== 'string') throw new Error(t(MSG.ENTER_TEXT));
  } else if (spec.kind === 'json') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t(MSG.ENTER_A_JSON_OBJECT));
    if (spec.schema) validateObject(value,spec.schema);
  } else if (spec.kind === 'raw') {
    if (typeof value !== 'string') throw new Error(t(MSG.MANUFACTURER_DATA_BASE64_IS_REQUIRED));
    rawBytes(value,spec.maximumBytes);
  } else throw new Error(t(MSG.THIS_CONTROL_FORMAT_IS_NOT_SUPPORTED_YET));
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
  const modes = mode ? limitsOf(mode.values).range : undefined;
  if (!Array.isArray(modes)) return commands;
  let wanted;
  if (spec.kind === 'color') wanted = modes.includes('colour') ? 'colour' : 'color';
  else if (spec.key === 'music_data') wanted = 'music';
  else if (/^scene_data(?:_v2)?$/.test(spec.key)) wanted = 'scene';
  else if (/^(?:bright|temp)_value(?:_v2)?$/.test(spec.key)) wanted = 'white';
  if (wanted && modes.includes(wanted)) commands.unshift({ code: 'work_mode', value: wanted });
  return commands;
}

export function cloudBatchCommands(changes: { spec: ControlSpec; value: JsonValue }[], definitions: CloudFunctions, status: Record<string, JsonValue>) {
  const commands = new Map<string, JsonValue>();
  let inferredMode: JsonValue | undefined;
  const explicitMode = changes.find(change => change.spec.key === 'work_mode');
  for (const { spec, value } of changes) {
    for (const command of cloudCommands(spec, value, definitions)) {
      if (command.code === 'work_mode') inferredMode = command.value;
      else commands.set(command.code, command.value);
    }
  }
  const mode = explicitMode?.value ?? inferredMode;
  const result = [...commands].map(([code, value]) => ({ code, value }));
  if (mode !== undefined && (explicitMode || !sameValue(mode, status.work_mode ?? null))) result.unshift({ code: 'work_mode', value: mode });
  if (result.length > 16) throw new Error(t(MSG.UP_TO_16_PARAMETERS_CAN_BE_APPLIED_AT));
  return result;
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
