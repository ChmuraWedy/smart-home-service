import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query';
import { ApiError } from './api';
import type { CloudApi, CloudSnapshot, Provider } from './api';
import { cloudAccountScope } from './cloud-account-scope';
import { MSG, t } from './i18n';
import type { AppDispatch, RootState } from './store';

export type CloudDeviceKey = { scope: number; provider: Provider; deviceId: string };
type CacheEntry = { snapshot: CloudSnapshot; sequence: number; liveRequestAt?: number };
type ReadError = { message: string; status?: number };
type Reader = { api: CloudApi; readers: number };

let sequence = 0;
const clients = new Map<number, Reader>();

export function cloudDeviceKey(api: CloudApi, deviceId: string, provider: Provider): CloudDeviceKey {
  return { scope: cloudAccountScope(api, provider), deviceId, provider };
}

function checked(snapshot: CloudSnapshot, deviceId: string) {
  if (snapshot?.device_id !== deviceId || !snapshot.status || typeof snapshot.status !== 'object' || Array.isArray(snapshot.status)) {
    throw new Error(t(MSG.THE_SERVICE_RETURNED_UNEXPECTED_DEVICE_DATA));
  }
  return snapshot;
}

async function queryReading({ scope, deviceId, provider }: CloudDeviceKey, refresh: boolean, signal: AbortSignal) {
  const client = clients.get(scope);
  if (!client) return { error: { message: t(MSG.COULD_NOT_LOAD_DEVICES) } };
  const started = ++sequence;
  const liveRequestAt = refresh && provider === 'developer' ? Date.now() : undefined;
  try {
    const snapshot = checked(await client.api.deviceSnapshot(deviceId, provider, signal, refresh), deviceId);
    if (scope !== cloudAccountScope(client.api, provider)) throw new DOMException('Aborted', 'AbortError');
    return { data: { snapshot, sequence: started, liveRequestAt } };
  } catch (failure) {
    return { error: {
      message: failure instanceof Error ? failure.message : t(MSG.COULD_NOT_LOAD_DEVICES),
      status: failure instanceof ApiError ? failure.status : undefined,
    } };
  }
}

export const cloudDeviceCache = createApi({
  reducerPath: 'cloudDeviceCache',
  baseQuery: fakeBaseQuery<ReadError>(),
  keepUnusedDataFor: 15,
  endpoints: build => ({
    deviceSnapshot: build.query<CacheEntry, CloudDeviceKey>({
      queryFn: (key, { signal }) => queryReading(key, false, signal),
      merge(current, incoming) {
        if (incoming.sequence >= current.sequence) return incoming;
      },
    }),
    // A manual refresh may not join a cache-only poll already in flight.
    refreshSnapshot: build.query<CacheEntry, CloudDeviceKey>({
      queryFn: (key, { signal }) => queryReading(key, true, signal),
      keepUnusedDataFor: 0,
    }),
  }),
});

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export const readCloudDevice = (api: CloudApi, key: CloudDeviceKey, { refresh = false, signal, seed }: {
  refresh?: boolean; signal?: AbortSignal; seed?: CloudSnapshot;
} = {}) => async (dispatch: AppDispatch, getState: () => RootState): Promise<CloudSnapshot> => {
  const checkActive = () => {
    checkAborted(signal);
    if (key.scope !== cloudAccountScope(api, key.provider)) throw new DOMException('Aborted', 'AbortError');
  };
  checkActive();
  const select = cloudDeviceCache.endpoints.deviceSnapshot.select(key);
  const publish = (value: CacheEntry) => dispatch(cloudDeviceCache.util.upsertQueryEntries([
    { endpointName: 'deviceSnapshot', arg: key, value },
  ]));
  if (seed && !refresh) {
    const snapshot = select(getState()).data?.snapshot;
    if (snapshot) return snapshot;
    const value = { snapshot: checked(seed, key.deviceId), sequence: 0 };
    publish(value);
    return value.snapshot;
  }

  const client = clients.get(key.scope) ?? { api, readers: 0 };
  clients.set(key.scope, client);
  client.readers++;
  try {
    // Polls may use a pending fresh read. An older poll cannot replace its result.
    const fresh = refresh
      ? dispatch(cloudDeviceCache.endpoints.refreshSnapshot.initiate(key, { subscribe: false, forceRefetch: true }))
      : dispatch(cloudDeviceCache.util.getRunningQueryThunk('refreshSnapshot', key));
    const result = await (fresh ?? dispatch(cloudDeviceCache.endpoints.deviceSnapshot.initiate(key, { subscribe: false, forceRefetch: true })));
    checkActive();
    if (result.error) {
      const message = result.error.message ?? t(MSG.COULD_NOT_LOAD_DEVICES);
      throw 'status' in result.error && result.error.status !== undefined
        ? new ApiError(message, result.error.status) : new Error(message);
    }
    if (!result.data) throw new Error(t(MSG.COULD_NOT_LOAD_DEVICES));
    if (fresh) publish(result.data);
    return select(getState()).data?.snapshot ?? result.data.snapshot;
  } finally {
    if (--client.readers === 0) clients.delete(key.scope);
  }
};
