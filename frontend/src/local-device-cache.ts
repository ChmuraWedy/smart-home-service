import { copyWithStructuralSharing, createApi, fakeBaseQuery } from '@reduxjs/toolkit/query';
import { ApiError } from './api';
import type { CloudApi, JsonValue } from './api';
import { sameValue } from './controls';
import type { DeviceState, HomeApi } from './home-api';
import { MSG, t } from './i18n';
import type { AppDispatch, RootState } from './store';

type DeviceKey = { scope: number; deviceId: number };
type CacheEntry = { reading: DeviceState; sequence: number };
type ReadError = { message: string; status?: number };

// Cache keys contain only an opaque connection scope and the numeric device ID.
const scopes = new WeakMap<CloudApi, number>();
let nextScope = 0;
let nextSequence = 0;
const clients = new Map<number, { api: HomeApi; readers: number }>();

export function localDeviceKey(api: CloudApi, deviceId: number): DeviceKey {
  let scope = scopes.get(api);
  if (scope === undefined) {
    scope = ++nextScope;
    scopes.set(api, scope);
  }
  return { scope, deviceId };
}

async function fetchReading(api: HomeApi, deviceId: number, refresh: boolean, signal?: AbortSignal, watch = false): Promise<CacheEntry> {
  const sequence = ++nextSequence;
  const reading = await api.state(deviceId, refresh, signal, watch);
  if (reading.device_id !== deviceId) throw new Error(t(MSG.THE_SERVICE_RETURNED_A_DIFFERENT_DEVICE));
  return { reading, sequence };
}

export const localDeviceCache = createApi({
  reducerPath: 'localDeviceCache',
  baseQuery: fakeBaseQuery<ReadError>(),
  keepUnusedDataFor: 15,
  endpoints: (build) => ({
    deviceState: build.query<CacheEntry, DeviceKey>({
      async queryFn({ scope, deviceId }, { signal }) {
        const client = clients.get(scope);
        if (!client) return { error: { message: t(MSG.COULD_NOT_LOAD_DEVICES) } };
        try {
          return { data: await fetchReading(client.api, deviceId, false, signal) };
        } catch (failure) {
          return {
            error: {
              message: failure instanceof Error ? failure.message : t(MSG.COULD_NOT_LOAD_DEVICES),
              status: failure instanceof ApiError ? failure.status : undefined,
            },
          };
        }
      },
      merge(current, incoming) {
        // A slow initial cache read must not overwrite a newer watch or refresh.
        if (incoming.sequence < current.sequence) return undefined;
        return { ...incoming, reading: copyWithStructuralSharing(current.reading, incoming.reading) };
      },
    }),
  }),
});

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export function readLocalDevice(api: HomeApi, deviceId: number, refresh = false, signal?: AbortSignal, watch = false) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<DeviceState> => {
    checkAborted(signal);
    const key = localDeviceKey(api, deviceId);
    if (refresh || watch) {
      const value = await fetchReading(api, deviceId, refresh, signal, watch);
      checkAborted(signal);
      dispatch(localDeviceCache.util.upsertQueryEntries([{ endpointName: 'deviceState', arg: key, value }]));
      return localDeviceCache.endpoints.deviceState.select(key)(getState()).data?.reading ?? value.reading;
    }

    let client = clients.get(key.scope);
    if (!client) {
      client = { api, readers: 0 };
      clients.set(key.scope, client);
    }
    client.readers++;
    try {
      const request = dispatch(localDeviceCache.endpoints.deviceState.initiate(key, {
        subscribe: Boolean(signal),
        forceRefetch: 1,
      }));
      if (signal) {
        // Each caller can leave without aborting a request shared by other readers.
        if (signal.aborted) request.unsubscribe();
        else signal.addEventListener('abort', () => request.unsubscribe(), { once: true });
      }
      const result = await request;
      checkAborted(signal);
      if (result.error) {
        const message = result.error.message ?? t(MSG.COULD_NOT_LOAD_DEVICES);
        throw 'status' in result.error && result.error.status !== undefined
          ? new ApiError(message, result.error.status) : new Error(message);
      }
      if (!result.data) throw new Error(t(MSG.COULD_NOT_LOAD_DEVICES));
      return result.data.reading;
    } finally {
      if (--client.readers === 0) clients.delete(key.scope);
    }
  };
}

export function sendLocalCapabilities(api: HomeApi, deviceId: number, values: Record<string, JsonValue>) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<boolean> => {
    try {
      const result = await api.setCapabilities(deviceId, values);
      if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
      return false;
    } catch (failure) {
      if (!(failure instanceof ApiError) || failure.status !== 504) throw failure;

      const key = localDeviceKey(api, deviceId);
      const baseline = localDeviceCache.endpoints.deviceState.select(key)(getState()).data?.reading.values;
      async function confirmedByRead() {
        try {
          const refreshed = await dispatch(readLocalDevice(api, deviceId, true));
          // A status request can omit individual DPs. Only a newer
          // observation of every requested capability confirms the state.
          return refreshed.available && Object.entries(values).every(([code, expected]) => {
            const before = Date.parse(baseline?.[code]?.observed_at ?? '');
            const reading = refreshed.values[code];
            const after = Date.parse(reading?.observed_at ?? '');
            return reading?.known && !reading.stale && after > before && sameValue(reading.value, expected);
          });
        } catch (readFailure) {
          if (readFailure instanceof ApiError && readFailure.status === 401) throw readFailure;
          return false;
        }
      }
      if (await confirmedByRead()) return true;
      await new Promise<void>((resolve) => { setTimeout(resolve, 1200); });
      if (await confirmedByRead()) return true;
      throw failure;
    }
  };
}
