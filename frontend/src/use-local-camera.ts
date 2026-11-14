import { useCallback, useEffect, useMemo } from 'react';
import { ApiError } from './api';
import type { CloudApi } from './api';
import type { CameraControls } from './camera-service-api';
import { cameraScope, cameraStatusCache, retainCameraClient } from './camera-status-cache';
import { useAppDispatch, useAppSelector } from './store';

export default function useLocalCamera(api:CloudApi, deviceId:string, onAuthError:()=>void) {
  const dispatch = useAppDispatch();
  const scope = cameraScope(api);
  const select = useMemo(() => cameraStatusCache.endpoints.cameras.select(scope), [scope]);
  const query = useAppSelector(select);
  const active = !api.isMember && Boolean(deviceId);
  useEffect(() => {
    if (!active) return undefined;
    const release = retainCameraClient(api);
    const subscription = dispatch(cameraStatusCache.endpoints.cameras.initiate(scope, { subscriptionOptions: { pollingInterval: 5000 } }));
    return () => { subscription.unsubscribe(); release(); };
  }, [active, api, scope, dispatch]);
  useEffect(() => {
    if (active && query.error && 'status' in query.error && query.error.status === 401) onAuthError();
  }, [active, query.error, onAuthError]);
  const camera = active ? query.data?.cameras.find((row) => row.device_id === deviceId || row.id === deviceId) : undefined;
  const cameraId = camera?.id;
  const publish = useCallback((result:CameraControls) => {
    if (!cameraId) return;
    dispatch(cameraStatusCache.util.updateQueryData('cameras', scope, (current) => {
      const row = current.cameras.find((item) => item.id === cameraId);
      if (row && (row.lan.controls?.observed_at ?? 0) <= result.observed_at) {
        row.lan = { online: true, checked_at: Date.now() / 1000, controls: result };
      }
    }));
  }, [cameraId, dispatch, scope]);
  const command = useCallback(async (code:string, value:boolean|number|string) => {
    if (!cameraId) throw new Error('Local camera unavailable');
    try {
      const result = await api.localCameraCommand(cameraId, code, value);
      publish(result);
      if (result.confirmed === false) throw new ApiError('Camera did not confirm the setting', 409);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        dispatch(cameraStatusCache.util.updateQueryData('cameras', scope, (current) => {
          const row = current.cameras.find((item) => item.id === cameraId);
          if (row) row.lan = { ...row.lan, online: false, checked_at: Date.now() / 1000 };
        }));
      }
      throw error;
    }
  }, [api, cameraId, dispatch, publish, scope]);
  return {
    camera, loading: active && !query.data && !query.error, command, publish,
  };
}
