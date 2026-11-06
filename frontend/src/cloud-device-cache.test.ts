import { describe, expect, it, vi } from 'vitest';
import { ApiError, CloudApi } from './api';
import type { CloudSnapshot } from './api';
import { rotateCloudAccountScope } from './cloud-account-scope';
import { cloudDeviceCache, cloudDeviceKey, readCloudDevice } from './cloud-device-cache';
import { createAppStore } from './store';

const api = () => new CloudApi({ baseUrl: 'http://cloud.test', token: 'secret-service-key' });
const snapshot = (device_id = 'lamp', power = false): CloudSnapshot => ({
  device_id, online: true, source: 'tuya_cloud_snapshot', status: { switch_led: power },
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const cached = (store: ReturnType<typeof createAppStore>, key: ReturnType<typeof cloudDeviceKey>) =>
  cloudDeviceCache.endpoints.deviceSnapshot.select(key)(store.getState()).data;
function delayedResponse() {
  let resolve!: (value: Response) => void;
  const response = new Promise<Response>(done => { resolve = done; });
  return { response, resolve };
}

describe('shared cloud readings', () => {
  it('deduplicates passive reads without cancelling the remaining reader', async () => {
    const store = createAppStore(), client = api();
    const key = cloudDeviceKey(client, 'lamp', 'sharing');
    const pending = delayedResponse();
    vi.mocked(fetch).mockReturnValueOnce(pending.response);
    const controller = new AbortController();
    const first = store.dispatch(readCloudDevice(client, key, { signal: controller.signal }));
    const second = store.dispatch(readCloudDevice(client, key));
    const firstOutcome = expect(first).rejects.toHaveProperty('name', 'AbortError');
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('refresh=false&provider=sharing');
    controller.abort();
    pending.resolve(json(snapshot()));
    await firstOutcome;
    await expect(second).resolves.toEqual(snapshot());
    expect(cached(store, key)?.snapshot).toEqual(snapshot());
    expect(JSON.stringify(store.getState())).not.toContain('secret-service-key');
    expect(JSON.stringify(store.getState())).not.toContain('http://cloud.test');
  });

  it('deduplicates fresh reads, lets a later poll use the fresh result and ignores an earlier poll', async () => {
    const store = createAppStore(), client = api();
    const key = cloudDeviceKey(client, 'lamp', 'sharing');
    const old = delayedResponse(), fresh = delayedResponse();
    vi.mocked(fetch).mockReturnValueOnce(old.response).mockReturnValueOnce(fresh.response);
    const oldPoll = store.dispatch(readCloudDevice(client, key));
    const refresh = store.dispatch(readCloudDevice(client, key, { refresh: true }));
    const otherRefresh = store.dispatch(readCloudDevice(client, key, { refresh: true }));
    const newPoll = store.dispatch(readCloudDevice(client, key));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain('refresh=true&provider=sharing');
    fresh.resolve(json(snapshot('lamp', true)));
    for (const read of [refresh, otherRefresh, newPoll]) await expect(read).resolves.toEqual(snapshot('lamp', true));
    old.resolve(json(snapshot()));
    await expect(oldPoll).resolves.toEqual(snapshot('lamp', true));
    expect(cached(store, key)?.snapshot).toEqual(snapshot('lamp', true));
  });

  it('keeps inventory seeds from replacing refreshed reports and marks only fresh Developer reads', async () => {
    const store = createAppStore(), client = api();
    const key = cloudDeviceKey(client, 'lamp', 'developer');
    await expect(store.dispatch(readCloudDevice(client, key, { seed: snapshot() }))).resolves.toEqual(snapshot());
    expect(fetch).not.toHaveBeenCalled();
    expect(cached(store, key)?.liveRequestAt).toBeUndefined();
    vi.mocked(fetch).mockResolvedValueOnce(json(snapshot('lamp', true)));
    const started = Date.now();
    await store.dispatch(readCloudDevice(client, key, { refresh: true }));
    await expect(store.dispatch(readCloudDevice(client, key, { seed: snapshot() }))).resolves.toEqual(snapshot('lamp', true));
    expect(cached(store, key)?.liveRequestAt).toBeGreaterThanOrEqual(started);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('isolates the account, provider and device and discards a retired account refresh', async () => {
    const store = createAppStore(), client = api();
    const oldKey = cloudDeviceKey(client, 'lamp', 'sharing');
    const developer = cloudDeviceKey(client, 'lamp', 'developer');
    const anotherDevice = cloudDeviceKey(client, 'other', 'sharing');
    const otherConnection = cloudDeviceKey(api(), 'lamp', 'sharing');
    const pending = delayedResponse();
    vi.mocked(fetch).mockReturnValueOnce(pending.response);
    const oldRead = store.dispatch(readCloudDevice(client, oldKey, { refresh: true }));
    const oldOutcome = expect(oldRead).rejects.toHaveProperty('name', 'AbortError');
    await store.dispatch(readCloudDevice(client, developer, { seed: snapshot() }));
    await store.dispatch(readCloudDevice(client, anotherDevice, { seed: snapshot('other') }));
    expect(cached(store, otherConnection)).toBeUndefined();
    rotateCloudAccountScope(client, 'sharing');
    const newKey = cloudDeviceKey(client, 'lamp', 'sharing');
    expect(newKey.scope).not.toBe(oldKey.scope);
    expect(cloudDeviceKey(client, 'lamp', 'developer')).toEqual(developer);
    expect(cached(store, newKey)).toBeUndefined();
    pending.resolve(json(snapshot('lamp', true)));
    await oldOutcome;
    expect(cached(store, newKey)).toBeUndefined();
    expect(cached(store, developer)?.snapshot).toEqual(snapshot());
    await expect(store.dispatch(readCloudDevice(client, oldKey))).rejects.toHaveProperty('name', 'AbortError');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not cache mismatched device data and preserves authorization failures', async () => {
    const store = createAppStore(), client = api();
    const key = cloudDeviceKey(client, 'lamp', 'sharing');
    vi.mocked(fetch).mockResolvedValueOnce(json(snapshot('wrong'))).mockResolvedValueOnce(json({}, 401));
    await expect(store.dispatch(readCloudDevice(client, key))).rejects.toThrow();
    expect(cached(store, key)).toBeUndefined();
    await expect(store.dispatch(readCloudDevice(client, key, { refresh: true }))).rejects.toMatchObject({
      constructor: ApiError,
      status: 401,
    });
    expect(cached(store, key)).toBeUndefined();
  });
});
