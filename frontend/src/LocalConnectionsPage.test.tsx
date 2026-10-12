import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeApi } from './home-api';
import type { ConnectionFinding } from './home-api';
import { LocalConnectionsPage } from './components/LocalConnectionsPage';

const api = new HomeApi({ baseUrl: 'http://connections-api.test', token: 'service-key' });
const finding: ConnectionFinding = {
  finding_id: 'a'.repeat(32), expires_in: 300, action: 'created', verified: true,
  key_source: 'device', interface_address: '192.168.40.10', requested_device_id: 'lamp', connection_device_id: 'lamp', route: 'direct',
  device: { device_id: 'lamp', existing_id: null, name: 'Лямпа · światło', aliases: ['Святло'], building_id: 1, room_id: 2,
    ip: '192.168.40.20', version: '3.5', changed_fields: ['ip', 'version', 'local_key'], is_gateway: false },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const flush = async () => { await act(async () => {}); };
function backend(result = finding, saveStatus = 201) {
  const calls: { path: string; method: string; body?: unknown; provider: string | null }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const url = new URL(String(input)), path = url.pathname;
    calls.push({ path, method: options?.method || 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined, provider: url.searchParams.get('provider') });
    expect((options?.headers as Record<string, string>)['X-API-Key']).toBe('service-key');
    if (path === '/api/v1/cloud/devices') return json([{ id: 'lamp', name: finding.device.name, aliases: ['Святло'] }, { id: 'sensor', name: 'Датчик' }]);
    if (path === '/api/v1/network/interfaces') return json([{ name: 'en1', address: '192.168.40.10', network: '192.168.40.0/24' }, { name: 'en2', address: '192.168.20.10', network: '192.168.20.0/24' }]);
    if (path === '/api/v1/rooms') return json([{ id: 2, building_id: 1, name: 'Кухня' }]);
    if (path === '/api/v1/buildings') return json([{ id: 1, name: 'Дом' }]);
    if (path === '/api/v1/devices' || path === '/api/v1/groups') return json([]);
    if (path === '/api/v1/local-connections/find') return json(result);
    if (path === '/api/v1/local-connections/save') return saveStatus < 400 ? json({ action: result.action, device: { ...result.device, id: 1 }, verified: true, key_source: result.key_source, interface_address: result.interface_address }, saveStatus) : json({ detail: 'Предварительный просмотр устарел. Повторите поиск.' }, saveStatus);
    throw new Error('Unexpected endpoint');
  });
  return calls;
}
function mount(extra: Partial<Parameters<typeof LocalConnectionsPage>[0]> = {}) {
  const onAuthError = vi.fn(), onLock = vi.fn(), onConnections = vi.fn();
  return { ...render(<LocalConnectionsPage api={api} ready sharingReady developerReady={false} onAuthError={onAuthError} onConnections={onConnections} onLock={onLock} {...extra} />), onAuthError, onLock, onConnections };
}
async function select(device = 'lamp') {
  await flush();
  fireEvent.change(screen.getByRole('combobox', { name: 'Устройство' }), { target: { value: device } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Сеть устройства' }), { target: { value: '192.168.40.10' } });
}
async function find(device = 'lamp') { await select(device); fireEvent.click(screen.getByRole('button', { name: 'Найти и проверить' })); await flush(); }
const saves = (calls: ReturnType<typeof backend>) => calls.filter(call => call.path.endsWith('/save'));

describe('local connections page', () => {
  it('requires explicit device and actual interface; finding shows real metadata without saving', async () => {
    const calls = backend(); mount(); await flush();
    expect(screen.getByRole('button', { name: 'Найти и проверить' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Сеть устройства' })).toHaveValue('');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    await find();
    expect(calls.find(call => call.path.endsWith('/find'))?.body).toEqual({ device_id: 'lamp', provider: 'sharing', interface_address: '192.168.40.10' });
    expect(screen.getByRole('heading', { name: finding.device.name })).toBeInTheDocument();
    expect(screen.getByText('Кухня')).toBeInTheDocument(); expect(screen.getByText('192.168.40.20')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Сохранить подключение' })).toBeDisabled();
    expect(saves(calls)).toHaveLength(0);
  });
  it('saves once only on confirmed click using only the finding handle and true', async () => {
    const calls = backend(); const { onLock } = mount(); await find();
    fireEvent.click(screen.getByRole('checkbox')); expect(saves(calls)).toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Сохранить подключение' });
    fireEvent.click(button); fireEvent.click(button); await flush();
    expect(saves(calls)).toHaveLength(1); expect(saves(calls)[0].body).toEqual({ finding_id: finding.finding_id, confirmed: true });
    expect(onLock).toHaveBeenCalledWith(true); expect(onLock).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.getByText(/Подключение сохранено:/)).toBeInTheDocument();
  });
  it.each(['Устройство', 'Сеть устройства'])('invalidates confirmation and preview when %s changes', async name => {
    const calls = backend(); mount(); await find(); fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByRole('combobox', { name }), { target: { value: name === 'Устройство' ? 'sensor' : '192.168.20.10' } });
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(saves(calls)).toHaveLength(0);
  });
  it('refresh and cancellation discard previews without saving', async () => {
    const calls = backend(); mount(); await find(); fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('checkbox')).toBeNull(); await find();
    fireEvent.click(screen.getByRole('button', { name: 'Обновить списки' })); await flush();
    expect(screen.getByRole('combobox', { name: 'Устройство' })).toHaveValue('');
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(saves(calls)).toHaveLength(0);
  });
  it('expires confirmed results without automatically saving', async () => {
    vi.useFakeTimers(); const calls = backend({ ...finding, expires_in: 2 }); mount(); await find();
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByRole('button', { name: 'Сохранить подключение' })).toBeDisabled();
    expect(screen.getByText(/Срок результата истёк/)).toBeInTheDocument(); expect(saves(calls)).toHaveLength(0);
  });
  it('shows the actual gateway when a child was requested, without claiming child verification', async () => {
    const calls = backend({ ...finding, requested_device_id: 'sensor', connection_device_id: 'gateway', route: 'gateway', key_source: 'child',
      device: { ...finding.device, device_id: 'gateway', name: 'Реальный шлюз', is_gateway: true } });
    mount(); await find('sensor');
    expect(screen.getByRole('heading', { name: 'Реальный шлюз' })).toBeInTheDocument();
    expect(screen.getByText(/Выбрано: Датчик.*не подтверждает связь/)).toBeInTheDocument(); expect(saves(calls)).toHaveLength(0);
  });
  it('discards obsolete save results and requires a fresh find rather than retrying', async () => {
    const calls = backend(finding, 409); mount(); await find();
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Сохранить подключение' })); await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('устарел'); expect(screen.queryByRole('checkbox')).toBeNull(); expect(saves(calls)).toHaveLength(1);
  });
  it('ignores a late finding after changing selection, even if the transport ignores abort', async () => {
    const calls = backend(); const handler = vi.mocked(fetch).getMockImplementation()!;
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, options) => String(input).endsWith('/find') ? new Promise<Response>(done => { resolve = done; }) : handler(input, options));
    mount(); await select(); fireEvent.click(screen.getByRole('button', { name: 'Найти и проверить' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Устройство' }), { target: { value: 'sensor' } });
    await act(async () => resolve(json(finding)));
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(saves(calls)).toHaveLength(0);
  });
  it('uses the connected Developer provider', async () => {
    const calls = backend(); mount({ sharingReady: false, developerReady: true }); await find();
    expect(calls.find(call => call.path.endsWith('/find'))?.body).toMatchObject({ provider: 'developer' });
    expect(calls.find(call => call.path === '/api/v1/cloud/devices')?.provider).toBe('developer');
  });
  it('does not load or find without an authorized account and offers settings', async () => {
    const calls = backend(); const { onConnections } = mount({ sharingReady: false }); await flush();
    expect(calls).toHaveLength(0); expect(screen.getByRole('button', { name: 'Найти и проверить' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть подключения' })); expect(onConnections).toHaveBeenCalledOnce();
  });
  it('rejects a preview for a different device or interface', async () => {
    backend({ ...finding, interface_address: '192.168.20.10' }); mount(); await find();
    expect(screen.getByRole('alert')).toHaveTextContent('неожиданный результат'); expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('handles authorization loss', async () => {
    backend(); const handler = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, options) => String(input).endsWith('/find') ? Promise.resolve(json({ detail: 'Unauthorized' }, 401)) : handler(input, options));
    const { onAuthError } = mount(); await find(); expect(onAuthError).toHaveBeenCalledOnce();
  });
  it('resets the preview and selection when switching providers', async () => {
    const calls = backend(); mount({ developerReady: true }); await find(); fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Аккаунт' }), { target: { value: 'developer' } }); await flush();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.getByRole('combobox', { name: 'Устройство' })).toHaveValue('');
    expect(calls.filter(call => call.path === '/api/v1/cloud/devices').at(-1)?.provider).toBe('developer'); expect(saves(calls)).toHaveLength(0);
  });
  it('aborts finding on exit and ignores a late response', async () => {
    const calls = backend(); const handler = vi.mocked(fetch).getMockImplementation()!;
    let signal!: AbortSignal, resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, options) => {
      if (!String(input).endsWith('/find')) return handler(input, options);
      signal = options!.signal!; return new Promise<Response>(done => { resolve = done; });
    });
    const { unmount } = mount(); await select(); fireEvent.click(screen.getByRole('button', { name: 'Найти и проверить' }));
    unmount(); expect(signal.aborted).toBe(true); await act(async () => resolve(json(finding))); expect(saves(calls)).toHaveLength(0);
  });
});
