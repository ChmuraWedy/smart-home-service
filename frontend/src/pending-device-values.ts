import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { CloudApi, JsonValue, Provider } from './api';
import { cloudAccountScope } from './cloud-account-scope';
import { sameValue } from './controls';
import type { HomeApi, Reading } from './home-api';
import { localDeviceKey } from './local-device-cache';
import type { AppDispatch } from './store';

export const PENDING_READING_TIMEOUT_MS = 15_000;

type Target = {
  sequence: number;
  value: JsonValue;
  sentAt: number;
  baseline?: JsonValue;
  reportAt?: number;
  liveRequestAt?: number;
  protectsPrivacy: boolean;
};

type PendingValues = Record<string, { sequence: number; target?: Target; expired?: boolean; protectsPrivacy?: true } | undefined>;
type TargetIdentity = { key: string; sequence: number };

const initialState: PendingValues = {};
let nextSequence = 0;

export const localPendingScope = (api: HomeApi, deviceId: number) =>
  JSON.stringify(['local', localDeviceKey(api, deviceId).scope, deviceId]);
export const cloudPendingScope = (api: CloudApi, provider: Provider, deviceId: string) =>
  JSON.stringify([provider, cloudAccountScope(api, provider), deviceId]);
export const pendingValueKey = (scope: string, capability: string) => JSON.stringify([scope, capability]);

const pendingDeviceValues = createSlice({
  name: 'pendingDeviceValues',
  initialState,
  reducers: {
    accepted(state, { payload: { key, target } }: PayloadAction<{ key: string; target: Target }>) {
      if ((state[key]?.sequence ?? 0) >= target.sequence) return;
      state[key] = { sequence: target.sequence, target, ...(target.protectsPrivacy && { protectsPrivacy: true }) };
    },
    reported(state, { payload: { key, sequence } }: PayloadAction<TargetIdentity>) {
      // Retain the sequence until expiry so an older acknowledgement cannot revive a target.
      const current = state[key];
      if (current?.sequence !== sequence) return;
      delete current.target;
      delete current.expired;
    },
    expired(state, { payload: { key, sequence } }: PayloadAction<TargetIdentity>) {
      const current = state[key];
      if (current?.sequence !== sequence) return;
      // A timed-out privacy command is still unconfirmed. Keep playback blocked
      // until a new privacy reading arrives, while restoring the normal editor.
      if (current.protectsPrivacy) {
        // Privacy acknowledgements can outlast the visible wait. Keep only the
        // last sequence after reconciliation so an older one cannot block video.
        if (current.target) current.expired = true;
      } else delete state[key];
    },
  },
});

const { accepted, expired, reported } = pendingDeviceValues.actions;
export { reported as pendingReadingReported };
export const pendingDeviceValuesReducer = pendingDeviceValues.reducer;

function reportTime(reading?: Reading) {
  // Tuya may deliver an older observation later. Prefer the observation time
  // when the source provides it and fall back to receipt time.
  for (const stamp of [reading?.observed_at, reading?.received_at]) {
    const value = Date.parse(stamp ?? '');
    if (Number.isFinite(value)) return value;
  }
}

export function readingResolvesTarget(target: Target, reading?: Reading) {
  if (!reading?.known || reading.stale) return false;
  const reportedAt = reportTime(reading);
  if (reportedAt !== undefined) {
    // A newer physical reading supersedes the target, even for ticking timers
    // or when the device reports a different value than the requested one.
    return reportedAt >= target.sentAt && (target.reportAt === undefined || reportedAt > target.reportAt);
  }
  const liveRequestAt = target.protectsPrivacy ? reading.liveRequestAt : undefined;
  if (liveRequestAt !== undefined) {
    // A live Developer query can confirm the requested state without DP stamps.
    // After the wait expires, a new live query can also report a contrary state.
    return liveRequestAt >= target.sentAt && liveRequestAt > (target.liveRequestAt ?? -Infinity) &&
      (sameValue(reading.value, target.value) || liveRequestAt >= target.sentAt + PENDING_READING_TIMEOUT_MS);
  }
  // Untimestamped snapshots only resolve an observed transition to the target.
  return target.reportAt === undefined && sameValue(reading.value, target.value) &&
    target.baseline !== undefined && !sameValue(reading.value, target.baseline);
}

export function beginPendingValue(dispatch: AppDispatch, key: string, value: JsonValue, reading: Reading | undefined, protectsPrivacy: boolean) {
  const target: Target = {
    sequence: ++nextSequence,
    value,
    sentAt: Date.now(),
    baseline: reading?.known ? reading.value : undefined,
    reportAt: reportTime(reading),
    liveRequestAt: protectsPrivacy ? reading?.liveRequestAt : undefined,
    protectsPrivacy,
  };
  return () => {
    const remaining = target.sentAt + PENDING_READING_TIMEOUT_MS - Date.now();
    if (remaining <= 0 && !protectsPrivacy) return;
    dispatch(accepted({ key, target }));
    const finish = () => dispatch(expired({ key, sequence: target.sequence }));
    if (remaining <= 0) finish();
    else setTimeout(finish, remaining);
  };
}
