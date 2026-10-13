import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeApi } from './home-api';
import type { CloudDevice, LanDevice, NetworkScan } from './api';
import type { ConnectionFinding, LocalDevice } from './home-api';
import { LocalConnectionsPage } from './components/LocalConnectionsPage';

const api = new HomeApi({ baseUrl: 'http://connections-api.test', token: 'service-key' });
const iface = { name: 'en1', address: '192.168.40.10', network: '192.168.40.0/24', broadcast: '192.168.40.255' };
const cloud: CloudDevice[] = [
  { id: 'lamp', name: 'Лямпа · światło', aliases: ['Святло'], online: true, has_local_key: true },
  { id: 'gateway', name: 'Шлюз', category: 'wg2', sub: true, online: true, has_local_key: false },
  { id: 'sensor', name: 'Датчик Zigbee', sub: true, online: true, has_local_key: true },
];
const gateway: LocalDevice = { id: 8, device_id: 'gateway', name: 'Шлюз', aliases: [], building_id: 1, room_id: 2,
  transport: 'wifi', is_gateway: true, parent_id: null, cid: null, enabled: true, capabilities: {}, ip: '192.168.40.22', version: '3.5', has_local_key: true };
const announcement = (id: string, ip: string): LanDevice => ({
  ip, device_id: id, version: '3.5', hostname: null, mac: null, protocols: ['tuya'], services: [], packets: 1,
  first_seen: null, last_seen: null, changes: [],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Options = {
  cloud?: CloudDevice[]; locals?: LocalDevice[]; observed?: LanDevice[]; wrongNetwork?: boolean;
  scanError?: number; findErrors?: Record<string, number>; saveErrors?: Record<string, number | 'transport'>;
  expires?: number; wrongFinding?: boolean;
};
function backend(options: Options = {}) {
  let locals = options.locals || [gateway];
  const devices = options.cloud || cloud;
  const calls: { path: string; method: string; body?: Record<string, unknown>; at: number; signal?: AbortSignal | null; provider: string | null }[] = [];
  const found = new Map<string, ConnectionFinding>();
  const snapshot: NetworkScan = {
    scan_id: 'private-scan', interface: options.wrongNetwork ? { ...iface, address: '192.168.20.10' } : iface,
    devices: options.observed || [announcement('lamp', '192.168.40.20'), announcement('gateway', '192.168.40.22'), announcement('outside-account', '192.168.40.23')],
    events: [], packets: 3, recognized_packets: 3, neighbors_available: true, discovery_requests: 1,
    truncated: false, listening: true, ports: [7000], failed_ports: [], remaining_seconds: 900,
  };
  vi.mocked(fetch).mockImplementation(async (input, settings) => {
    const url = new URL(String(input)), path = url.pathname;
    const body = settings?.body ? JSON.parse(String(settings.body)) : undefined;
    const method = settings?.method || 'GET';
    calls.push({ path, method, body, at: Date.now(), signal: settings?.signal, provider: url.searchParams.get('provider') });
    expect((settings?.headers as Record<string, string>)['X-API-Key']).toBe('service-key');
    if (path === '/api/v1/cloud/devices') return json(devices);
    if (path === '/api/v1/network/interfaces') return json([iface]);
    if (path === '/api/v1/rooms') return json([{ id: 2, building_id: 1, name: 'Кухня' }]);
    if (path === '/api/v1/buildings') return json([{ id: 1, name: 'Дом' }]);
    if (path === '/api/v1/devices') return json(locals);
    if (path === '/api/v1/groups') return json([]);
    if (path.startsWith('/api/v1/network/scans')) {
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (options.scanError) return json({ detail: 'Сеть недоступна' }, options.scanError);
      return json(snapshot);
    }
    if (path.endsWith('/local-connections/find')) {
      const id = body.device_id as string;
      if (options.findErrors?.[id]) return json({ detail: 'Проверка ключа не прошла' }, options.findErrors[id]);
      const device = devices.find(row => row.id === id)!;
      const existing = locals.find(row => row.device_id === id);
      const finding: ConnectionFinding = {
        finding_id: id.padEnd(32, '_'), expires_in: options.expires || 300, action: existing ? 'unchanged' : 'created', verified: true,
        key_source: id === 'gateway' ? 'child' : 'device', interface_address: options.wrongFinding ? '192.168.20.10' : iface.address,
        requested_device_id: id, connection_device_id: id, route: 'direct',
        device: { device_id: id, existing_id: existing?.id || null, name: device.name, aliases: device.aliases || [], building_id: 1, room_id: 2,
          ip: snapshot.devices.find(row => row.device_id === id)!.ip, version: '3.5', changed_fields: existing ? [] : ['ip', 'version', 'local_key'], is_gateway: id === 'gateway' },
      };
      found.set(finding.finding_id, finding); return json(finding);
    }
    if (path.endsWith('/local-connections/save')) {
      expect(body).toEqual({ finding_id: body.finding_id, confirmed: true });
      const finding = found.get(body.finding_id)!;
      const failure = options.saveErrors?.[finding.device.device_id];
      if (failure === 'transport') throw new Error('Connection lost');
      if (failure) return json({ detail: 'Результат устарел' }, failure);
      const saved = { ...finding.device, id: finding.device.existing_id || 10, transport: 'wifi' as const,
        parent_id: null, cid: null, enabled: true, capabilities: {}, has_local_key: true };
      locals = [...locals.filter(row => row.device_id !== saved.device_id), saved];
      return json({ action: finding.action, device: saved, verified: true, key_source: finding.key_source, interface_address: iface.address }, 200);
    }
    throw new Error('Unexpected endpoint: ' + path);
  });
  return calls;
}
const flush = async () => { await act(async () => {}); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
function mount(extra: Partial<Parameters<typeof LocalConnectionsPage>[0]> = {}) {
  vi.useFakeTimers();
  const onAuthError = vi.fn(), onLock = vi.fn(), onConnections = vi.fn();
  return { ...render(<LocalConnectionsPage api={api} ready sharingReady developerReady={false} onAuthError={onAuthError} onConnections={onConnections} onLock={onLock} {...extra} />), onAuthError, onLock, onConnections };
}
async function start(include = false) {
  await flush();
  if (include) fireEvent.click(screen.getByRole('checkbox', { name: /Включить уже настроенные/ }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Сеть устройства' }), { target: { value: iface.address } });
  fireEvent.click(screen.getByRole('button', { name: 'Найти устройства' })); await flush();
}
async function discover(include = false) { await start(include); await tick(15_000); }
async function verify(names = [/Лямпа/]) {
  names.forEach(name => fireEvent.click(screen.getByRole('checkbox', { name })));
  fireEvent.click(screen.getByRole('button', { name: 'Проверить выбранные' })); await tick(names.length > 1 ? 11_000 : 1);
}
async function confirmSave() {
  fireEvent.click(screen.getByRole('checkbox', { name: /Подтверждаю сохранение/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить подключения' })); await flush();
}
const finds = (calls: ReturnType<typeof backend>) => calls.filter(call => call.path.endsWith('/find'));
const saves = (calls: ReturnType<typeof backend>) => calls.filter(call => call.path.endsWith('/save'));

describe('network configuration wizard', () => {
  it('starts with explicit actual network and an unchecked reconfiguration option; no device selector or scan on mount', async () => {
    const calls = backend(); mount(); await flush();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Сеть устройства' })).toHaveValue('');
    expect(screen.queryByRole('combobox', { name: 'Устройство' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Найти устройства' })).toBeDisabled();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('observes a full bounded window and matches only exact account IDs, excluding configured connections by default', async () => {
    const calls = backend(); mount(); await start(); await tick(14_000);
    expect(screen.getByText(/Ищем устройства/)).toBeInTheDocument(); expect(finds(calls)).toHaveLength(0);
    await tick(1000);
    expect(screen.getByRole('heading', { name: 'Найдено устройств: 1' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Лямпа/ })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /Шлюз/ })).toBeNull();
    expect(screen.getByText(/настроенных устройств пропущено: 1/)).toBeInTheDocument();
    expect(screen.getByText(/вне выбранного аккаунта: 1/)).toBeInTheDocument();
    expect(calls.some(call => call.method === 'DELETE' && call.path.endsWith('private-scan'))).toBe(true);
    expect(saves(calls)).toHaveLength(0);
  });
  it('includes configured gateways even if cloud sub is true when reconfiguration is explicitly requested', async () => {
    backend(); mount(); await discover(true);
    expect(screen.getByRole('checkbox', { name: /Шлюз/ })).toBeInTheDocument();
    expect(screen.getByText(/Уже настроено/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Найдено устройств: 2' })).toBeInTheDocument();
  });
  it.each([{ has_local_key: false }, { ip: null }, { version: null }])('keeps incomplete local configurations %j eligible despite cloud keys', async missing => {
    backend({ locals: [{ ...gateway, ...missing }] }); mount(); await discover();
    expect(screen.getByRole('checkbox', { name: /Шлюз/ })).toBeInTheDocument();
  });
  it('requires selection then read-only key verification and a separate explicit confirmation before saving', async () => {
    const calls = backend(); const { onLock } = mount(); await discover();
    expect(screen.getByRole('button', { name: 'Проверить выбранные' })).toBeDisabled();
    await verify();
    expect(finds(calls)[0].body).toEqual({ device_id: 'lamp', provider: 'sharing', interface_address: iface.address, discovery_seconds: 3 });
    expect(screen.getByRole('heading', { name: 'Подтвердите сохранение' })).toBeInTheDocument();
    expect(screen.getByText('Кухня')).toBeInTheDocument(); expect(screen.getByText('192.168.40.20')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Сохранить подключения' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox')); expect(saves(calls)).toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Сохранить подключения' }); fireEvent.click(button); fireEvent.click(button); await flush();
    expect(saves(calls)).toHaveLength(1); expect(saves(calls)[0].body).toEqual({ finding_id: 'lamp'.padEnd(32, '_'), confirmed: true });
    expect(screen.getByRole('link', { name: cloud[0].name })).toHaveAttribute('href', '#device/lamp?route=local');
    expect(onLock).toHaveBeenCalledWith(true); expect(onLock).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('heading', { name: 'Ещё не настроены: 1' })).toBeInTheDocument();
    expect(screen.getByText('Датчик Zigbee')).toBeInTheDocument();
  });
  it('spaces sequential verification to respect network announcement throttling and saves only successful previews', async () => {
    const calls = backend({ findErrors: { gateway: 409 } }); mount(); await discover(true); await verify([/Лямпа/, /Шлюз/]);
    expect(finds(calls)).toHaveLength(2); expect(finds(calls)[1].at - finds(calls)[0].at).toBeGreaterThanOrEqual(10_500);
    expect(screen.getByText('Проверка ключа не прошла')).toBeInTheDocument();
    await confirmSave(); expect(saves(calls)).toHaveLength(1);
    expect(screen.getByText('Проверка ключа не прошла')).toBeInTheDocument();
  });
  it('expires previews and requires a new check instead of automatically saving', async () => {
    const calls = backend({ expires: 2 }); mount(); await discover(); await verify();
    fireEvent.click(screen.getByRole('checkbox')); await tick(2100);
    expect(screen.getByRole('button', { name: 'Сохранить подключения' })).toBeDisabled();
    expect(screen.getByText(/Срок результата истёк/)).toBeInTheDocument(); expect(saves(calls)).toHaveLength(0);
  });
  it('changing the selection discards confirmation and verified previews', async () => {
    const calls = backend(); mount(); await discover(); await verify(); fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Изменить выбор' }));
    expect(screen.queryByRole('button', { name: 'Сохранить подключения' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Найдено устройств: 1' })).toBeInTheDocument(); expect(saves(calls)).toHaveLength(0);
  });
  it('cancels the receiver during search and ignores later results', async () => {
    const calls = backend(); mount(); await start(); fireEvent.click(screen.getByRole('button', { name: 'Отмена' })); await tick(16_000);
    expect(screen.getByRole('button', { name: 'Найти устройства' })).toBeInTheDocument();
    expect(calls.some(call => call.method === 'DELETE')).toBe(true); expect(finds(calls)).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: /Найдено устройств/ })).toBeNull();
  });
  it('cancels a verification while waiting between devices without an unhandled rejection or save', async () => {
    const calls = backend(); mount(); await discover(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Лямпа/ })); fireEvent.click(screen.getByRole('checkbox', { name: /Шлюз/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить выбранные' })); await tick(1);
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' })); await tick(12_000);
    expect(finds(calls)).toHaveLength(1); expect(saves(calls)).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Найдено устройств: 2' })).toBeInTheDocument();
  });
  it('cleans up observation on unmount', async () => {
    const calls = backend(); const view = mount(); await start(); view.unmount(); await flush();
    expect(calls.some(call => call.method === 'DELETE')).toBe(true); expect(saves(calls)).toHaveLength(0);
  });
  it('rejects a scan from another interface and a mismatched verification preview', async () => {
    backend({ wrongNetwork: true }); const first = mount(); await start(); expect(screen.getByRole('alert')).toHaveTextContent('другой сети'); first.unmount();
    backend({ wrongFinding: true }); mount(); await discover(); await verify();
    expect(screen.getByText(/неожиданный результат/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Сохранить подключения' })).toBeDisabled();
  });
  it('reports an empty search and lets the user finish with the actual unconfigured inventory', async () => {
    const calls = backend({ observed: [] }); mount(); await discover();
    expect(screen.getByRole('heading', { name: 'Найдено устройств: 0' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Завершить без сохранения' }));
    expect(screen.getByRole('heading', { name: 'Ещё не настроены: 2' })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText(cloud[0].name)).toBeInTheDocument(); expect(screen.getByText('Датчик Zigbee')).toBeInTheDocument(); expect(saves(calls)).toHaveLength(0);
  });
  it('reports partial save failures without retrying and keeps those devices unconfigured', async () => {
    const calls = backend({ saveErrors: { lamp: 409 } }); mount(); await discover(true); await verify([/Лямпа/, /Шлюз/]); await confirmSave();
    expect(saves(calls)).toHaveLength(2); expect(screen.getByText('Результат устарел')).toBeInTheDocument();
    expect(screen.getByText('Проверено: изменений нет')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ещё не настроены: 2' })).toBeInTheDocument();
  });
  it('reports uncertain saves without automatic retries; a new search reloads actual inventory', async () => {
    const calls = backend({ saveErrors: { lamp: 'transport' } }); mount(); await discover(); await verify(); await confirmSave();
    expect(screen.getByText(/Подключение могло сохраниться/)).toBeInTheDocument(); expect(saves(calls)).toHaveLength(1);
    const inventories = calls.filter(call => call.path === '/api/v1/devices').length;
    fireEvent.click(screen.getByRole('button', { name: 'Новый поиск' })); await flush();
    expect(calls.filter(call => call.path === '/api/v1/devices')).toHaveLength(inventories + 1);
  });
  it('offers settings without any network or account requests when disconnected', async () => {
    const calls = backend(); const { onConnections } = mount({ sharingReady: false }); await flush();
    expect(calls).toHaveLength(0); expect(screen.getByRole('button', { name: 'Найти устройства' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть подключения' })); expect(onConnections).toHaveBeenCalledOnce();
  });
  it('uses the explicitly connected Developer account for inventory and key verification', async () => {
    const calls = backend(); mount({ sharingReady: false, developerReady: true }); await discover(); await verify();
    expect(calls.find(call => call.path === '/api/v1/cloud/devices')?.provider).toBe('developer');
    expect(finds(calls)[0].body?.provider).toBe('developer');
  });
  it('handles authorization loss during discovery', async () => {
    backend({ scanError: 401 }); const { onAuthError } = mount(); await start();
    expect(onAuthError).toHaveBeenCalledOnce(); expect(screen.getByRole('alert')).toBeInTheDocument();
  });
  it('limits a batch to 16 selected devices to keep confirmation results bounded', async () => {
    const many = Array.from({ length: 18 }, (_, index) => ({ ...cloud[0], id: 'lamp-' + index, name: 'Лампа ' + index }));
    backend({ cloud: many, locals: [], observed: many.map((device, index) => announcement(device.id, '192.168.40.' + (30 + index))) });
    mount(); await discover();
    const choices = screen.getAllByRole('checkbox', { name: /^Выбрать Лампа / }); fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать первые 16 устройств' }));
    expect(choices[16]).toBeDisabled(); expect(choices[17]).toBeDisabled();
    fireEvent.click(choices[0]); expect(choices[16]).toBeEnabled(); fireEvent.click(choices[17]);
    expect(screen.getByRole('checkbox', { name: 'Выбрать первые 16 устройств' })).toBePartiallyChecked();
  });
  it('uses the table header checkbox to select, indicate a partial selection and clear all rows', async () => {
    backend(); mount(); await discover(true);
    expect(screen.getByRole('table', { name: 'Найденные устройства' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Выбрать все' })).toBeNull();
    const header = screen.getByRole('checkbox', { name: 'Выбрать все устройства' });
    const lamp = screen.getByRole('checkbox', { name: 'Выбрать ' + cloud[0].name });
    expect(header).not.toBeChecked(); fireEvent.click(lamp); expect(header).toBePartiallyChecked();
    fireEvent.click(header); expect(header).toBeChecked(); expect(screen.getByText('Выбрано: 2 из 2')).toBeInTheDocument();
    fireEvent.click(header); expect(header).not.toBeChecked(); expect(lamp).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Проверить выбранные' })).toBeDisabled();
  });
  it.each([null, 'saved-node'])('classifies a Zigbee child using its saved cid %s and gateway, without requiring its own key', async cid => {
    const child: LocalDevice = { ...gateway, id: 9, device_id: 'sensor', name: 'Датчик Zigbee', transport: 'zigbee', is_gateway: false,
      parent_id: 8, cid, has_local_key: false, ip: null, version: null };
    backend({ locals: [gateway, child] }); mount(); await discover();
    fireEvent.click(screen.getByRole('button', { name: 'Завершить без сохранения' }));
    expect(screen.getByRole('heading', { name: 'Ещё не настроены: ' + (cid ? 1 : 2) })).toBeInTheDocument();
  });
  it('lets the user finish after all key checks fail without any save', async () => {
    const calls = backend({ findErrors: { lamp: 409 } }); mount(); await discover(); await verify();
    expect(screen.getByRole('button', { name: 'Сохранить подключения' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Завершить без сохранения' }));
    expect(screen.getByRole('heading', { name: 'Результат настройки' })).toBeInTheDocument(); expect(saves(calls)).toHaveLength(0);
    expect(screen.getByText('Проверка ключа не прошла')).toBeInTheDocument();
  });
  it('ignores a late key verification response after cancellation even when the transport ignores abort', async () => {
    const calls = backend(); const original = vi.mocked(fetch).getMockImplementation()!;
    let resume!: () => Promise<void>;
    vi.mocked(fetch).mockImplementation((input, options) => {
      if (!String(input).endsWith('/find')) return original(input, options);
      return new Promise<Response>(resolve => { resume = async () => { resolve(await original(input, options)); }; });
    });
    mount(); await discover(); fireEvent.click(screen.getByRole('checkbox', { name: /Лямпа/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Проверить выбранные' })); await tick(1);
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' })); await act(async () => { await resume(); });
    expect(screen.queryByRole('heading', { name: 'Подтвердите сохранение' })).toBeNull(); expect(saves(calls)).toHaveLength(0);
  });
});
