import { describe, expect, it } from 'vitest';
import { decodeInching, encodeInching } from './switch-inching';

describe('Tuya Inching records', () => {
  it('reads the Coffee machine report and retains the slot when enabling it', () => {
    const rows = decodeInching('AAAC', [1])!;
    expect(rows).toEqual([{ slot: 0, enabled: false, seconds: 2 }]);
    expect(encodeInching([{ ...rows[0], enabled: true, seconds: 60 }])).toBe('AQA8');
  });

  it('preserves the second channel while changing the first one', () => {
    const rows = decodeInching('AAA8AwA8', [1, 2])!;
    expect(rows).toEqual([
      { slot: 0, enabled: false, seconds: 60 },
      { slot: 1, enabled: true, seconds: 60 },
    ]);
    const edited = decodeInching(encodeInching([{ ...rows[0], seconds: 300 }, rows[1]]), [1, 2]);
    expect(edited).toEqual([{ ...rows[0], seconds: 300 }, rows[1]]);
  });

  it('rejects truncated, misaddressed and malformed records and initializes only an empty single-gang report', () => {
    expect(decodeInching('AAAC', [1, 2])).toBeUndefined();
    expect(decodeInching('AwAC', [3])).toBeUndefined();
    expect(decodeInching('invalid', [1])).toBeUndefined();
    expect(decodeInching('', [1, 2])).toBeUndefined();
    expect(decodeInching('', [1])).toEqual([]);
  });
});
