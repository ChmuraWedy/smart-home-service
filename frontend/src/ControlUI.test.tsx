import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { HomeApi } from './home-api';
import type { Capability, DeviceState, LocalDevice } from './home-api';
import { CloudControl } from './components/CloudControl';
import { ControlCenter } from './components/ControlCenter';
import { LocalControl, GroupControl } from './components/LocalControls';

const connection = { baseUrl: 'http://api.test:8765', token: 'test-service-key' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const boolean: Capability = { type: 'boolean', readable: true, writable: true };
const light: LocalDevice = { id: 1, device_id: 'wifi-lamp', name: 'Лампа кухни', aliases: ['kitchen_light', 'лампа кухни'], building_id: 1, room_id: 1, transport: 'wifi', parent_id: null, cid: null, enabled: true,
  capabilities: { switch: boolean, brightness: { type: 'number', readable: true, writable: true, minimum: 1, maximum: 100, step: 1, unit: '%' }, color: { type: 'object', encoding: 'tuya_hsv', readable: true, writable: true } } };
const child: LocalDevice = { ...light, id: 2, device_id: 'zigbee-lamp', name: 'Лампа Zigbee', aliases: ['child_light'], transport: 'zigbee', parent_id: 9, cid: 'child-node' };
const thermostat: LocalDevice = { ...light, id: 3, device_id: 'thermostat', name: 'Термостат', aliases: ['heater'], room_id: 2,
  capabilities: { target_temperature: { type: 'number', readable: true, writable: true, minimum: 5, maximum: 35, step: .5, unit: '°C' }, temperature: { type: 'number', readable: true, writable: false, unit: '°C' }, mode: { type: 'integer', readable: true, writable: true, enum: [0, 1] } } };
const sensor: LocalDevice = { ...child, id: 4, name: 'Датчик', aliases: ['sensor'], capabilities: { humidity: { type: 'number', readable: true, writable: false, unit: '%' }, motion: { type: 'boolean', readable: true, writable: false } } };
const group = { id: 1, name: 'Свет кухни', room_id: 1, device_ids: [1, 2] };
const cloudDevice = { id: 'cloud-lamp', name: 'Облачная лампа', online: true, has_local_key: false };

function localServer(options: { partial?: boolean; postError?: boolean; disabled?: boolean; stale?: boolean } = {}) {
  const devices = [light, child, thermostat, sensor];
  const states: Record<number, DeviceState> = {};
  for (const device of devices) states[device.id] = { device_id: device.id, name: device.name, enabled: !options.disabled, available: true,
    values: Object.fromEntries(Object.keys(device.capabilities).map(key => [key, { value: key === 'switch' ? false : key === 'color' ? { h: 0, s: 1000, v: 1000 } : key === 'motion' ? null : key === 'mode' ? 0 : key === 'target_temperature' ? 22.5 : 45,
      known: key !== 'motion', stale: !!options.stale, observed_at: new Date().toISOString() }])) };
  const writes: { path: string; body?: unknown }[] = [], reads: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input)), path = url.pathname, method = init?.method;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    expect((init?.headers as Record<string, string>)['X-API-Key']).toBe(connection.token);
    if (method === 'POST') {
      writes.push({ path, body });
      if (options.postError) return json({ detail: 'Transport timeout' }, 504);
      if (path.includes('/groups/')) return json({ all_acknowledged: !options.partial, results: [{ device_id: 1, acknowledged: true }, { device_id: 2, acknowledged: !options.partial }] });
      return json({ acknowledged: true }); // Intentionally does not fabricate state.
    }
    reads.push(url.pathname + url.search);
    if (path.endsWith('/buildings')) return json([{ id: 1, name: 'Дом', aliases: ['home'] }]);
    if (path.endsWith('/rooms')) return json([{ id: 1, name: 'Кухня', building_id: 1, aliases: ['kitchen'] }, { id: 2, name: 'Спальня', building_id: 1, aliases: ['bedroom'] }]);
    if (path.endsWith('/devices')) return json(devices);
    if (path.endsWith('/groups')) return json([group]);
    if (path.includes('/groups/')) return json({ group_id: 1, state: 'off', members: [states[1], states[2]] });
    const id = Number(path.split('/')[4]);
    if (path.endsWith('/state')) return json(states[id]);
    return json(devices.find(device => device.id === id));
  });
  return { writes, reads, states };
}

function cloudServer(options: { offline?: boolean; postReadError?: boolean; postError?: boolean; pending?: boolean } = {}) {
  const functions = [{ code: 'switch_led', type: 'Boolean', values: '{}' }, { code: 'work_mode', type: 'Enum', values: '{"range":["white","colour"]}' }, { code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000,"step":10,"scale":0}' }, { code: 'colour_data_v2', type: 'Json', values: '{}' }];
  const ranges = [{ code: 'temp_current', type: 'Integer', values: '{"scale":1,"unit":"°C"}' }];
  const writes: unknown[] = [], providers: string[] = [];
  let resolvePost: (value: Response) => void = () => {};
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input)); providers.push(url.searchParams.get('provider')!);
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)));
      if (options.pending) return new Promise<Response>(resolve => { resolvePost = resolve; });
      if (options.postError) return json({ detail: 'No acknowledgement' }, 502);
      return json({ acknowledged: true, state_confirmed: false });
    }
    if (options.postReadError && writes.length) return json({ detail: 'Read unavailable' }, 503);
    if (url.pathname.endsWith('/functions')) return json({ device_id: 'cloud-lamp', functions, status_range: ranges });
    return json({ device_id: 'cloud-lamp', source: 'cloud', online: !options.offline, status_range: ranges, status: { switch_led: false, bright_value_v2: 500, work_mode: 'white', colour_data_v2: '{"h":0,"s":1000,"v":1000}', temp_current: 215 } });
  });
  return { writes, providers, resolve: () => resolvePost(json({ acknowledged: true, state_confirmed: false })) };
}

describe('cloud device control', () => {
  it.each(['sharing', 'developer'] as const)('sends one explicit %s command and keeps the observed state separate from ACK', async provider => {
    const server = cloudServer(); const user = userEvent.setup();
    render(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider={provider} onClose={vi.fn()} onAuthError={vi.fn()} />);
    const power = await screen.findByRole('region', { name: 'Питание' });
    await user.click(within(power).getByRole('button', { name: 'Включить' }));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(server.writes).toEqual([{ commands: [{ code: 'switch_led', value: true }] }]);
    expect(server.providers.every(value => value === provider)).toBe(true);
    expect(within(power).getByText('Выключено')).toBeInTheDocument();
    expect(within(power).getByRole('button', { name: 'Включить' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('21.5 °C')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Температура' })).queryByRole('button')).toBeNull();
  });
  it('stages brightness/color without writes, then applies them with their matching mode', async () => {
    const server = cloudServer(); const user = userEvent.setup();
    render(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const brightness = await screen.findByRole('region', { name: 'Яркость' });
    fireEvent.change(within(brightness).getByRole('slider'), { target: { value: '65' } });
    expect(server.writes).toHaveLength(0);
    await user.click(within(brightness).getByRole('button', { name: 'Применить' }));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(server.writes[0]).toEqual({ commands: [{ code: 'work_mode', value: 'white' }, { code: 'bright_value_v2', value: 650 }] });
    const color = screen.getByRole('region', { name: 'Цвет' });
    fireEvent.change(within(color).getByLabelText('Выбор цвета'), { target: { value: '#00ff00' } });
    await user.click(within(color).getByRole('button', { name: 'Применить' }));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(server.writes[1]).toEqual({ commands: [{ code: 'work_mode', value: 'colour' }, { code: 'colour_data_v2', value: { h: 120, s: 1000, v: 1000 } }] });
  });
  it('disables writes for an offline device while preserving read-only status', async () => {
    const server = cloudServer({ offline: true });
    render(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    await screen.findByText('Устройство не в сети. Обновите статус после восстановления связи.');
    expect(screen.getByRole('button', { name: 'Включить' })).toBeDisabled();
    expect(server.writes).toHaveLength(0);
  });
  it('distinguishes accepted command from a failed follow-up status and never retries the command', async () => {
    const server = cloudServer({ postReadError: true }); const user = userEvent.setup();
    render(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Включить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Команда принята. Обновить статус не удалось');
    expect(server.writes).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Включить' })).toBeDisabled();
  });
  it('guards rapid duplicate input and prevents closing while a command is pending', async () => {
    const server = cloudServer({ pending: true }); const close = vi.fn();
    render(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={close} onAuthError={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Включить' });
    fireEvent.click(button); fireEvent.click(button);
    expect(server.writes).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeDisabled();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(close).not.toHaveBeenCalled();
    await act(async () => { server.resolve(); });
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeEnabled();
  });
});

describe('local device and group controls', () => {
  it.each([light, child])('addresses $transport device by its own inventory ID without parent/key in the browser command', async device => {
    const server = localServer(); const user = userEvent.setup();
    render(<LocalControl api={new HomeApi(connection)} device={device} onClose={vi.fn()} onAuthError={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Включить' }));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(server.writes).toEqual([{ path: `/api/v1/devices/${device.id}/commands/capabilities`, body: { values: { switch: true } } }]);
    expect(server.reads).toContain(`/api/v1/devices/${device.id}/state?refresh=true&max_age=60`);
    expect(screen.getByText('Выключено')).toBeInTheDocument();
  });
  it('applies a temperature step and typed enum while keeping measured temperature read-only', async () => {
    const server = localServer(); const user = userEvent.setup();
    render(<LocalControl api={new HomeApi(connection)} device={thermostat} onClose={vi.fn()} onAuthError={vi.fn()} />);
    const target = await screen.findByRole('region', { name: 'Заданная температура' });
    fireEvent.change(within(target).getByRole('spinbutton'), { target: { value: '23' } });
    await user.click(within(target).getByRole('button', { name: 'Применить' }));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(server.writes[0].body).toEqual({ values: { target_temperature: 23 } });
    const mode = screen.getByRole('region', { name: 'Режим' });
    await user.selectOptions(within(mode).getByRole('combobox'), '1');
    await user.click(within(mode).getByRole('button', { name: 'Применить' }));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(server.writes[1].body).toEqual({ values: { mode: 1 } });
    expect(within(screen.getByRole('region', { name: 'Температура' })).queryByRole('spinbutton')).toBeNull();
  });
  it('shows stale humidity and unknown motion without false values or write controls', async () => {
    localServer({ stale: true });
    render(<LocalControl api={new HomeApi(connection)} device={sensor} onClose={vi.fn()} onAuthError={vi.fn()} />);
    await screen.findByText('Устарело');
    expect(within(screen.getByRole('region', { name: 'Движение' })).getByText('Нет данных')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Включить' })).toBeNull();
  });
  it('reports partial group acknowledgement by member and requests statuses separately', async () => {
    const server = localServer({ partial: true }); const user = userEvent.setup();
    render(<GroupControl api={new HomeApi(connection)} group={group} onClose={vi.fn()} onDevice={vi.fn()} onAuthError={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Включить группу' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Команда принята 1 из 2 устройств. Не подтверждено: Лампа Zigbee.');
    expect(server.writes).toEqual([{ path: '/api/v1/groups/1/commands/on', body: undefined }]);
    expect(server.reads).toContain('/api/v1/devices/1/state?refresh=true&max_age=60');
    expect(server.reads).toContain('/api/v1/devices/2/state?refresh=true&max_age=60');
    expect(screen.getByText('Все выключены')).toBeInTheDocument();
  });
  it('filters a room and aliases, opens group member controls, and never polls LAN just to browse', async () => {
    const server = localServer(); const user = userEvent.setup();
    render(<ControlCenter api={new HomeApi(connection)} ready onAuthError={vi.fn()} onLock={vi.fn()} />);
    await screen.findByText('Лампа кухни');
    expect(server.reads.some(path => path.includes('refresh=true'))).toBe(false);
    await user.selectOptions(screen.getByLabelText('Комната'), '2');
    expect(screen.getByText('Термостат')).toBeInTheDocument(); expect(screen.queryByText('Лампа кухни')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Комната'), '');
    await user.type(screen.getByRole('searchbox'), 'CHILD_LIGHT');
    expect(screen.getByText('Лампа Zigbee')).toBeInTheDocument(); expect(screen.queryByText('Лампа кухни')).toBeNull();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('button', { name: 'Открыть группу' }));
    const dialog = await screen.findByRole('dialog', { name: 'Свет кухни' });
    await within(dialog).findByText('Все выключены');
    await user.click(within(dialog).getAllByRole('button', { name: 'Управлять устройством' })[1]);
    const deviceDialog = await screen.findByRole('dialog', { name: 'Лампа Zigbee' });
    await screen.findByText('Команды передаются через настроенный шлюз.');
    await user.click(within(deviceDialog).getByRole('button', { name: 'Назад к группе' }));
    expect(await screen.findByRole('dialog', { name: 'Свет кухни' })).toBeInTheDocument();
    expect(server.writes).toHaveLength(0);
  });
  it('clears the previous server inventory before a replacement server responds', async () => {
    localServer(); const onAuthError = vi.fn(), onLock = vi.fn();
    const view = render(<ControlCenter api={new HomeApi(connection)} ready onAuthError={onAuthError} onLock={onLock} />);
    await screen.findByText('Лампа кухни');
    vi.mocked(fetch).mockImplementation((input, init) => {
      expect(String(input)).toContain('http://other-api.test');
      expect((init?.headers as Record<string,string>)['X-API-Key']).toBe('new-service-key');
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    });
    view.rerender(<ControlCenter api={new HomeApi({ baseUrl:'http://other-api.test',token:'new-service-key' })} ready onAuthError={onAuthError} onLock={onLock} />);
    expect(screen.queryByText('Лампа кухни')).toBeNull();
    expect(screen.queryByRole('button', { name:'Управлять' })).toBeNull();
    expect(screen.getByText('Загружаем список…')).toBeInTheDocument();
  });
  it('disables a locally disabled device and reports a command timeout without retry', async () => {
    localServer({ disabled: true });
    const first = render(<LocalControl api={new HomeApi(connection)} device={light} onClose={vi.fn()} onAuthError={vi.fn()} />);
    await screen.findByText('Устройство или его шлюз отключены в настройках сервиса.');
    expect(screen.getByRole('button', { name: 'Включить' })).toBeDisabled(); first.unmount();
    const server = localServer({ postError: true });
    render(<LocalControl api={new HomeApi(connection)} device={light} onClose={vi.fn()} onAuthError={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Включить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('результат команды неизвестен');
    expect(server.writes).toHaveLength(1);
  });
});
