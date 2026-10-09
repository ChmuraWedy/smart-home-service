import { describe, expect, it } from 'vitest';
import { cloudCommands, cloudReading, cloudSpec, cloudSpecs, displayReading, hexToHsv, hsvToHex, isStale, localSpec, motionState, optionLabel, validateControlValue } from './controls';
import type { CloudFunction, CloudFunctions } from './api';

const fn = (code: string, type: string, values: unknown = {}): CloudFunction => ({ code, type, values: JSON.stringify(values) });
const definitions = (functions: CloudFunction[]): CloudFunctions => ({ device_id: 'lamp', functions });
const mode = fn('work_mode', 'Enum', { range: ['white', 'colour'] });

describe('metadata-driven controls', () => {
  it('localizes relay settings without translating command values or unrelated enums', () => {
    const relay = fn('relay_status', 'Enum', { range: ['power_off', 'power_on', 'last'] });
    const spec = cloudSpec(relay, true);
    expect(displayReading(spec, cloudReading(spec, 'last'))).toBe('Восстановить предыдущее состояние');
    expect(optionLabel('power_on', spec.key)).toBe('Включено');
    expect(optionLabel('last', 'custom_mode')).toBe('last');
    expect(cloudCommands(spec, 'power_off', definitions([relay]))).toEqual([{ code: 'relay_status', value: 'power_off' }]);
    const timer = fn('countdown_2', 'Integer', { min: 0, max: 86400, step: 1, scale: 0, unit: 's' });
    const timerSpec = cloudSpec(timer, true);
    expect(timerSpec.label).toBe('Таймер канала 2');
    expect(displayReading(timerSpec, cloudReading(timerSpec, 60))).toBe('60 с');
    expect(cloudCommands(timerSpec, 60, definitions([timer]))).toEqual([{ code: 'countdown_2', value: 60 }]);
  });
  it.each(['music_data', 'control_data'])('does not turn %s command echoes into observed state', code => {
    for (const type of ['Json', 'String']) {
      const spec = cloudSpec(fn(code, type), true);
      expect(spec.readable).toBe(false);
      expect(spec.writable).toBe(true);
      for (const raw of ['', '{"h":120,"s":255,"v":255}', { h: 120, s: 255, v: 255 }]) {
        expect(cloudReading(spec, raw)).toEqual({ value: null, known: false, stale: true });
      }
    }
    // The same shape under a custom code has no documented send-only semantics.
    expect(cloudSpec(fn('custom_effect', 'Json'), true).readable).toBe(true);
  });
  it.each(['colour_data', 'colour_data_v2'])('encodes %s from normalized HSV and batches the actual supported mode', code => {
    const spec = cloudSpec(fn(code, 'Json'), true);
    const maximum = code === 'colour_data' ? 255 : 1000;
    expect(cloudCommands(spec, { h: 120, s: 1000, v: 1000 }, definitions([fn(code, 'Json'), mode]))).toEqual([
      { code: 'work_mode', value: 'colour' }, { code, value: { h: 120, s: maximum, v: maximum } },
    ]);
    expect(cloudReading(spec, JSON.stringify({ h: 120, s: maximum, v: maximum })).value).toEqual({ h: 120, s: 1000, v: 1000 });
  });
  it('respects advertised HSV maxima and does not invent mode or color encoding for custom JSON/String', () => {
    const color = fn('colour_data_v2', 'Json', { h: { min: 0, max: 360 }, s: { min: 0, max: 255 }, v: { min: 0, max: 255 } });
    expect(cloudCommands(cloudSpec(color, true), { h: 120, s: 1000, v: 1000 }, definitions([color]))).toEqual([{ code: color.code, value: { h: 120, s: 255, v: 255 } }]);
    expect(cloudSpec(fn('colour_data_v2', 'String'), true).kind).toBe('text');
    expect(cloudSpec(fn('colour_data_v2', 'Json', { custom: true }), true).kind).toBe('json');
    expect(cloudSpec(fn('scene_data', 'Json'), true).kind).toBe('json');
  });
  it.each([['bright_value', 25, 255, 200], ['bright_value_v2', 10, 1000, 650], ['temp_value_v2', 0, 1000, 500]] as const)('round trips %s percentage using its own range', (code, min, max, raw) => {
    const brightness = fn(code, 'Integer', { min, max, step: 1, scale: 0 });
    const spec = cloudSpec(brightness, true);
    const value = cloudReading(spec, raw).value;
    expect(cloudCommands(spec, value, definitions([brightness, mode]))).toEqual([{ code: 'work_mode', value: 'white' }, { code, value: raw }]);
    expect(spec.unit).toBe('%');
  });
  it('scales temperature and step and rejects invalid increments without a command', () => {
    const target = fn('temp_set', 'Integer', { min: 50, max: 350, step: 5, scale: 1, unit: '°C' });
    const spec = cloudSpec(target, true);
    expect(cloudReading(spec, 225).value).toBe(22.5);
    expect(cloudCommands(spec, 22.5, definitions([target]))).toEqual([{ code: 'temp_set', value: 225 }]);
    for (const value of [22.3, 40, true, NaN]) expect(() => validateControlValue(spec, value)).toThrow();
  });
  it('does not turn read-only sensor status into a writable function', () => {
    const temp = fn('temp_current', 'Integer', { min: -400, max: 800, step: 1, scale: 1, unit: '°C' });
    const specs = cloudSpecs({ ...definitions([]), status_range: [temp] }, { device_id: 'lamp', online: true, source: 'cloud', status: { temp_current: 215, motion: false } });
    expect(specs.every(spec => !spec.writable)).toBe(true);
    expect(cloudSpec(fn('temp_current', 'Integer', { scale:1, unit:'°C' }), false).reason).toBeUndefined();
    expect(displayReading(specs[0], cloudReading(specs[0], 215))).toBe('21.5 °C');
    expect(() => cloudCommands(specs[0], 20, definitions([]))).toThrow('чтения');
  });
  it('disables malformed numeric/enum/raw metadata instead of guessing limits', () => {
    for (const spec of [cloudSpec(fn('bright', 'Integer', { min: 20 }), true), cloudSpec(fn('mode', 'Enum', { range: 'white' }), true), cloudSpec(fn('raw', 'Raw', {maxlen:-1}), true), cloudSpec(fn('unknown', 'Custom'), true)]) expect(spec.writable).toBe(false);
    expect(cloudReading(cloudSpec(fn('switch', 'Boolean'), true), 'false').known).toBe(false);
    expect(cloudReading(cloudSpec(fn('temp', 'Integer'), false), false).known).toBe(false);
  });
  it('preserves enum value types and generic JSON object validation', () => {
    const spec = localSpec('mode', { type: 'integer', readable: true, writable: true, enum: [0, 1] });
    expect(() => validateControlValue(spec, 0)).not.toThrow();
    expect(() => validateControlValue(spec, '0')).toThrow();
    const object = localSpec('custom', { type: 'object', encoding: 'raw', readable: true, writable: true });
    expect(() => validateControlValue(object, { nested: [1, false] })).not.toThrow();
    expect(() => validateControlValue(object, [])).toThrow();
  });
  it('never renders unknown motion as false and expires local observations in the browser', () => {
    const spec = localSpec('motion', { type: 'boolean', readable: true, writable: false });
    expect(displayReading(spec, { known: false, stale: true, value: false })).toBe('Нет данных');
    const reading = { known: true, stale: false, value: false, observed_at: '2026-10-08T10:00:00Z' };
    expect(isStale(reading, Date.parse('2026-10-08T10:00:59Z'), true)).toBe(false);
    expect(isStale(reading, Date.parse('2026-10-08T10:01:01Z'), true)).toBe(true);
    expect(isStale({ ...reading, observed_at: undefined }, Date.now(), true)).toBe(true);
  });
  it.each(['pir', 'pir_state'])('decodes read-only %s without turning unknown or absent values into no motion', key => {
    const spec = cloudSpec(fn(key, 'Enum', { range: ['pir', 'none'] }), false);
    expect(displayReading(spec, cloudReading(spec, 'pir'))).toBe('Движение обнаружено');
    expect(displayReading(spec, cloudReading(spec, 'none'))).toBe('Движения нет');
    expect(spec.writable).toBe(false);
    for (const raw of [undefined, null, 'unknown', 'presence', 0, 1, false, true]) {
      const reading = cloudReading(spec, raw);
      expect(reading.known).toBe(false);
      expect(motionState(spec, reading)).toBeNull();
      expect(displayReading(spec, reading)).toBe('Нет данных');
    }
    const other = cloudSpec(fn('mode', 'Enum', { range: ['pir', 'none'] }), false);
    expect(displayReading(other, cloudReading(other, 'none'))).toBe('none');
    const local = localSpec('motion', { type: 'boolean', readable: true, writable: false });
    expect(displayReading(local, { value: false, known: true, stale: false })).toBe('Движения нет');
  });
  it('keeps the actual unitless legacy battery value instead of inventing a percentage', () => {
    const spec = cloudSpec(fn('battery', 'Integer', { unit: '', min: 0, max: 500, scale: 0, step: 1 }), false);
    expect(displayReading(spec, cloudReading(spec, 90))).toBe('90');
    expect(spec.unit).toBe('');
    expect(spec.help).toBe('Единица измерения не указана устройством.');
    const percentage = cloudSpec(fn('battery_percentage', 'Integer', { unit: '%', min: 0, max: 100, scale: 0, step: 1 }), false);
    expect(displayReading(percentage, cloudReading(percentage, 90))).toBe('90 %');
    expect(percentage.help).toBeUndefined();
  });
  it.each([['#ff0000', { h: 0, s: 1000, v: 1000 }], ['#00ff00', { h: 120, s: 1000, v: 1000 }], ['#0000ff', { h: 240, s: 1000, v: 1000 }], ['#000000', { h: 0, s: 0, v: 0 }]])('uses independent RGB/HSV vectors for %s', (hex, hsv) => {
    expect(hexToHsv(hex as string)).toEqual(hsv);
    expect(hsvToHex(hsv as { h: number; s: number; v: number })).toBe(hex);
  });
});
