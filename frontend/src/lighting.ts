import { t } from "./i18n";
import type { JsonValue } from './api';

export type JsonSchema = Record<string, Record<string, unknown>>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function editableSchema(value: unknown, depth = 0): JsonSchema | undefined {
  if (!object(value) || !Object.keys(value).length || depth > 3) return;
  for (const [key, rule] of Object.entries(value)) {
    if (!object(rule)) return;
    if ('range' in rule) { if (!Array.isArray(rule.range) || !rule.range.length || !rule.range.every(v => typeof v === 'string')) return; }
    else if ('min' in rule || 'max' in rule) {
      if (!Number.isInteger(rule.min) || !Number.isInteger(rule.max) || Number(rule.min) > Number(rule.max) || (rule.scale ?? 0) !== 0 || (rule.step !== undefined && (!Number.isInteger(rule.step) || Number(rule.step) < 1))) return;
    } else if (!editableSchema(rule, depth + 1) || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) return;
  }
  return value as JsonSchema;
}

export function defaultObject(schema: JsonSchema): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(schema).map(([key, rule]) => [key,
    Array.isArray(rule.range) ? String(rule.range[0]) : typeof rule.min === 'number' ? rule.min : ['scene_units','nodes'].includes(key) ? [defaultObject(rule as JsonSchema)] : defaultObject(rule as JsonSchema),
  ]));
}

export function validateObject(value: JsonValue, schema: JsonSchema): void {
  if (!object(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(schema).sort())) throw new Error(t("Заполните все поля команды устройства."));
  for (const [key, rule] of Object.entries(schema)) {
    const current = value[key];
    if (Array.isArray(rule.range)) { if (!rule.range.includes(String(current)) || typeof current !== 'string') throw new Error(t("Недопустимый режим эффекта.")); }
    else if (typeof rule.min === 'number' && typeof rule.max === 'number') {
      if (!Number.isInteger(current) || Number(current) < rule.min || Number(current) > rule.max || (Number(current) - rule.min) % Number(rule.step || 1)) throw new Error(t("Значение эффекта вне допустимого диапазона или шага."));
    } else if (['scene_units','nodes'].includes(key)) {
      if (!Array.isArray(current) || (key === 'scene_units' && !current.length) || current.length > 32) throw new Error(t("Недопустимое количество шагов."));
      for (const unit of current) validateObject(unit, rule as JsonSchema);
    } else validateObject(current as JsonValue, rule as JsonSchema);
  }
}

export function rawBytes(value: string, maximum = 16384): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(t("Некорректные данные производителя (base64)."));
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (bytes.length > maximum) throw new Error(t("Данные производителя превышают допустимый размер."));
  return bytes;
}

export type PowerMemory = { mode: number; h: number; s: number; v: number; bright: number; temperature: number };
export function decodePowerMemory(value: string): PowerMemory | undefined {
  try {
    const bytes = rawBytes(value);
    if (bytes.length !== 12 || bytes[0] !== 0 || bytes[1] > 2) return;
    const view = new DataView(bytes.buffer);
    const result = { mode: bytes[1], h: view.getUint16(2), s: view.getUint16(4), v: view.getUint16(6), bright: view.getUint16(8), temperature: view.getUint16(10) };
    if (result.h > 360 || [result.s, result.v, result.bright, result.temperature].some(v => v > 1000)) return;
    return result;
  } catch { return; }
}
export function encodePowerMemory(value: PowerMemory): string {
  if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 2 || !Number.isInteger(value.h) || value.h < 0 || value.h > 360 || [value.s,value.v,value.bright,value.temperature].some(v => !Number.isInteger(v) || v < 0 || v > 1000)) throw new Error(t("Некорректное состояние после включения питания."));
  const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
  bytes[1] = value.mode;
  [value.h,value.s,value.v,value.bright,value.temperature].forEach((v,i) => view.setUint16(2+i*2,v));
  return btoa(String.fromCharCode(...bytes));
}
