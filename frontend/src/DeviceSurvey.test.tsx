import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DeviceSurvey } from './components/DeviceSurvey';
import { ControlCenter } from './components/ControlCenter';
import { HomeApi } from './home-api';
import type { CloudDevice } from './api';
import type { DeviceDraft, Inventory, ObservationSession } from './home-api';

const connection = { baseUrl: 'http://survey-api.test', token: 'service-key' };
const cloudDevice = { id: 'lamp-1', name: 'Новая лампа', online: true, has_local_key: true };
const inventory: Inventory = {
  buildings: [{ id: 1, name: 'Дом', aliases: ['home'] }],
  rooms: [{ id: 2, building_id: 1, name: 'Кухня', aliases: ['kitchen'] }], groups: [], devices: [],
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function server(options: { failedSecond?: boolean; cloud?: boolean; registerFailure?: boolean; devices?: CloudDevice[] } = {}) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let samples = 0, draft: DeviceDraft | undefined;
  const session: ObservationSession = {
    session_id: 'observe-1', device_id: 'lamp-1', mode: options.cloud ? 'cloud' : 'local', expires_in: 900,
    interval_seconds: 3, sample_count: 0, has_local_key: true, readings: [], changes: [],
  };
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname, method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, ...(body ? { body } : {}) });
    if (path === '/api/v1/cloud/topology') return json({ synced_at: null, warnings: 0, placements: [], job: { status: 'idle', processed: 0, total: 0, message: null } });
    if (path === '/api/v1/buildings') return json(inventory.buildings);
    if (path === '/api/v1/rooms') return json(inventory.rooms);
    if (path === '/api/v1/groups' || path === '/api/v1/devices') return json([]);
    if (path === '/api/v1/cloud/devices') return json(options.devices || [cloudDevice]);
    if (path === '/api/v1/commissioning' && method === 'POST') { draft = body.draft; session.device_id = body.draft.device_id; return json(session, 201); }
    if (path.endsWith('/samples')) {
      samples++;
      if (options.failedSecond && samples === 2) return json({ detail: 'Устройство не ответило' }, 502);
      const row = { key: 'dp_1', code: 'switch_led', dp: '1', value: samples > 1, received_at: '2026-10-08T10:00:00Z', source: 'local' as const, can_write: !options.cloud };
      return json({ ...session, sample_count: samples, readings: [row], changes: samples > 1 ? [{ ...row, previous: false, action: body.action, detected_at: '2026-10-08T10:00:03Z' }] : [] });
    }
    if (path.endsWith('/register')) return options.registerFailure ? json({ detail: 'Устройство уже добавлено в дом.' }, 409) : json({ ...draft, id: 3, aliases: [], building_id: body.building_id, room_id: body.room_id, enabled: true, capabilities: {}, has_local_key: true }, 201);
    if (method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error('Unexpected survey request');
  });
  return calls;
}

function timedUser() {
  return {
    click: async (element: HTMLElement) => { await act(async () => { fireEvent.click(element); }); },
    type: async (element: HTMLElement, value: string) => { await act(async () => { fireEvent.change(element, { target: { value } }); }); },
    selectOptions: async (element: HTMLElement, value: string) => { await act(async () => { fireEvent.change(element, { target: { value } }); }); },
  };
}

function setup(extra?: Partial<React.ComponentProps<typeof DeviceSurvey>>) {
  const onClose = vi.fn(), onAuthError = vi.fn();
  const view = render(<DeviceSurvey api={new HomeApi(connection)} inventory={inventory} device={cloudDevice} provider="sharing" onClose={onClose} onAuthError={onAuthError} {...extra} />);
  return { ...view, onClose, onAuthError };
}

describe('device survey before registration', () => {
  const gateway = { id: 'gateway-real', name: 'Шлюз из Smart Life', category: 'wg2', sub: true, online: true, has_local_key: true };
  const sensor = { ...cloudDevice, name: 'Bath2 temperature', sub: true, node_id: 'actual-node' };

  it('lists real gateway candidates from the chosen cloud provider without choosing a parent', async () => {
    const calls = server({ devices: [sensor, gateway, { ...gateway, id: 'other', name: 'Лампа', category: 'dj' }] }), user = userEvent.setup();
    render(<ControlCenter api={new HomeApi(connection)} ready sharingReady onLock={vi.fn()} onAuthError={vi.fn()} />);
    const card = await screen.findByRole('listitem', { name: sensor.name });
    await user.click(within(card).getByRole('button', { name: 'Настроить локальное подключение' }));
    const select = screen.getByLabelText('Шлюз');
    expect(select).toHaveValue('');
    expect(within(select).getByRole('option', { name: gateway.name + ' · требуется локальная настройка' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /Лампа/ })).toBeNull();
    await user.selectOptions(select, 'cloud:' + gateway.id);
    expect(screen.getByRole('button', { name: 'Начать опрос' })).toBeDisabled();
    expect(screen.getByText(/Smart Life не передал эту связь/)).toBeInTheDocument();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('returns from gateway setup with the sensor draft intact and uses the saved numeric parent', async () => {
    vi.useFakeTimers(); const calls = server(), user = timedUser();
    const { onClose } = setup({ device: sensor, cloudDevices: [gateway], gatewayPlacements: [{ device_id: gateway.id, building_id: 1, room_id: 2 }] });
    await user.type(screen.getByLabelText('Название'), 'Датчик ванной');
    await user.selectOptions(screen.getByLabelText('Комната'), '2');
    await user.selectOptions(screen.getByLabelText('Шлюз'), 'cloud:' + gateway.id);
    await user.click(screen.getByRole('button', { name: 'Настроить выбранный шлюз' }));
    expect(screen.getByLabelText('Название')).toHaveValue(gateway.name);
    expect(screen.getByLabelText('Подключение устройства')).toHaveValue('gateway');
    expect(screen.getByLabelText('Подключение устройства')).toBeDisabled();
    expect(screen.getByLabelText('Комната')).toHaveValue('2');
    expect(screen.queryByRole('option', { name: 'Облачные отчёты Tuya' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByLabelText('Название')).toHaveValue('Датчик ванной');
    expect(screen.getByLabelText('cid / node_id')).toHaveValue('actual-node');
    expect(screen.getByLabelText('Комната')).toHaveValue('2');
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Настроить выбранный шлюз' }));
    await user.type(screen.getByLabelText('IP в домашней сети'), '192.168.1.50');
    await user.click(screen.getByRole('button', { name: 'Начать опрос' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await user.click(screen.getByRole('button', { name: 'Перейти к сохранению' }));
    await user.click(screen.getByLabelText('Я проверил показания и выбранные параметры'));
    await user.click(screen.getByRole('button', { name: 'Сохранить локальное подключение' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Название')).toHaveValue('Датчик ванной');
    expect(screen.getByLabelText('Шлюз')).toHaveValue('3');
    expect(within(screen.getByLabelText('Шлюз')).getAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Начать опрос' }));
    expect(calls.filter(call => call.path === '/api/v1/commissioning').map(call => call.body)).toEqual([
      { draft: { name: gateway.name, device_id: gateway.id, transport: 'wifi', is_gateway: true, ip: '192.168.1.50', version: '3.5', parent_id: null, cid: null }, mode: 'local', provider: 'sharing' },
      { draft: { name: 'Датчик ванной', device_id: sensor.id, transport: 'zigbee', is_gateway: false, ip: null, version: null, parent_id: 3, cid: 'actual-node' }, mode: 'local', provider: 'sharing' },
    ]);
    expect(calls.some(call => /commands|set_dps/.test(call.path))).toBe(false);
  });

  it('explains an empty gateway list and opens manual gateway setup without requests', async () => {
    const calls = server(), user = userEvent.setup();
    setup({ device: sensor });
    expect(screen.getByRole('option', { name: 'Нет настроенных шлюзов' })).toBeInTheDocument();
    expect(screen.getByText(/В этом подключении Smart Life шлюзы не найдены/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Настроить другой шлюз вручную' }));
    expect(screen.getByLabelText('Подключение устройства')).toHaveValue('gateway');
    expect(screen.getByLabelText(/Локальный ключ/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('opens the survey from a cloud card before registering anything', async () => {
    const calls = server(), user = userEvent.setup();
    render(<ControlCenter api={new HomeApi(connection)} ready sharingReady onLock={vi.fn()} onAuthError={vi.fn()} />);
    const card = await screen.findByRole('listitem', { name: cloudDevice.name });
    await user.click(within(card).getByRole('button', { name: 'Настроить локальное подключение' }));
    expect(screen.getByRole('heading', { name: 'Настроить локальное подключение' })).toBeInTheDocument();
    expect(screen.getByLabelText('Tuya device ID')).toHaveValue(cloudDevice.id);
    expect(screen.getByLabelText('Название')).toHaveValue(cloudDevice.name);
    expect(screen.getByLabelText('Источник показаний')).toHaveValue('local');
    expect(screen.queryByLabelText('Локальный ключ')).toBeNull();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(screen.getByRole('button', { name: 'Начать опрос' })).toBeDisabled();
  });

  it('records owner actions, pauses for review, and saves only after explicit review', async () => {
    vi.useFakeTimers();
    const calls = server(), user = timedUser();
    const { onClose } = setup();
    await user.type(screen.getByLabelText('IP в домашней сети'), '192.168.1.40');
    await user.selectOptions(screen.getByLabelText('Комната'), '2');
    await user.type(screen.getByLabelText('Алиасы через запятую'), 'kitchen_light, main_light');
    await user.click(screen.getByRole('button', { name: 'Начать опрос' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('heading', { name: 'Проверьте устройство' })).toBeInTheDocument();
    expect(screen.getByText('Выкл / нет')).toBeInTheDocument();
    expect(screen.getByText('Изменений пока нет. Исходное состояние не считается изменением.')).toBeInTheDocument();
    expect(calls.some(call => call.path.endsWith('/register'))).toBe(false);
    await user.selectOptions(screen.getByLabelText('Что проверяем'), 'power');
    expect(screen.getByText(/Включите устройство физической кнопкой/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText('Выкл / нет → Вкл / да')).toBeInTheDocument();
    expect(calls.filter(call => call.path.endsWith('/samples'))[1].body).toEqual({ action: 'power' });
    await user.click(screen.getByRole('button', { name: 'Перейти к сохранению' }));
    const pollCount = calls.filter(call => call.path.endsWith('/samples')).length;
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(calls.filter(call => call.path.endsWith('/samples'))).toHaveLength(pollCount);
    expect(screen.getByRole('button', { name: 'Сохранить локальное подключение' })).toBeDisabled();
    expect(screen.getByLabelText('Разрешить управление: Питание')).not.toBeChecked();
    await user.click(screen.getByLabelText('Разрешить управление: Питание'));
    await user.click(screen.getByLabelText('Я проверил показания и выбранные параметры'));
    await user.click(screen.getByRole('button', { name: 'Сохранить локальное подключение' }));
    expect(calls.find(call => call.path.endsWith('/register'))?.body).toEqual({ name: cloudDevice.name, aliases: ['kitchen_light', 'main_light'], building_id: null, room_id: 2, reviewed: true, writable: ['dp_1'] });
    expect(onClose).toHaveBeenCalledOnce();
    expect(calls.some(call => /commands|set_dps/.test(call.path))).toBe(false);
    expect(calls.find(call => call.path === '/api/v1/commissioning')?.body).toEqual({ draft: { name: cloudDevice.name, device_id: cloudDevice.id, transport: 'wifi', is_gateway: false, ip: '192.168.1.40', version: '3.5', parent_id: null, cid: null }, mode: 'local', provider: 'sharing' });
  });

  it('cancels without saving and ignores an in-flight late sample', async () => {
    vi.useFakeTimers(); const calls = server(), user = timedUser();
    const view = setup();
    await user.type(screen.getByLabelText('IP в домашней сети'), '192.168.1.40');
    await user.click(screen.getByRole('button', { name: 'Начать опрос' }));
    const original = vi.mocked(fetch).getMockImplementation()!;
    let finish: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/samples') ? new Promise(resolve => { finish = resolve; }) : original(input, init));
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.unmount();
    await act(async () => finish?.(json({ session_id: 'observe-1', readings: [{ value: true }] })));
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect(calls.some(call => call.path.endsWith('/register'))).toBe(false);
  });

  it('keeps the last actual reading after a failed poll and can resume after pause', async () => {
    vi.useFakeTimers(); const calls = server({ failedSecond: true }), user = timedUser();
    setup();
    await user.type(screen.getByLabelText('IP в домашней сети'), '192.168.1.40');
    await user.click(screen.getByRole('button', { name: 'Начать опрос' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('alert')).toHaveTextContent('Устройство не ответило');
    expect(screen.getByText('Выкл / нет')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Пауза' }));
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(calls.filter(call => call.path.endsWith('/samples'))).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Продолжить' }));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(calls.filter(call => call.path.endsWith('/samples'))).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers cloud observation without LAN details and never enables local writes from it', async () => {
    vi.useFakeTimers(); server({ cloud: true }); const user = timedUser();
    setup({ device: { ...cloudDevice, has_local_key: false } });
    await user.selectOptions(screen.getByLabelText('Источник показаний'), 'cloud');
    expect(screen.getByRole('button', { name: 'Начать опрос' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Начать опрос' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await user.click(screen.getByRole('button', { name: 'Перейти к сохранению' }));
    expect(screen.getByText(/Облачные значения не сохраняются/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Разрешить управление: Питание')).toBeNull();
  });

  it('requires an explicit gateway and cid for Zigbee, without a child key field', async () => {
    const calls = server(), user = userEvent.setup();
    setup({ device: { ...cloudDevice, sub: true, node_id: 'node-1' }, inventory: { ...inventory, devices: [{ id: 7, device_id: 'gateway-1', name: 'Шлюз', is_gateway: true, aliases: [], transport: 'wifi', building_id: 1, room_id: null, parent_id: null, cid: null, enabled: true, capabilities: {} }] } });
    expect(screen.getByLabelText('cid / node_id')).toHaveValue('node-1');
    expect(screen.queryByLabelText('Локальный ключ')).toBeNull();
    expect(screen.queryByLabelText('IP в домашней сети')).toBeNull();
    expect(screen.getByRole('button', { name: 'Начать опрос' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Шлюз'), '7');
    await user.click(screen.getByRole('button', { name: 'Начать опрос' }));
    expect(calls.find(call => call.path === '/api/v1/commissioning')?.body).toEqual({ draft: { name: cloudDevice.name, device_id: cloudDevice.id, transport: 'zigbee', is_gateway: false, ip: null, version: null, parent_id: 7, cid: 'node-1' }, mode: 'local', provider: 'sharing' });
  });
});
