import { MSG, t } from "../i18n";
import type { JsonValue } from '../api';
import type { ControlSpec } from '../controls';
import { IconSvg } from './ui/icon';

export const batteryKeys = ['battery_percentage', 'battery_value', 'va_battery', 'battery', 'battery_state', 'battery_level'];
export const isBattery = (key: string) => batteryKeys.includes(key);
export type BatteryReading = { code: string; value: JsonValue; unit?: string | null };
export function ParameterIcon({ code }: { code: string }) {
  const path = code === 'brightness' ? 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 3v2M12 19v2M3 12h2M19 12h2M6 6l1.4 1.4m9.2 9.2L18 18M6 18l1.4-1.4m9.2-9.2L18 6'
    : code === 'color' ? 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h3a3 3 0 0 0 3-3c0-4.7-4-8.5-9-8.5zM7.5 10.5h.01M10.5 7.5h.01M15 7.5h.01M17 11h.01'
    : /temperature|temp_/.test(code) ? 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0M12 8v10' : /humidity/.test(code) ? 'M12 3S5 11 5 15a7 7 0 0 0 14 0c0-4-7-12-7-12M9 16a3 3 0 0 0 3 3' : isBattery(code) ? 'M3 7h16v10H3zM21 10v4M6 10v4M9 10v4M12 10v4' : /motion|pir|presence/.test(code) ? 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M7 10l4-3 4 3 4 1M11 7l-2 7 4 3-1 5M9 14l-4 5' : /switch[1-9][0-9]*_value/.test(code) ? 'M6 4h12v16H6zM9 8h6v8H9z' : 'M12 3v8M7 6a8 8 0 1 0 10 0';
  return <IconSvg className="parameter-icon"><path d={path} /></IconSvg>;
}
export function BatteryBadge({ reading }: { reading?: BatteryReading | null }) {
  if (!reading || reading.value === null) return null;
  const value = typeof reading.value === 'string' ? ({low:t(MSG.LOW_BATTERY),middle:t(MSG.MEDIUM_BATTERY),medium:t(MSG.MEDIUM_BATTERY),high:t(MSG.HIGH_BATTERY),full:t(MSG.FULL_BATTERY)}[reading.value] || reading.value) : String(reading.value);
  return <span className="battery-badge" aria-label={t(MSG.BATTERY_PREFIX) + value + (reading.unit ? ' ' + reading.unit : '')} title={t(MSG.LAST_KNOWN_BATTERY_READING)}><ParameterIcon code="battery" /><span className="battery-value">{value}{reading.unit && ' ' + reading.unit}</span></span>;
}
export function batteryFromSpecs(specs: ControlSpec[], values: Record<string, JsonValue>) {
  const spec = specs.find(item => isBattery(item.key) && item.readable && values[item.key] !== undefined);
  return spec ? {code:spec.key,value:typeof values[spec.key] === 'number' ? Number(values[spec.key]) * (spec.factor ?? 1) : values[spec.key],unit:spec.unit} : undefined;
}

export const isCamera = (category?: string) => category === 'sp' || category === 'dghsxj';
const isLight = (category: string | undefined, codes: string[]) =>
  category === 'dj' || codes.some(code => /^(switch_led|bright_value(?:_v2)?|colour_data(?:_v2)?)$/.test(code));

type DeviceIconProps =
  | { group: true; category?: never; codes?: never }
  | { group?: false; category?: string; codes: string[] };

// Use reported category/capability codes, never a guess from the device name.
export function DeviceIcon({ category, codes, group }: DeviceIconProps) {
  let type = 'device', path = 'M5 3h14v18H5zM9 17h6';
  if (group) {
    type = 'group';
  } else if (isCamera(category)) {
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
  return <IconSvg className="device-type-icon" deviceType={type}>
    {group ? <>
      <rect
        x="3"
        y="3"
        width="7"
        height="7"
        rx="1.5"
      />
      <rect
        x="14"
        y="3"
        width="7"
        height="7"
        rx="1.5"
      />
      <rect
        x="3"
        y="14"
        width="7"
        height="7"
        rx="1.5"
      />
      <rect
        x="14"
        y="14"
        width="7"
        height="7"
        rx="1.5"
      />
    </> : <path d={path} />}
  </IconSvg>;
}
