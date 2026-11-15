import { copyWithStructuralSharing, createApi, fakeBaseQuery } from '@reduxjs/toolkit/query';
import { ApiError } from './api';
import type { CloudApi, CloudSnapshot, Provider } from './api';
import { cloudAccountScope } from './cloud-account-scope';
import { MSG, t } from './i18n';
import type { AppDispatch, RootState } from './store';

export type CloudDeviceKey = { scope: number; provider: Provider; deviceId: string; watch?: boolean };
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

async function queryReading({
  scope, deviceId, provider, watch,
}: CloudDeviceKey, refresh: boolean, signal: AbortSignal) {
  const client = clients.get(scope);
  if (!client) return { error: { message: t(MSG.COULD_NOT_LOAD_DEVICES) } };
  const started = ++sequence;
  const liveRequestAt = refresh && provider === 'developer' ? Date.now() : undefined;
  try {
    const snapshot = checked(await client.api.deviceSnapshot(deviceId, provider, signal, refresh, watch), deviceId);
    if (scope !== cloudAccountScope(client.api, provider)) throw new DOMException('Aborted', 'AbortError');
    return { data: { snapshot, sequence: started, liveRequestAt } };
  } catch (failure) {
    return {
      error: {
        message: failure instanceof Error ? failure.message : t(MSG.COULD_NOT_LOAD_DEVICES),
        status: failure instanceof ApiError ? failure.status : undefined,
      },
    };
  }
}

export const cloudDeviceCache = createApi({
  reducerPath: 'cloudDeviceCache',
  baseQuery: fakeBaseQuery<ReadError>(),
  keepUnusedDataFor: 15,
  endpoints: (build) => ({
    deviceSnapshot: build.query<CacheEntry, CloudDeviceKey>({
      serializeQueryArgs: ({ queryArgs: { scope, provider, deviceId } }) => ({ scope, provider, deviceId }),
      queryFn: (key, { signal }) => queryReading(key, false, signal),
      merge(current, incoming) {
        if (incoming.sequence < current.sequence) return undefined;
        return { ...incoming, snapshot: copyWithStructuralSharing(current.snapshot, incoming.snapshot) };
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

type Observation = NonNullable<CloudSnapshot['status_observations']>[string];

function observationTime(observation?: Observation) {
  const observedAt = Date.parse(observation?.observed_at ?? '');
  return Number.isFinite(observedAt) ? observedAt : Date.parse(observation?.received_at ?? '');
}

function reconcileSharingInventory(current: CloudSnapshot, seed: CloudSnapshot) {
  const newerSnapshot = Date.parse(seed.snapshot_received_at ?? '') > Date.parse(current.snapshot_received_at ?? '');
  const currentReports = current.status_observations ?? {};
  const seedReports = seed.status_observations ?? {};
  const newerReports = Object.entries(seedReports).filter(([code, incoming]) => {
    const previous = observationTime(currentReports[code]);
    const received = observationTime(incoming);
    return Object.hasOwn(seed.status, code) && Number.isFinite(received) && (!Number.isFinite(previous) || received > previous);
  });
  if (!newerSnapshot && newerReports.length === 0) return current;

  const snapshotValues = newerSnapshot ? Object.entries(seed.status).filter(([code]) => !Object.hasOwn(currentReports, code) && !Object.hasOwn(seedReports, code)) : [];
  // Inventory can carry a newer privacy report alongside older readings for other controls.
  return {
    ...current,
    ...(newerSnapshot ? seed : {}),
    status: {
      ...current.status,
      ...Object.fromEntries(snapshotValues),
      ...Object.fromEntries(newerReports.map(([code]) => [code, seed.status[code]])),
    },
    status_observations: { ...currentReports, ...Object.fromEntries(newerReports) },
  };
}

export const readCloudDevice = (api: CloudApi, key: CloudDeviceKey, {
  refresh = false, signal, seed, watch = false,
}: {
  refresh?: boolean; signal?: AbortSignal; seed?: CloudSnapshot; watch?: boolean;
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
    const current = select(getState()).data?.snapshot;
    if (current && key.provider !== 'sharing') return current;
    const inventory = checked(seed, key.deviceId);
    const snapshot = current ? reconcileSharingInventory(current, inventory) : inventory;
    if (snapshot === current) return snapshot;
    const value = { snapshot, sequence: current ? ++sequence : 0 };
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
    const result = await (fresh ?? dispatch(cloudDeviceCache.endpoints.deviceSnapshot.initiate({ ...key, watch }, { subscribe: false, forceRefetch: true })));
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

// A rejected offline command is availability evidence, never a relay-state report.
type DeviceCommands = Parameters<CloudApi['sendDeviceCommands']>[2];
export const sendCloudDeviceCommands = (api:CloudApi, deviceId:string, provider:Provider, commands:DeviceCommands) => async (dispatch:AppDispatch, getState:()=>RootState) => {
  const key = cloudDeviceKey(api, deviceId, provider);
  try {
    return await api.sendDeviceCommands(deviceId, provider, commands);
  } catch (failure) {
    if (failure instanceof ApiError && failure.deviceOffline && key.scope === cloudAccountScope(api, provider)) {
      const current = cloudDeviceCache.endpoints.deviceSnapshot.select(key)(getState()).data;
      if (current) {
        dispatch(cloudDeviceCache.util.upsertQueryEntries([{
          endpointName: 'deviceSnapshot',
          arg: key,
          value: { ...current, sequence: sequence += 1, snapshot: { ...current.snapshot, online: false } },
        }]));
      }
    }
    throw failure;
  }
};
