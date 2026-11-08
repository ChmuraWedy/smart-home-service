import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ControlCenter } from './components/ControlCenter';
import { renderWithStore } from './test/render-with-store';
import { HomeApi } from './home-api';
import type { LocalDevice, Topology } from './home-api';

const api = () => new HomeApi({ baseUrl: 'http://topology.test', token: 'test-key' });
const lamp = { id: 'lamp', name: 'Лампа', online: true, has_local_key: true };
const job = { status: 'idle' as const, processed: 0, total: 0, message: null };
const topology: Topology = { synced_at: '2026-10-09T10:00:00Z', warnings: 0, empty_rooms_available: false, placements: [{ device_id: 'lamp', building_id: 1, room_id: 2 }], job };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function server(options: { local?: LocalDevice; syncFails?: boolean; empty?: boolean } = {}) {
  const calls: { path: string; method: string }[] = [];
  let syncing = false, reads = 0, complete = !options.empty;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname, method = init?.method || 'GET';
    calls.push({ path, method });
    if (path.endsWith('/topology/sync')) { syncing = true; reads = 0; return json({ ...job, status: 'running' }); }
    if (path.endsWith('/topology')) {
      if (syncing) {
        reads++;
        if (reads === 1) return json({ ...topology, placements: [], job: { ...job, status: 'running', total: 1 } });
        complete = !options.syncFails;
        return json({ ...topology, placements: complete ? topology.placements : [], job: { ...job, status: complete ? 'done' : 'failed', processed: 1, total: 1, message: complete ? null : 'Не удалось синхронизировать Smart Life.' } });
      }
      return json({ ...topology, placements: complete ? topology.placements : [], synced_at: complete ? topology.synced_at : null });
    }
    if (path.endsWith('/cloud/devices')) return json([lamp]);
    if (path.endsWith('/buildings')) return json([{ id: 1, name: 'Дом', aliases: [] }]);
    if (path.endsWith('/rooms')) return json(complete ? [{ id: 2, building_id: 1, name: 'Кухня', aliases: [] }] : []);
    if (path === '/api/v1/devices') return json(options.local ? [options.local] : []);
    if (path.endsWith('/groups')) return json([]);
    if (path.endsWith('/functions')) return json({ device_id: 'lamp', functions: [] });
    if (path.endsWith('/status')) return json({ device_id: 'lamp', online: true, status: {} });
    if (path.endsWith('/state')) return json({ device_id: 5, enabled: true, available: false, values: {} });
    throw new Error('Unexpected topology test request');
  });
  return calls;
}

function setup(developerReady = false) { return renderWithStore(<ControlCenter api={api()} ready sharingReady developerReady={developerReady} onAuthError={vi.fn()} />); }

describe('Smart Life topology', () => {
  it.each(['sharing', 'developer'])('uses cached placement for room filtering and survey via %s without registration or sync', async provider => {
    const calls = server(), user = userEvent.setup(); setup(true);
    const card = await screen.findByRole('listitem', { name: 'Лампа' });
    expect(await within(card).findByText('Кухня')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Комната'), '2');
    expect(card).toBeInTheDocument();
    await user.selectOptions(within(card).getByRole('combobox'), provider);
    await user.click(within(card).getByRole('button', { name: 'Настроить локальное подключение' }));
    expect(screen.getByLabelText('Здание')).toHaveValue('1');
    expect(screen.getByLabelText('Комната')).toHaveValue('2');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.some(call => /\/status|\/functions|\/commissioning/.test(call.path))).toBe(false);
  });

  it('waits for cached placement before allowing the cloud registration wizard to open', async () => {
    server(); const normal = vi.mocked(fetch).getMockImplementation()!;
    let release!: () => void;
    vi.mocked(fetch).mockImplementation((input, init) => new URL(String(input)).pathname.endsWith('/topology')
      ? new Promise<Response>(resolve => { release = () => resolve(json(topology)); }) : normal(input, init));
    setup(); const user = userEvent.setup();
    const card = await screen.findByRole('listitem', { name: 'Лампа' });
    expect(within(card).getByRole('button', { name: 'Настроить локальное подключение' })).toBeDisabled();
    await act(async () => { release(); });
    await user.click(within(card).getByRole('button', { name: 'Настроить локальное подключение' }));
    expect(screen.getByLabelText('Комната')).toHaveValue('2');
  });

  it('preserves a local manually cleared room instead of overriding it with cloud placement', async () => {
    server({ local: { id: 5, device_id: 'lamp', name: 'Лампа', aliases: [], building_id: null, room_id: null, transport: 'wifi', parent_id: null, cid: null, enabled: true, capabilities: {} } }); setup();
    const card = await screen.findByRole('listitem', { name: 'Лампа' });
    expect(within(card).getByText('Без комнаты')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(within(card).getByRole('combobox'), 'local');
    expect(within(card).getByText('Без комнаты')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Комната'), '2');
    expect(screen.queryByRole('listitem', { name: 'Лампа' })).toBeNull();
  });

  it('syncs explicitly, reports progress, reloads inventory and keeps an open control screen', async () => {
    vi.useFakeTimers(); const calls = server({ empty: true }); setup();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Синхронизировать Smart Life' })); });
    expect(screen.getByRole('button', { name: 'Синхронизировать Smart Life' })).toBeDisabled();
    expect(screen.getByText(/Получаем структуру дома… 0 \/ 1/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Подробнее' })); });
    expect(screen.getByRole('dialog', { name: 'Лампа' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('dialog', { name: 'Лампа' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Синхронизировать Smart Life' })).toBeEnabled();
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ path: '/api/v1/cloud/topology/sync', method: 'POST' }]);
    expect(calls.filter(call => call.path.endsWith('/rooms')).length).toBeGreaterThan(1);
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Лампа' })).getByRole('button', { name: 'Закрыть' })); });
    expect(within(screen.getByRole('listitem',{name:'Лампа'})).getByText('Кухня')).toBeInTheDocument();
  });

  it('shows a failed job and enables retry without registering or commanding devices', async () => {
    vi.useFakeTimers(); const calls = server({ empty: true, syncFails: true }); setup();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Синхронизировать Smart Life' })); });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось синхронизировать Smart Life.');
    expect(screen.getByRole('button', { name: 'Синхронизировать Smart Life' })).toBeEnabled();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('starts room sync from the room editor and shows the imported room', async () => {
    vi.useFakeTimers();
    const calls = server({ empty: true });
    setup();
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole('button', { name: /Выбрать комнату/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Комнаты' })).getByRole('button', { name: 'Редактировать комнаты' }));
    const editor = within(screen.getByRole('dialog', { name: 'Редактировать комнаты' }));
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    const syncRooms = editor.getByRole('button', { name: 'Синхронизировать комнаты из Smart Life' });
    await act(async () => { fireEvent.click(syncRooms); });
    expect(syncRooms).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(syncRooms).toBeEnabled();
    expect(editor.getByRole('button', { name: 'Переименовать «Кухня»' })).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ path: '/api/v1/cloud/topology/sync', method: 'POST' }]);
  });

  it('hides topology immediately when the account disconnects and does not poll the old account', async () => {
    vi.useFakeTimers(); const calls = server(); const view = setup();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Синхронизировать Smart Life' })); });
    const oldCount = calls.length;
    view.rerender(<ControlCenter api={api()} ready sharingReady={false} onAuthError={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.queryByText('Комнаты из Smart Life')).toBeNull();
    expect(calls.slice(oldCount).some(call => call.path.includes('/cloud/'))).toBe(false);
  });
});
