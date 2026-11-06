import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { STORAGE_KEY } from './connection';
import { deviceCardId, deviceHref, readDeviceLink } from './device-links';
import type { LocalDevice } from './home-api';

const devices: LocalDevice[] = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1, device_id: 'physical-' + index, name: 'Устройство ' + index, aliases: [], building_id: null, room_id: null,
  transport: 'wifi', parent_id: null, cid: null, enabled: true, capabilities: {}, ip: '192.168.1.' + (index + 10),
  version: '3.5', has_local_key: true,
}));
const json = (value: unknown) => new Response(JSON.stringify(value));
function backend(records = devices) {
  const calls: { path: string; method: string }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const url = new URL(String(input)), path = url.pathname;
    calls.push({ path: path + url.search, method: options?.method || 'GET' });
    if (path === '/api/v1/cloud/status') return json({ enabled: true, connected: false, has_saved_user_code: false, saved_user_code_requires_login: false, developer: { configured: false, connected: false } });
    if (path === '/api/v1/devices') return json(records);
    if (['/api/v1/buildings', '/api/v1/rooms', '/api/v1/groups'].includes(path)) return json([]);
    if (path.startsWith('/api/v1/activity/')) return json({ events: [], next_before: null });
    const id = Number(path.split('/')[4]), device = records.find(row => row.id === id);
    if (path.endsWith('/state')) return json({ device_id: id, name: device?.name, enabled: true, available: true,
      values: device?.capabilities.switch ? { switch: { value: false, known: true, stale: false } } : {} });
    if (device) return json(device);
    throw new Error('Unexpected path: ' + path);
  });
  return calls;
}
function access(hash: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: 'http://navigation-api.test', token: 'test-service-key' }));
  window.history.replaceState(null, '', '/' + hash);
}
function hash(hash: string) {
  window.history.replaceState(null, '', '/' + hash);
  fireEvent(window, new HashChangeEvent('hashchange'));
}

describe('device deep navigation', () => {
  it('encodes stable physical identities and parses only supported device links', () => {
    const id = 'свет /?& #1';
    expect(readDeviceLink(deviceHref(id, 'local'))).toEqual({ id, route: 'local' });
    expect(deviceCardId(id)).toBe('device-' + encodeURIComponent(id));
    expect(readDeviceLink('#device/physical-0')).toEqual({ id: 'physical-0' });
    expect(readDeviceLink('#device/%E0%A4?route=local')).toBeNull();
    expect(readDeviceLink('#device/id?route=https://other.test')).toBeNull();
    expect(readDeviceLink('#network')).toBeNull();
  });
  it('opens a saved local device beyond the first page and restores it after a reload', async () => {
    const calls = backend(); access(deviceHref('physical-29', 'local'));
    const first = render(<App />);
    const dialog = await screen.findByRole('dialog', { name: 'Устройство 29' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Закрыть' })).toBeEnabled());
    expect(screen.getByRole('listitem', { name: 'Устройство 29' })).toHaveAttribute('id', 'device-physical-29');
    expect(screen.getByText('2 / 2')).toBeInTheDocument(); first.unmount();
    render(<App />); expect(await screen.findByRole('dialog', { name: 'Устройство 29' })).toBeInTheDocument();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.some(call => call.path === '/api/v1/devices/30')).toBe(true);
  });
  it('updates the URL when opening a card and removes it on close without reopening the dialog', async () => {
    backend(); access(''); render(<App />);
    const card = await screen.findByRole('listitem', { name: 'Устройство 0' });
    fireEvent.click(within(card).getByRole('button', { name: 'Подробнее' }));
    const dialog = await screen.findByRole('dialog', { name: 'Устройство 0' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Закрыть' })).toBeEnabled());
    expect(window.location.hash).toBe('#device/physical-0?route=local');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(window.location.hash).toBe('');
  });
  it('follows same-tab hash links and back/forward route changes', async () => {
    backend(); access('#local-connections'); render(<App />); await screen.findByText('API подключён');
    act(() => hash(deviceHref('physical-2', 'local')));
    const dialog = await screen.findByRole('dialog', { name: 'Устройство 2' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Закрыть' })).toBeEnabled());
    act(() => hash('#local-connections'));
    expect(await screen.findByRole('heading', { name: 'Локальные подключения' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => hash(deviceHref('physical-2', 'local')));
    expect(await screen.findByRole('dialog', { name: 'Устройство 2' })).toBeInTheDocument();
  });
  it.each([['missing-id', 'local', 'не найдено'], ['physical-0', 'sharing', 'недоступен']] as const)('reports unavailable target %s/%s without substituting another device or connection', async (id, route, text) => {
    const calls = backend(); access(deviceHref(id, route)); render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('keeps a busy device operation open when browser navigation is attempted', async () => {
    backend(); const original = vi.mocked(fetch).getMockImplementation()!;
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, options) => new URL(String(input)).pathname === '/api/v1/devices/30'
      ? new Promise<Response>(resolve => { finish = resolve; }) : original(input, options));
    access(deviceHref('physical-29', 'local')); render(<App />);
    const dialog = await screen.findByRole('dialog', { name: 'Устройство 29' });
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    act(() => hash('#local-connections'));
    expect(window.location.hash).toBe(deviceHref('physical-29', 'local')); expect(dialog).toBeInTheDocument();
    await act(async () => finish(json(devices[29])));
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'false'));
    const nested = document.createElement('dialog'); nested.setAttribute('open', ''); document.body.append(nested);
    act(() => hash('#local-connections'));
    expect(window.location.hash).toBe(deviceHref('physical-29', 'local')); nested.remove();
    act(() => hash('#local-connections'));
    expect(await screen.findByRole('heading', { name: 'Локальные подключения' })).toBeInTheDocument();
  });
  it('locks dashboard navigation until every pending card command settles', async () => {
    backend(devices.slice(0, 2).map(device => ({
      ...device, capabilities: { switch: { type: 'boolean', readable: true, writable: true } },
    })));
    const original = vi.mocked(fetch).getMockImplementation()!;
    const pending = new Map<number, (response: Response) => void>();
    vi.mocked(fetch).mockImplementation((input, options) => {
      const path = new URL(String(input)).pathname;
      const match = /\/devices\/(\d+)\/commands\/capabilities$/.exec(path);
      return options?.method === 'POST' && match
        ? new Promise(resolve => pending.set(Number(match[1]), resolve))
        : original(input, options);
    });
    access('');
    render(<App />);
    const first = await screen.findByRole('listitem', { name: 'Устройство 0' });
    const second = await screen.findByRole('listitem', { name: 'Устройство 1' });
    const firstSwitch = await within(first).findByRole('switch');
    const secondSwitch = await within(second).findByRole('switch');
    await waitFor(() => { expect(firstSwitch).toBeEnabled(); expect(secondSwitch).toBeEnabled(); });
    fireEvent.click(firstSwitch);
    fireEvent.click(secondSwitch);
    const menu = screen.getByRole('button', { name: 'Меню' });
    await waitFor(() => expect(pending.size).toBe(2));
    expect(menu).toBeDisabled();
    expect(within(first).getByRole('button', { name: 'Подробнее' })).toBeDisabled();
    expect(within(second).getByRole('button', { name: 'Подробнее' })).toBeDisabled();
    await act(async () => pending.get(1)!(json({ acknowledged: true })));
    await waitFor(() => expect(within(first).getByRole('button', { name: 'Подробнее' })).toBeEnabled());
    expect(menu).toBeDisabled();
    act(() => hash('#local-connections'));
    expect(window.location.hash).toBe('');
    await act(async () => pending.get(2)!(json({ acknowledged: true })));
    await waitFor(() => expect(menu).toBeEnabled());
    act(() => hash('#local-connections'));
    expect(await screen.findByRole('heading', { name: 'Локальные подключения' })).toBeInTheDocument();
  });

  it('reads local dashboard state once and shares a detail watch result with the card', async () => {
    const device: LocalDevice = { ...devices[0],
      capabilities: { switch: { type: 'boolean', readable: true, writable: true } } };
    backend([device]);
    const original = vi.mocked(fetch).getMockImplementation()!;
    const reads: string[] = [];
    vi.mocked(fetch).mockImplementation((input, options) => {
      const url = new URL(String(input));
      if (url.pathname !== '/api/v1/devices/1/state') return original(input, options);
      reads.push(url.search);
      return Promise.resolve(json({ device_id: 1, enabled: true, available: true,
        values: { switch: { value: url.searchParams.get('watch') === 'true', known: true, stale: false } } }));
    });
    access('');
    render(<App />);
    const card = await screen.findByRole('listitem', { name: device.name });
    const power = await within(card).findByRole('switch');
    await waitFor(() => expect(power).toBeEnabled());
    expect(power).not.toBeChecked();
    expect(reads).toEqual(['?refresh=false&max_age=60']);
    fireEvent.click(within(card).getByRole('button', { name: 'Подробнее' }));
    const dialog = await screen.findByRole('dialog', { name: device.name });
    await waitFor(() => expect(within(dialog).getByRole('switch')).toBeChecked());
    await waitFor(() => expect(power).toBeChecked());
    expect(reads).toEqual(['?refresh=false&max_age=60', '?refresh=false&max_age=60&watch=true']);
  });
});
