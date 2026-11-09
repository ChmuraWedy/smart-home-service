import { rawBytes } from './lighting';

export const maximumInchingSeconds = 65535;
export type InchingSetting = { slot: number; enabled: boolean; seconds: number };

export function validInchingSeconds(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= maximumInchingSeconds;
}

export function decodeInching(value: string, channels: readonly number[]): InchingSetting[] | undefined {
  // Tuya's single-gang format uses slot 0. An empty multi-gang report gives
  // no slot convention to preserve, so wait for a configured report.
  if (value === '' && channels.length === 1 && channels[0] === 1) {
    return [];
  }
  try {
    if (!channels.length || channels.length > 127) return undefined;
    const bytes = rawBytes(value, channels.length * 3);
    if (bytes.length !== channels.length * 3) return undefined;
    const data = new DataView(bytes.buffer);
    const rows = channels.map((_, index) => {
      const offset = index * 3;
      const header = bytes[offset];
      return { slot: Math.floor(header / 2), enabled: header % 2 === 1, seconds: data.getUint16(offset + 1) };
    });
    const matchesSlots = [0, 1].some((offset) => rows.every((row, index) => row.slot === channels[index] - offset));
    return matchesSlots && rows.every(({ seconds }) => validInchingSeconds(seconds)) ? rows : undefined;
  } catch {
    return undefined;
  }
}

export function encodeInching(rows: readonly InchingSetting[]): string {
  const bytes = new Uint8Array(rows.length * 3);
  const data = new DataView(bytes.buffer);
  rows.forEach(({ slot, enabled, seconds }, index) => {
    const offset = index * 3;
    bytes[offset] = slot * 2 + Number(enabled);
    data.setUint16(offset + 1, seconds);
  });
  return btoa(String.fromCharCode(...bytes));
}
