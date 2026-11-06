import { useCallback, useEffect, useMemo } from 'react';
import type { CloudApi, CloudSnapshot, Provider } from './api';
import { cloudDeviceCache, cloudDeviceKey, readCloudDevice } from './cloud-device-cache';
import { useAppDispatch, useAppSelector } from './store';

export function useCloudDeviceSnapshot(api: CloudApi, deviceId: string, provider: Provider) {
  const { scope } = cloudDeviceKey(api, deviceId, provider);
  const key = useMemo(() => ({ scope, deviceId, provider }), [scope, deviceId, provider]);
  const select = useMemo(() => cloudDeviceCache.endpoints.deviceSnapshot.select(key), [key]);
  const reading = useAppSelector(state => select(state).data);
  const dispatch = useAppDispatch();
  const loaded = reading !== undefined;
  useEffect(() => {
    if (!loaded) return;
    // Keep the last reading while either surface is mounted, even without polling.
    const subscription = dispatch(cloudDeviceCache.endpoints.deviceSnapshot.initiate(key));
    return () => subscription.unsubscribe();
  }, [dispatch, key, loaded]);
  const read = useCallback((refresh: boolean, signal?: AbortSignal, seed?: CloudSnapshot) =>
    dispatch(readCloudDevice(api, key, { refresh, signal, seed })), [api, dispatch, key]);
  return { snapshot: reading?.snapshot, liveRequestAt: reading?.liveRequestAt, read };
}
