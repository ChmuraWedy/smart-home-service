import { useCallback, useEffect, useRef } from 'react';
import type { JsonValue } from './api';
import type { Reading } from './home-api';
import { beginPendingValue, pendingReadingReported, pendingValueKey, readingResolvesTarget } from './pending-device-values';
import { useAppDispatch, useAppSelector } from './store';

export function usePendingPrivacyState(scope: string, reported: boolean | null | undefined) {
  const key = pendingValueKey(scope, 'basic_private');
  const pending = useAppSelector(state => state.pendingDeviceValues[key]?.target);
  return pending ? (pending.value === true ? true : null) : reported;
}

export function usePendingDeviceValue(scope: string, capability: string, reading?: Reading) {
  const dispatch = useAppDispatch();
  const key = pendingValueKey(scope, capability);
  const pending = useAppSelector(state => state.pendingDeviceValues[key]);
  const target = pending?.target;
  const latestReading = useRef(reading);
  latestReading.current = reading;

  useEffect(() => {
    if (target && readingResolvesTarget(target, reading)) {
      dispatch(pendingReadingReported({ key, sequence: target.sequence }));
    }
  }, [dispatch, key, reading, target]);

  const begin = useCallback((value: JsonValue) =>
    beginPendingValue(dispatch, key, value, latestReading.current, capability === 'basic_private'), [capability, dispatch, key]);
  return { target: pending?.expired ? undefined : target, begin };
}
