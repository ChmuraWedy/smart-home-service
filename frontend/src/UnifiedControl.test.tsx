import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ControlCenter } from './components/ControlCenter';
import { HomeApi } from './home-api';
import type { LocalDevice } from './home-api';
import { deviceRoutes, matchesDevice, mergeDevices } from './devices';

const connection = { baseUrl: 'http://api.test:8765', token: 'test-service-key' };
const local: LocalDevice = { id: 7, device_id: 'physical-lamp', name: 'Свет кухни', aliases: ['kitchen_light'], building_id: 1, room_id: 2,
  transport: 'zigbee', parent_id: 8, cid: 'child-node', enabled: true, capabilities: { switch: { type: 'boolean', readable: true, writable: true } } };
const shared = { id: 'physical-lamp', name: 'Лампа из Smart Life', online: true, sub: true, has_local_key: true };
const developer = { ...shared, name: 'Лампа из Developer' };
const cloudOnly = { ...shared, id: 'cloud-only', name: 'Только в аккаунте', sub: false };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function server(options: { cloudFailure?: boolean; localFailure?: boolean; commandFailure?: boolean; noLocal?: boolean } = {}) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input)), path = url.pathname, method = init?.method || 'GET';
    calls.push({ path: path + url.search, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/api/v1/cloud/topology') return json({ synced_at: null, warnings: 0, placements: [], job: { status: 'idle', processed: 0, total: 0, message: null } });
    if (method === 'POST') return options.commandFailure && path.includes('/cloud/') ? json({ detail: 'Cloud timeout' }, 504) : json({ acknowledged: true, state_confirmed: false });
    if (path.endsWith('/cloud/devices')) return options.cloudFailure && url.searchParams.get('provider') === 'sharing' ? json({ detail: 'Cloud unavailable' }, 502) : json(url.searchParams.get('provider') === 'sharing' ? [shared, cloudOnly] : [developer]);
    if (path === '/api/v1/buildings') return options.localFailure ? json({ detail: 'Inventory unavailable' }, 503) : json([{ id: 1, name: 'Дом', aliases: ['home'] }]);
    if (path === '/api/v1/rooms') return json([{ id: 2, name: 'Кухня', building_id: 1, aliases: ['kitchen'] }]);
    if (path === '/api/v1/devices') return json(options.noLocal ? [] : [local]);
    if (path === '/api/v1/devices/7') return json(local);
    if (path === '/api/v1/groups') return json([]);
    if (path.endsWith('/functions')) return json({ device_id: shared.id, functions: [{ code: 'switch_led', type: 'Boolean', values: '{}' }] });
    if (path.endsWith('/status')) return json({ device_id: shared.id, online: true, source: 'cloud', status: { switch_led: false } });
    if (path.endsWith('/state')) return json({ device_id: 7, name: local.name, enabled: true, available: true, values: { switch: { value: false, known: true, stale: false, observed_at: new Date().toISOString() } } });
    throw new Error('Unexpected test request');
  });
  return calls;
}

describe('unified device identity and management', () => {
  it('merges physical IDs across local and both cloud providers, never equal names or numeric record IDs', () => {
    const sameName = { ...shared, id: 'another-physical-lamp', name: local.name };
    const records = mergeDevices([local], { sharing: [shared, sameName], developer: [developer] });
    expect(records).toHaveLength(2);
    expect(records[0].local?.id).toBe(7);
    expect(records[0].id).toBe('physical-lamp');
    expect(deviceRoutes(records[0])).toEqual(['sharing', 'developer', 'local']);
    expect(deviceRoutes(records[1])).toEqual(['sharing']);
    expect(matchesDevice(records[0], 'KITCHEN_LIGHT')).toBe(true);
    expect(matchesDevice(records[0], 'SMART LIFE')).toBe(true);
  });

  it('shows one room-scoped card with aliases and explicit routes, with no physical/status polling on browse', async () => {
    const calls = server(); const user = userEvent.setup();
    render(<ControlCenter api={new HomeApi(connection)} ready sharingReady developerReady onAuthError={vi.fn()} onLock={vi.fn()} />);
    await screen.findByRole('listitem', { name: 'Только в аккаунте' });
    const card = screen.getByRole('listitem', { name: local.name });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).getByRole('combobox')).toHaveValue('sharing');
    expect(within(card).getAllByRole('option')).toHaveLength(3);
    expect(calls.some(call => /\/functions|\/status|refresh=true&max_age/.test(call.path))).toBe(false);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    await user.selectOptions(screen.getByLabelText('Комната'), '2');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await user.type(screen.getByRole('searchbox'), 'KITCHEN_LIGHT');
    expect(screen.getByRole('listitem', { name: local.name })).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox')); await user.selectOptions(screen.getByLabelText('Комната'), 'none');
    expect(screen.queryByRole('listitem', { name: local.name })).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Только в аккаунте' })).toBeInTheDocument();
  });

  it('routes commands by the chosen provider or local numeric record, without an automatic fallback', async () => {
    const calls = server({ commandFailure: true }); const user = userEvent.setup();
    render(<ControlCenter api={new HomeApi(connection)} ready sharingReady developerReady onAuthError={vi.fn()} onLock={vi.fn()} />);
    await screen.findByRole('listitem', { name: local.name });
    const card = screen.getByRole('listitem', { name: local.name });
    await user.selectOptions(within(card).getByRole('combobox'), 'developer');
    await user.click(within(card).getByRole('button', { name: 'Управлять' }));
    const cloud = await screen.findByRole('dialog', { name: local.name });
    expect(within(cloud).getByText('Tuya Developer · через интернет')).toBeInTheDocument();
    await user.click(await within(cloud).findByRole('switch'));
    await user.click(within(cloud).getByRole('button', { name: 'Применить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('результат команды неизвестен');
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ path: '/api/v1/cloud/devices/physical-lamp/commands?provider=developer', method: 'POST', body: { commands: [{ code: 'switch_led', value: true }] } }]);
    await user.click(within(cloud).getByRole('button', { name: 'Закрыть' }));
    const reloaded = await screen.findByRole('listitem', { name: local.name });
    expect(within(reloaded).getByRole('combobox')).toHaveValue('developer');
    await user.selectOptions(within(reloaded).getByRole('combobox'), 'local');
    await user.click(within(reloaded).getByRole('button', { name: 'Управлять' }));
    const home = await screen.findByRole('dialog', { name: local.name });
    await user.click(await within(home).findByRole('switch'));
    await user.click(within(home).getByRole('button', { name: 'Применить' }));
    expect(calls.filter(call => call.method === 'POST')[1]).toEqual({ path: '/api/v1/devices/7/commands/capabilities', method: 'POST', body: { values: { switch: true } } });
    expect(calls.some(call => call.path.includes('/cloud/devices/7/'))).toBe(false);
  });

  it('shows cloud-only devices without import, and keeps cloud access when the local inventory fails', async () => {
    server({ localFailure: true, noLocal: true });
    render(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} onLock={vi.fn()} />);
    expect(await screen.findByRole('listitem', { name: shared.name })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Inventory unavailable');
    expect(screen.queryByText(/импортируйте|parent\/cid|REST API/)).toBeNull();
  });

  it('keeps local and Developer controls when Sharing fails', async () => {
    const calls = server({ cloudFailure: true });
    render(<ControlCenter api={new HomeApi(connection)} ready sharingReady developerReady onAuthError={vi.fn()} onLock={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Smart Life: Cloud unavailable');
    const card = await screen.findByRole('listitem', { name: local.name });
    expect(within(card).getByRole('combobox')).toHaveValue('developer');
    expect(within(card).getAllByRole('option')).toHaveLength(2);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('hides old cloud and local cards immediately on server replacement and ignores late old responses', async () => {
    server(); const onAuthError = vi.fn(), onLock = vi.fn();
    const view = render(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={onAuthError} onLock={onLock} />);
    await screen.findByRole('listitem', { name: 'Только в аккаунте' });
    const pending: ((value: Response) => void)[] = [];
    vi.mocked(fetch).mockImplementation((_input, init) => {
      expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('new-key');
      return new Promise(resolve => pending.push(resolve));
    });
    view.rerender(<ControlCenter api={new HomeApi({ baseUrl: 'http://new-api.test', token: 'new-key' })} ready sharingReady onAuthError={onAuthError} onLock={onLock} />);
    expect(screen.queryByRole('listitem')).toBeNull();
    // Cancel all requests while they are pending, then allow their transport to
    // resolve anyway. No late inventory is allowed to resurrect old controls.
    view.rerender(<ControlCenter api={new HomeApi(connection)} ready={false} sharingReady onAuthError={onAuthError} onLock={onLock} />);
    await act(async () => { pending.forEach(resolve => resolve(json([shared]))); });
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
