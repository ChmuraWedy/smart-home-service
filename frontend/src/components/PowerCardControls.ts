import { useEffect } from 'react';
import type { ControlSpec } from '../controls';
import type { Reading } from '../home-api';

export type MemberPower = 'on' | 'off' | 'mixed' | 'unknown';
type SupplyPower = false | null | undefined;

function isPowerControl(spec: ControlSpec) {
  return spec.writable && spec.kind === 'boolean' && /^(switch|switch_led|switch_[1-9][0-9]*)$/.test(spec.key);
}

function reportedPower(readings: (Reading | undefined)[], supply: SupplyPower): MemberPower {
  if (supply === false) return 'off';
  if (supply === null || !readings.length || readings.some((reading) => !reading?.known || typeof reading.value !== 'boolean')) {
    return 'unknown';
  }
  if (readings.every((reading) => reading?.value === true)) return 'on';
  if (readings.every((reading) => reading?.value === false)) return 'off';
  return 'mixed';
}

export function usePowerCardControls({
  specs, read, online, supply, onPower,
}: {
  specs: ControlSpec[];
  read: (spec: ControlSpec) => Reading | undefined;
  online: boolean;
  supply: SupplyPower;
  onPower?: (power: MemberPower) => void;
}) {
  const powers = specs.filter(isPowerControl);
  let layout: 'single' | 'channels' | undefined;
  if (powers.length) layout = powers.length === 1 && !powers[0].aliases?.length ? 'single' : 'channels';
  const state = reportedPower(online ? powers.map(read) : [], supply);

  useEffect(() => {
    onPower?.(state);
  }, [onPower, state]);

  return { powers, layout };
}

export function powerDisplayOverride(reading: Reading | undefined, online: boolean, supply: SupplyPower) {
  if (supply !== undefined || online) return supply;
  return reading?.known && typeof reading.value === 'boolean' ? reading.value : null;
}
