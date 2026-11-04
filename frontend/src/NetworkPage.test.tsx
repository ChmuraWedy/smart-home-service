import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import type { NetworkScan } from './api';
import { NetworkPage } from './components/NetworkPage';

const api = new CloudApi({ baseUrl: 'http://network-api.test', token: 'service-key' });
const initial: NetworkScan = {
  scan_id: 'private-session', interface: { name: 'en1', address: '192.168.1.10', network: '192.168.1.0/24', broadcast: '192.168.1.255' }, devices: [], events: [], packets: 0, recognized_packets: 0,
  neighbors_available: null, discovery_requests: 0, truncated: false, listening: true,
  ports: [1900, 5353, 6666, 6667, 7000], failed_ports: [], remaining_seconds: 900,
};
const observed: NetworkScan = { ...initial, packets: 2, recognized_packets: 1, neighbors_available: true,
  devices: [{ ip: '192.168.1.20', device_id: 'observed-id', version: '3.5', hostname: null, mac: null, protocols: ['tuya'], services: [], packets: 1, first_seen: '2026-10-12T12:00:00Z', last_seen: '2026-10-12T12:00:00Z', changes: [] },
    { ip: '192.168.1.30', device_id: null, version: null, hostname: 'sensor.local', mac: '00:11:22:33:44:55', protocols: ['arp', 'mdns'], services: ['_hap._tcp.local'], packets: 1, first_seen: '2026-10-12T12:00:00Z', last_seen: '2026-10-12T12:00:00Z', changes: [] }],
  events: [{ at: '2026-10-12T12:00:00Z', ip: '192.168.1.20', port: 7000, protocol: 'tuya', device_id: 'observed-id' }],
};
function backend(poll: NetworkScan = observed, pollStatus = 200) {
  const calls: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const path = new URL(String(input)).pathname;
    const method = options?.method || 'GET';
    calls.push(method + ' ' + path);
    expect((options?.headers as Record<string, string>)['X-API-Key']).toBe('service-key');
    if (path === '/api/v1/network/interfaces') return new Response(JSON.stringify([initial.interface]));
    if (!path.startsWith('/api/v1/network/scans')) throw new Error('Network page used another service');
    if (method === 'POST' && path.endsWith('/scans')) expect(JSON.parse(String(options?.body))).toEqual({interface_address:'192.168.1.10'});
    if (method === 'DELETE') return new Response(null, { status: 204 });
    const value = path.endsWith('/discover') ? { ...observed, discovery_requests: 1 } : method === 'POST' ? initial : pollStatus === 200 ? poll : { detail: 'Наблюдение за сетью завершено' };
    return new Response(JSON.stringify(value), { status: method === 'GET' ? pollStatus : 200 });
  });
  return calls;
}
const flush = async () => { await act(async () => {}); };
const start = async () => { await flush(); fireEvent.change(screen.getByRole('combobox', { name: 'Сеть для наблюдения' }), { target: { value: '192.168.1.10' } }); fireEvent.click(screen.getByRole('button', { name: 'Начать наблюдение' })); await flush(); };
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); };

describe('LAN observation page', () => {
  it('starts only on request, polls locally, filters real observations and stops on exit', async () => {
    vi.useFakeTimers(); const calls = backend();
    const { unmount } = render(<NetworkPage api={api} ready onAuthError={vi.fn()} />);
    expect(calls).toEqual(['GET /api/v1/network/interfaces']); expect(screen.queryByText(/Smart Life/)).toBeNull();
    await start(); expect(calls).toEqual(['GET /api/v1/network/interfaces', 'POST /api/v1/network/scans']);
    await tick(); expect(within(screen.getByRole('table')).getByText('observed-id')).toBeInTheDocument();
    expect(screen.getByText('sensor.local')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Источник' }), { target: { value: 'tuya' } });
    expect(screen.queryByText('sensor.local')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getByText('Нет совпадений с фильтром.')).toBeInTheDocument();
    unmount(); await flush(); expect(calls.at(-1)).toBe('DELETE /api/v1/network/scans/private-session');
    const length = calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(calls).toHaveLength(length);
  });

  it('requests Tuya announcements explicitly, stops and retains an exportable snapshot', async () => {
    vi.useFakeTimers(); const calls = backend();
    render(<NetworkPage api={api} ready onAuthError={vi.fn()} />); await start();
    fireEvent.click(screen.getByRole('button', { name: 'Запросить объявления Tuya' })); await flush();
    expect(calls).toContain('POST /api/v1/network/scans/private-session/discover');
    fireEvent.click(screen.getByRole('button', { name: 'Остановить' })); await flush();
    expect(within(screen.getByRole('table')).getByText('observed-id')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Запросить объявления Tuya' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Сохранить отчёт' })).toBeEnabled();
    expect(calls.at(-1)).toBe('DELETE /api/v1/network/scans/private-session');
  });

  it('cancels an observation that finishes starting after navigation away', async () => {
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(async (input, options) => options?.method === 'POST' ? new Promise(resolve => { complete = resolve; }) : String(input).endsWith('/interfaces') ? new Response(JSON.stringify([initial.interface])) : new Response(null, { status: 204 }));
    const { unmount } = render(<NetworkPage api={api} ready onAuthError={vi.fn()} />);
    await start(); unmount();
    complete(new Response(JSON.stringify(initial))); await flush();
    expect(vi.mocked(fetch).mock.calls.map(([url, options]) => [String(url), options?.method])).toContainEqual(['http://network-api.test/api/v1/network/scans/private-session', 'DELETE']);
  });

  it.each([401, 404])('stops on server failure %s without retrying', async status => {
    vi.useFakeTimers(); const calls = backend(observed, status); const onAuthError = vi.fn();
    render(<NetworkPage api={api} ready onAuthError={onAuthError} />); await start(); await tick();
    expect(screen.getByRole('alert')).toHaveTextContent(status === 401 ? 'Ключ доступа недействителен' : 'Наблюдение за сетью завершено');
    expect(onAuthError).toHaveBeenCalledTimes(status === 401 ? 1 : 0); expect(screen.getByRole('button', { name: 'Начать наблюдение' })).toBeEnabled();
    expect(calls.at(-1)).toBe('DELETE /api/v1/network/scans/private-session');
  });

  it('stops when hidden and blocks starting without service access', async () => {
    vi.useFakeTimers(); const calls = backend();
    const { rerender } = render(<NetworkPage api={api} ready={false} onAuthError={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Начать наблюдение' })).toBeDisabled();
    rerender(<NetworkPage api={api} ready onAuthError={vi.fn()} />); await start(); await tick();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange')); await flush(); hidden.mockRestore();
    expect(calls.at(-1)).toBe('DELETE /api/v1/network/scans/private-session');
    expect(within(screen.getByRole('table')).getByText('observed-id')).toBeInTheDocument();
  });

  it('exports observations without the private session identifier', async () => {
    vi.useFakeTimers(); backend(); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<NetworkPage api={api} ready onAuthError={vi.fn()} />); await start(); await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить отчёт' }));
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    vi.useRealTimers();
    const raw = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    expect(JSON.parse(raw)).toMatchObject({ format: 'smart-home-network-observation', packets: 2, devices: observed.devices });
    expect(raw).not.toContain('private-session'); expect(raw).not.toContain('service-key');
    expect(click).toHaveBeenCalledOnce(); click.mockRestore();
    expect(within(screen.getByRole('table')).getByText('192.168.1.20')).toBeInTheDocument();
  });
});
