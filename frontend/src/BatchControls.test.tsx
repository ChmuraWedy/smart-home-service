import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { HomeApi, type LocalDevice } from './home-api';
import { CloudControl } from './components/CloudControl';
import { LocalControl } from './components/LocalControls';

const connection = { baseUrl: 'http://api.test:8765', token: 'test-service-key' };
const device = { id: 'batch-lamp', name: 'Лампа', online: true, has_local_key: false };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function cloud(error = false) {
  const writes: unknown[] = [];
  const status = { switch_led: false, work_mode: 'white', bright_value_v2: 500, temp_value_v2: 200, colour_data_v2: { h: 40, s: 800, v: 700 } };
  const functions = [
    { code: 'switch_led', type: 'Boolean', values: '{}' },
    { code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour'] } },
    { code: 'bright_value_v2', type: 'Integer', values: { min: 10, max: 1000, step: 1 } },
    { code: 'temp_value_v2', type: 'Integer', values: { min: 0, max: 1000, step: 1 } },
    { code: 'colour_data_v2', type: 'Json', values: '{}' },
  ];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)));
      return error ? json({ detail: 'Устройство недоступно' }, 409) : json({ acknowledged: true });
    }
    if (new URL(String(input)).pathname.endsWith('/functions')) return json({ device_id: device.id, functions });
    return json({ device_id: device.id, online: true, source: 'cloud', status });
  });
  render(<CloudControl api={new CloudApi(connection)} device={device} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
  return { writes, status };
}
const field = (name: string) => screen.getByRole('region', { name });
const edit = (name: string, value: string) => fireEvent.change(within(field(name)).getByRole('spinbutton'), { target: { value } });
const apply = () => screen.getByRole('button', { name: 'Применить' });

describe('one Apply for a device card', () => {
  it('stages power and numeric edits, sends only changed values in one request, and retains targets over an old cloud snapshot', async () => {
    const { writes } = cloud(), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Яркость' });
    expect(screen.getAllByRole('button', { name: 'Применить' })).toHaveLength(1);
    edit('Яркость', '65'); edit('Цветовая температура', '40');
    await user.click(screen.getByRole('switch'));
    expect(writes).toEqual([]);
    expect(await screen.findByText('Изменено: 3')).toBeInTheDocument();
    await user.click(apply());
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(writes).toEqual([{ commands: [
      { code: 'bright_value_v2', value: 650 }, { code: 'temp_value_v2', value: 400 }, { code: 'switch_led', value: true },
    ] }]);
    expect(within(field('Яркость')).getByRole('spinbutton')).toHaveValue(65);
    expect(within(field('Цветовая температура')).getByRole('spinbutton')).toHaveValue(40);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(apply()).toBeDisabled();
  });

  it('excludes edits returned to the initial value, including a false power value', async () => {
    const { writes } = cloud(), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65'); edit('Яркость', '50');
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('switch'));
    await waitFor(() => expect(apply()).toBeDisabled());
    expect(screen.queryByText(/Изменено:/)).toBeNull();
    expect(writes).toEqual([]);
  });

  it('validates every changed field before sending any command and includes a zero value', async () => {
    const { writes } = cloud(), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65'); edit('Цветовая температура', '200');
    expect(apply()).toBeDisabled();
    expect(within(field('Цветовая температура')).getByRole('alert')).toBeInTheDocument();
    await user.click(apply()); expect(writes).toEqual([]);
    edit('Цветовая температура', '0');
    await user.click(apply());
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes).toEqual([{ commands: [{ code: 'bright_value_v2', value: 650 }, { code: 'temp_value_v2', value: 0 }] }]);
  });

  it('keeps all edits after rejection and never retries automatically', async () => {
    const { writes } = cloud(true), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65'); edit('Цветовая температура', '40');
    await user.click(apply());
    await screen.findByText(/Устройство недоступно/);
    expect(screen.getByText('Изменено: 2')).toBeInTheDocument();
    expect(within(field('Яркость')).getByRole('spinbutton')).toHaveValue(65);
    expect(within(field('Цветовая температура')).getByRole('spinbutton')).toHaveValue(40);
    expect(apply()).toBeEnabled();
    expect(writes).toHaveLength(1);
  });

  it('offers only a color picker by default, expands precise controls, and gives an explicit light mode precedence without duplicate commands', async () => {
    const { writes } = cloud(), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Цвет' });
    expect(within(field('Цвет')).queryByRole('slider')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Точная настройка цвета' }));
    expect(within(field('Цвет')).getAllByRole('slider')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Выбор цвета'), { target: { value: '#0000ff' } });
    edit('Яркость', '65');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Режим' }), '1');
    await user.click(apply());
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes).toEqual([{ commands: [
      { code: 'work_mode', value: 'colour' }, { code: 'colour_data_v2', value: { h: 240, s: 1000, v: 1000 } }, { code: 'bright_value_v2', value: 650 },
    ] }]);
  });

  it('compares against the original value even when a refresh updates the live reading during editing', async () => {
    const { writes, status } = cloud(), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65'); status.bright_value_v2 = 700;
    await user.click(screen.getByRole('button', { name: 'Обновить статус' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Обновить статус' })).toBeEnabled());
    expect(within(field('Яркость')).getByRole('spinbutton')).toHaveValue(65);
    edit('Яркость', '50');
    expect(apply()).toBeDisabled();
    expect(writes).toEqual([]);
    // No command is needed after reverting; the latest observed value can be shown.
    await waitFor(() => expect(within(field('Яркость')).getByRole('spinbutton')).toHaveValue(70));
  });

  it('uses the latest light edit for an implicit mode when no explicit mode was changed', async () => {
    const { writes } = cloud(), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Цвет' });
    fireEvent.change(screen.getByLabelText('Выбор цвета'), { target: { value: '#0000ff' } });
    edit('Яркость', '65');
    fireEvent.change(screen.getByLabelText('Выбор цвета'), { target: { value: '#ff0000' } });
    await user.click(apply());
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes).toEqual([{ commands: [
      { code: 'work_mode', value: 'colour' }, { code: 'bright_value_v2', value: 650 }, { code: 'colour_data_v2', value: { h: 0, s: 1000, v: 1000 } },
    ] }]);
  });

  it('sends a local device batch through the existing capabilities endpoint', async () => {
    const local: LocalDevice = { id: 1, device_id: 'local-lamp', name: 'Локальная лампа', aliases: [], building_id: null, room_id: null,
      transport: 'wifi', parent_id: null, cid: null, enabled: true, capabilities: {
        switch: { type: 'boolean', readable: true, writable: true }, brightness: { type: 'number', readable: true, writable: true, minimum: 0, maximum: 100, unit: '%' },
      } };
    const writes: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'POST') { writes.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init.body)) }); return json({ acknowledged: true }); }
      if (new URL(String(input)).pathname.endsWith('/state')) return json({ device_id: 1, enabled: true, available: true, values: {
        switch: { value: true, known: true, stale: false }, brightness: { value: 50, known: true, stale: false },
      } });
      return json(local);
    });
    render(<LocalControl api={new HomeApi(connection)} device={local} onClose={vi.fn()} onAuthError={vi.fn()} />);
    const user = userEvent.setup();
    await screen.findByRole('region', { name: 'Яркость' });
    await user.click(screen.getByRole('switch')); edit('Яркость', '65');
    expect(writes).toEqual([]);
    await user.click(apply());
    await waitFor(() => expect(writes).toEqual([{ path: '/api/v1/devices/1/commands/capabilities', body: { values: { switch: false, brightness: 65 } } }]));
  });
});
