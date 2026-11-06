import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { HomeApi } from './home-api';
import { localDeviceCache, localDeviceKey, readLocalDevice } from './local-device-cache';
import { createAppStore } from './store';

const connection = { baseUrl: 'http://api.test', token: 'local-test-key' };
const reading = (value: boolean, device_id = 7) => ({
  device_id, enabled: true, available: true, values: { switch: { known: true, stale: false, value } },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function deferredResponse() {
  let finish!: (value: Response) => void;
  const promise = new Promise<Response>(resolve => { finish = resolve; });
  return { promise, finish };
}

describe('shared local device cache', () => {
  it('coalesces concurrent reads and serves the same recent reading to later readers', async () => {
    const store = createAppStore(), api = new HomeApi(connection);
    const response = deferredResponse();
    vi.mocked(fetch).mockReturnValue(response.promise);
    const first = store.dispatch(readLocalDevice(api, 7));
    const second = store.dispatch(readLocalDevice(api, 7));
    expect(fetch).toHaveBeenCalledTimes(1);
    response.finish(json(reading(true)));
    await expect(Promise.all([first, second])).resolves.toEqual([reading(true), reading(true)]);
    await expect(store.dispatch(readLocalDevice(api, 7))).resolves.toEqual(reading(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(store.getState())).not.toContain(connection.token);
  });

  it('scopes readings to the API connection and device ID even when an old response arrives late', async () => {
    const store = createAppStore(), old = new HomeApi(connection);
    const next = new HomeApi({ ...connection, token: 'replacement-test-key' });
    const response = deferredResponse();
    vi.mocked(fetch).mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(json(reading(true)))
      .mockResolvedValueOnce(json(reading(false, 8)));
    const oldRead = store.dispatch(readLocalDevice(old, 7));
    await expect(store.dispatch(readLocalDevice(next, 7))).resolves.toEqual(reading(true));
    await expect(store.dispatch(readLocalDevice(next, 8))).resolves.toEqual(reading(false, 8));
    response.finish(json(reading(false)));
    await oldRead;
    expect(localDeviceCache.endpoints.deviceState.select(localDeviceKey(next, 7))(store.getState()).data?.reading)
      .toEqual(reading(true));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('lets one reader cancel without canceling a shared request', async () => {
    const store = createAppStore(), api = new HomeApi(connection);
    const controller = new AbortController(), response = deferredResponse();
    vi.mocked(fetch).mockReturnValue(response.promise);
    const first = store.dispatch(readLocalDevice(api, 7, false, controller.signal));
    const second = store.dispatch(readLocalDevice(api, 7));
    const canceled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    response.finish(json(reading(true)));
    await canceled;
    await expect(second).resolves.toEqual(reading(true));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains readings during a subscription and evicts them after the last reader leaves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = createAppStore(), api = new HomeApi(connection);
    const first = new AbortController(), second = new AbortController();
    const select = localDeviceCache.endpoints.deviceState.select(localDeviceKey(api, 7));
    vi.mocked(fetch).mockResolvedValueOnce(json(reading(true)));
    try {
      await Promise.all([
        store.dispatch(readLocalDevice(api, 7, false, first.signal)),
        store.dispatch(readLocalDevice(api, 7, false, second.signal)),
      ]);
      first.abort();
      await vi.advanceTimersByTimeAsync(16_000);
      expect(select(store.getState()).data?.reading).toEqual(reading(true));
      second.abort();
      await vi.advanceTimersByTimeAsync(16_000);
      expect(select(store.getState()).data).toBeUndefined();
    } finally {
      first.abort();
      second.abort();
      vi.useRealTimers();
    }
  });

  it('preserves watch and explicit refresh requests and ignores an older initial result', async () => {
    const store = createAppStore(), api = new HomeApi(connection);
    const response = deferredResponse();
    vi.mocked(fetch).mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(json(reading(true)))
      .mockResolvedValueOnce(json(reading(false)));
    const initial = store.dispatch(readLocalDevice(api, 7));
    await store.dispatch(readLocalDevice(api, 7, false, undefined, true));
    response.finish(json(reading(false)));
    await initial;
    const select = localDeviceCache.endpoints.deviceState.select(localDeviceKey(api, 7));
    expect(select(store.getState()).data?.reading).toEqual(reading(true));
    await store.dispatch(readLocalDevice(api, 7, true));
    expect(select(store.getState()).data?.reading).toEqual(reading(false));
    expect(vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).search)).toEqual([
      '?refresh=false&max_age=60', '?refresh=false&max_age=60&watch=true', '?refresh=true&max_age=60',
    ]);
  });

  it('does not publish canceled watch responses', async () => {
    const store = createAppStore(), api = new HomeApi(connection);
    const response = deferredResponse(), controller = new AbortController();
    vi.mocked(fetch).mockReturnValue(response.promise);
    const watch = store.dispatch(readLocalDevice(api, 7, false, controller.signal, true));
    const canceled = expect(watch).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    response.finish(json(reading(true)));
    await canceled;
    expect(localDeviceCache.endpoints.deviceState.select(localDeviceKey(api, 7))(store.getState()).data).toBeUndefined();
  });

  it('propagates authentication errors and retries without caching a different device', async () => {
    const store = createAppStore(), api = new HomeApi(connection);
    vi.mocked(fetch).mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(reading(false, 8)))
      .mockResolvedValueOnce(json(reading(true)));
    await expect(store.dispatch(readLocalDevice(api, 7))).rejects.toBeInstanceOf(ApiError);
    await expect(store.dispatch(readLocalDevice(api, 7))).rejects.toThrow('Сервис вернул другое устройство.');
    await expect(store.dispatch(readLocalDevice(api, 7))).resolves.toEqual(reading(true));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retains the last reported reading when an explicit refresh fails', async () => {
    const store = createAppStore(), api = new HomeApi(connection);
    vi.mocked(fetch).mockResolvedValueOnce(json(reading(true))).mockResolvedValueOnce(json({ detail: 'Device timeout' }, 504));
    await store.dispatch(readLocalDevice(api, 7));
    await expect(store.dispatch(readLocalDevice(api, 7, true))).rejects.toMatchObject({ status: 504 });
    expect(localDeviceCache.endpoints.deviceState.select(localDeviceKey(api, 7))(store.getState()).data?.reading)
      .toEqual(reading(true));
  });
});
