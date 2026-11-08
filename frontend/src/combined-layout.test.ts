import { describe, expect, it } from 'vitest';
import combinedLayout from './combined-layout';
import type { CombinedMemberInput, CombinedPowerSource } from './home-api';

function entry(deviceId: string, powerSource?: CombinedPowerSource): { member: CombinedMemberInput } {
  return { member: { device_id: deviceId, route: 'sharing', power_source: powerSource } };
}

describe('combined card layout', () => {
  it('keeps channels on different relays separate and retains nested devices', () => {
    const firstRelay = entry('first');
    const secondRelay = entry('second', { device_id: 'first', channel: 'switch_1' });
    const firstLamp = entry('first-lamp', { device_id: 'first', channel: 'switch_1' });
    const secondLamp = entry('second-lamp', { device_id: 'second', channel: 'switch_1' });
    const { roots, channels } = combinedLayout([secondLamp, firstLamp, secondRelay, firstRelay]);
    expect(roots).toEqual([firstRelay]);
    expect(channels.get('first')?.get('switch_1')).toEqual([firstLamp, secondRelay]);
    expect(channels.get('second')?.get('switch_1')).toEqual([secondLamp]);
  });

  it('keeps devices visible when an unsaved draft has a loop or missing relay', () => {
    const draft = [
      entry('first', { device_id: 'second', channel: 'switch_1' }),
      entry('second', { device_id: 'first', channel: 'switch_1' }),
      entry('lamp', { device_id: 'missing', channel: 'switch_1' }),
    ];
    const { roots, channels } = combinedLayout(draft);
    expect(roots).toEqual(draft);
    expect(channels.size).toBe(0);
  });
});
