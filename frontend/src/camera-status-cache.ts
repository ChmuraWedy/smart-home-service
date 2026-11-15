import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query';
import type { CloudApi } from './api';
import type { CameraControls, LocalCamera } from './camera-service-api';
import { cloudAccountScope } from './cloud-account-scope';

export type CameraStatus = LocalCamera & {
  lan:{online?:boolean|null;'checked_at'?:number;controls?:CameraControls};
  announcement?:{'observed_ip':string|null;'last_seen':string|null};
};
type ReadError = {message:string; 'status'?:number};
const clients = new Map<number, {api:CloudApi;readers:number}>();
export function cameraScope(api:CloudApi) { return cloudAccountScope(api, 'sharing'); }
export function retainCameraClient(api:CloudApi) {
  const scope = cameraScope(api);
  const client = clients.get(scope) ?? { api, readers: 0 };
  client.readers += 1; clients.set(scope, client);
  return () => { client.readers -= 1; if (client.readers === 0)clients.delete(scope); };
}
export const cameraStatusCache = createApi({
  reducerPath: 'cameraStatusCache',
  baseQuery: fakeBaseQuery<ReadError>(),
  keepUnusedDataFor: 0,
  endpoints: (build) => ({
    cameras: build.query<{cameras:CameraStatus[]}, number>({
      merge(current, incoming) {
        const cameras = incoming.cameras.map((row) => {
          const previous = current.cameras.find((item) => item.id === row.id);
          return previous && (previous.lan.checked_at ?? 0) > (row.lan.checked_at ?? 0) ? { ...row, lan: previous.lan } : row;
        });
        return { cameras };
      },
      async queryFn(scope) {
        const client = clients.get(scope);
        if (!client) return { error: { message: 'Camera status unavailable' } };
        try {
          const value = await client.api.localCameraStatus();
          if (scope !== cameraScope(client.api)) return { error: { message: 'Camera session changed' } };
          if (!Array.isArray(value?.cameras)) return { data: { cameras: [] } };
          return { data: value };
        } catch (error) {
          const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
          return { error: { message: error instanceof Error ? error.message : 'Camera status unavailable', status } };
        }
      },
    }),
  }),
});
export function localCameraEntry(state:{cameraStatusCache:ReturnType<typeof cameraStatusCache.reducer>}, api:CloudApi, id:string) {
  return cameraStatusCache.endpoints.cameras.select(cameraScope(api))(state).data?.cameras.find((row) => row.device_id === id || row.id === id);
}
export function localCameraOnline(row:CameraStatus|undefined, now = Date.now()) {
  if (!row?.controls_available) return undefined;
  return typeof row.lan.online === 'boolean' && now / 1000 - (row.lan.checked_at ?? 0) < 15 ? row.lan.online : undefined;
}
