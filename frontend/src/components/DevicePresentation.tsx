import { t } from "../i18n";
import type { JsonValue } from '../api';
import type { ControlSpec } from '../controls';

export const batteryKeys = ['battery_percentage', 'battery_value', 'va_battery', 'battery', 'battery_state', 'battery_level'];
export const isBattery = (key: string) => batteryKeys.includes(key);
export type BatteryReading = { code: string; value: JsonValue; unit?: string | null };
export function ParameterIcon({ code }: { code: string }) {
  const path = /temperature|temp_/.test(code) ? 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0M12 8v10' : /humidity/.test(code) ? 'M12 3S5 11 5 15a7 7 0 0 0 14 0c0-4-7-12-7-12M9 16a3 3 0 0 0 3 3' : isBattery(code) ? 'M3 7h16v10H3zM21 10v4M6 10v4M9 10v4M12 10v4' : /motion|pir|presence/.test(code) ? 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M7 10l4-3 4 3 4 1M11 7l-2 7 4 3-1 5M9 14l-4 5' : /switch[1-9][0-9]*_value/.test(code) ? 'M6 4h12v16H6zM9 8h6v8H9z' : 'M12 3v8M7 6a8 8 0 1 0 10 0';
  return <svg className="parameter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
export function BatteryBadge({ reading }: { reading?: BatteryReading | null }) {
  if (!reading || reading.value === null) return null;
  const value = typeof reading.value === 'string' ? ({low:t("Низкий заряд"),middle:t("Средний заряд"),medium:t("Средний заряд"),high:t("Высокий заряд"),full:t("Полный заряд")}[reading.value] || reading.value) : String(reading.value);
  return <span className="battery-badge" aria-label={t("Батарея: ") + value + (reading.unit ? ' ' + reading.unit : '')} title={t("Последнее известное показание батареи")}><ParameterIcon code="battery" /><span className="battery-value">{value}{reading.unit && ' ' + reading.unit}</span></span>;
}
export function batteryFromSpecs(specs: ControlSpec[], values: Record<string, JsonValue>) {
  const spec = specs.find(item => isBattery(item.key) && item.readable && values[item.key] !== undefined);
  return spec ? {code:spec.key,value:typeof values[spec.key] === 'number' ? Number(values[spec.key]) * (spec.factor ?? 1) : values[spec.key],unit:spec.unit} : undefined;
}

export const isCamera = (category?: string) => category === 'sp' || category === 'dghsxj';
export const isLight = (category: string | undefined, codes: string[]) =>
  category === 'dj' || codes.some(code => /^(switch_led|bright_value(?:_v2)?|colour_data(?:_v2)?)$/.test(code));

// Use reported category/capability codes, never a guess from the device name.
export function DeviceIcon({ category, codes }: { category?: string; codes: string[] }) {
  let type = 'device', path = 'M5 3h14v18H5zM9 17h6';
  if (isCamera(category)) {
    type = 'camera'; path = 'M3 6h12v12H3zM15 10l6-3v10l-6-3M6 9h6';
  } else if (isLight(category, codes)) {
    type = 'light'; path = 'M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0l-1 3H9z';
  } else if (codes.some(code => /^(motion|pir|pir_state|presence_state)$/.test(code))) {
    type = 'motion'; path = 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M7 10l4-3 4 3 4 1M11 7l-2 7 4 3-1 5M9 14l-4 5';
  } else if (codes.some(code => /^(temperature|va_temperature|temp_current|humidity|va_humidity|humidity_value)$/.test(code))) {
    type = 'climate'; path = 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0M12 8v10';
  } else if (codes.some(code => /^switch_mode[1-9]|^switch[1-9][0-9]*_value$/.test(code))) {
    type = 'remote'; path = 'M7 2h10v20H7zM10 6h4M10 10h1M13 10h1M10 14h1M13 14h1M10 18h4';
  } else if (category === 'cz') {
    type = 'socket'; path = 'M4 3h16v18H4zM8 10h1M15 10h1M9 15h6M12 15v2';
  } else if (category === 'kg' || codes.some(code => /^switch(?:_[1-9][0-9]*)?$/.test(code))) {
    type = 'switch'; path = 'M4 3h16v18H4zM8 7h8v10H8zM12 9v3';
  }
  return <svg className="device-type-icon" data-device-type={type} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
