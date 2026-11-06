import { useMemo } from 'react';
import { skipToken } from '@reduxjs/toolkit/query';
import type { HomeApi } from './home-api';
import { localDeviceCache, localDeviceKey } from './local-device-cache';
import { useAppSelector } from './store';

export function useLocalDeviceState(api: HomeApi, deviceId?: number) {
  const select = useMemo(() => localDeviceCache.endpoints.deviceState.select(
    deviceId === undefined ? skipToken : localDeviceKey(api, deviceId)), [api, deviceId]);
  return useAppSelector(state => select(state).data?.reading);
}
