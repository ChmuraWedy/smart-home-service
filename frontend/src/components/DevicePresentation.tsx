import type { JsonValue } from '../api';
import type { ControlSpec } from '../controls';

export const batteryKeys = ['battery_percentage', 'battery_value', 'va_battery', 'battery', 'battery_state', 'battery_level'];
export const isBattery = (key: string) => batteryKeys.includes(key);
export type BatteryReading = { code: string; value: JsonValue; unit?: string | null };
export function ParameterIcon({ code }: { code: string }) {
  const path = /temperature|temp_/.test(code) ? 'M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0M12 8v10' : /humidity/.test(code) ? 'M12 3S5 11 5 15a7 7 0 0 0 14 0c0-4-7-12-7-12M9 16a3 3 0 0 0 3 3' : isBattery(code) ? 'M3 7h16v10H3zM21 10v4M6 10v4M9 10v4M12 10v4' : /motion|pir|presence/.test(code) ? 'M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M7 10l4-3 4 3 4 1M11 7l-2 7 4 3-1 5M9 14l-4 5' : 'M12 3v8M7 6a8 8 0 1 0 10 0';
  return <svg className="parameter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
export function BatteryBadge({ reading }: { reading?: BatteryReading | null }) {
  if (!reading || reading.value === null) return null;
  const value = typeof reading.value === 'string' ? ({low:'Низкий заряд',middle:'Средний заряд',medium:'Средний заряд',high:'Высокий заряд',full:'Полный заряд'}[reading.value] || reading.value) : String(reading.value);
  return <span className="battery-badge" aria-label={'Батарея: ' + value + (reading.unit ? ' ' + reading.unit : '')} title="Последнее известное показание батареи"><ParameterIcon code="battery" />{value}{reading.unit && ' ' + reading.unit}</span>;
}
export function batteryFromSpecs(specs: ControlSpec[], values: Record<string, JsonValue>) {
  const spec = specs.find(item => isBattery(item.key) && item.readable && values[item.key] !== undefined);
  return spec ? {code:spec.key,value:typeof values[spec.key] === 'number' ? Number(values[spec.key]) * (spec.factor ?? 1) : values[spec.key],unit:spec.unit} : undefined;
}
