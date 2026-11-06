import { renderWithStore } from './test/render-with-store';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  renderWithStore(<CloudControl api={new CloudApi(connection)} device={device} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
  return { writes, status };
}
const field = (name: string) => screen.getByRole('region', { name });
const edit = (name: string, value: string) => fireEvent.change(within(field(name)).getByRole('spinbutton'), { target: { value } });

describe('automatic device controls', () => {
  it('sends power immediately and coalesces numeric edits without Apply or an extra status request', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});
    const { writes } = cloud(), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Яркость' });
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Применить' })).toBeNull();
    const reads = vi.mocked(fetch).mock.calls.filter(([,init]) => init?.method === 'GET').length;
    await user.click(screen.getByRole('switch'));
    await waitFor(() => expect(writes).toEqual([{commands:[{code:'switch_led',value:true}]}]));
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    edit('Яркость', '60'); edit('Яркость', '65'); edit('Цветовая температура', '40');
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({commands:[{code:'bright_value_v2',value:650},{code:'temp_value_v2',value:400}]});
    expect(vi.mocked(fetch).mock.calls.filter(([,init]) => init?.method === 'GET')).toHaveLength(reads);
    expect(within(field('Яркость')).getByRole('spinbutton')).toHaveValue(65);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked','true');
  });

  it('does not send a number returned to its original value before the edit settles', async () => {
    const { writes } = cloud();
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65'); edit('Яркость', '50');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(writes).toEqual([]);
  });

  it('sends valid fields independently, rejects invalid values, and accepts zero', async () => {
    const { writes } = cloud();
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65'); edit('Цветовая температура', '200');
    expect(within(field('Цветовая температура')).getByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(writes).toEqual([{commands:[{code:'bright_value_v2',value:650}]}]));
    await waitFor(() => expect(within(field('Цветовая температура')).getByRole('spinbutton')).toBeEnabled());
    edit('Цветовая температура', '0');
    await waitFor(() => expect(writes[1]).toEqual({commands:[{code:'temp_value_v2',value:0}]}));
  });

  it('keeps rejected edits visible and never retries when the session becomes idle', async () => {
    const { writes } = cloud(true);
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65');
    await screen.findByText(/Устройство недоступно/);
    expect(within(field('Яркость')).getByRole('spinbutton')).toHaveValue(65);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(writes).toHaveLength(1);
  });

  it('edits color with precise controls and sends its mode automatically', async () => {
    const { writes } = cloud(), user = userEvent.setup();
    await screen.findByRole('region', { name: 'Цвет' });
    expect(within(field('Цвет')).queryByRole('slider')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Точная настройка цвета' }));
    expect(within(field('Цвет')).getAllByRole('slider')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Выбор цвета'), { target: { value: '#0000ff' } });
    await waitFor(() => expect(writes).toEqual([{commands:[{code:'work_mode',value:'colour'},{code:'colour_data_v2',value:{h:240,s:1000,v:1000}}]}]));
  });

  it('cancels a queued edit when the detail view closes', async () => {
    const { writes } = cloud();
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65');
    // Unmounting a card must cancel its pending debounce, not send later.
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(writes).toEqual([]);
  });

  it('sends the latest color edit with the correct implicit mode', async () => {
    const { writes } = cloud();
    await screen.findByRole('region', { name: 'Цвет' });
    fireEvent.change(screen.getByLabelText('Выбор цвета'), { target: { value: '#0000ff' } });
    edit('Яркость', '65');
    fireEvent.change(screen.getByLabelText('Выбор цвета'), { target: { value: '#ff0000' } });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({commands:[{code:'work_mode',value:'colour'},{code:'bright_value_v2',value:650},{code:'colour_data_v2',value:{h:0,s:1000,v:1000}}]});
  });

  it('sends a local edit through the existing capabilities endpoint', async () => {
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
    renderWithStore(<LocalControl api={new HomeApi(connection)} device={local} onClose={vi.fn()} onAuthError={vi.fn()} />);
    await screen.findByRole('region', { name: 'Яркость' });
    edit('Яркость', '65');
    await waitFor(() => expect(writes).toEqual([{path:'/api/v1/devices/1/commands/capabilities',body:{values:{brightness:65}}}]));
  });
});
