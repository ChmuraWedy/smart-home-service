import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CloudDevice, CloudFunctions, CloudSnapshot } from './api';
import type { CombinedDevice, CombinedInput } from './home-api';
import { STORAGE_KEY } from './connection';
import { setDeviceTextMode } from './device-translations';
import { setLocale } from './i18n';
import { App } from './test/App';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const room = { id: 3, name: 'Kitchen', building_id: 2, aliases: [] };
const bulbs: CloudDevice[] = Array.from({ length: 3 }, (_, index) => {
  const id = `bulb-${index + 1}`;
  const definitions: CloudFunctions = {
    device_id: id,
    functions: [
      { code: 'switch_led', type: 'Boolean', values: {} },
      { code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene'] } },
      { code: 'bright_value_v2', type: 'Integer', values: { min: 10, max: 1000, scale: 0, step: 1 } },
      { code: 'temp_value_v2', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
      { code: 'colour_data_v2', type: 'Json', values: {} },
      { code: 'scene_data_v2', type: 'Json', values: { scene_num: { min: 1, max: 8, scale: 0, step: 1 } } },
    ],
  };
  const online = index !== 2;
  const snapshot: CloudSnapshot = {
    device_id: id, online, source: 'cloud',
    status: {
      switch_led: index === 0, work_mode: index === 0 ? 'colour' : 'white',
      bright_value_v2: 500, temp_value_v2: 300, colour_data_v2: { h: 0, s: 1000, v: 1000 },
      scene_data_v2: { scene_num: 3 },
    },
  };
  const name = `Light Kitchen ${index + 1}`;
  const translations = index === 0 ? { name: { [name]: { en: 'Evening bulb' } }, alias: {} } : undefined;
  return { id, name, translations, online, has_local_key: false, controls: { ready: true, definitions, snapshot } };
});

function backend(initial?: CombinedDevice) {
  let combined = initial;
  const writes: { path: string; method: string; body?: CombinedInput | Record<string, unknown> }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.slice('/api/v1'.length);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/cloud/status') return json({
      enabled: true, connected: true, has_saved_user_code: false, saved_user_code_requires_login: false,
      developer: { configured: false, connected: false },
    });
    if (path === '/combined-devices') {
      if (method === 'POST') {
        combined = { id: 1, ...body, members: body.members.map((entry: object) => ({ ...entry, accessible: true })) };
        return json(combined, 201);
      }
      return json(combined ? [combined] : []);
    }
    if (path === '/combined-devices/1' && method === 'PUT') {
      combined = { id: 1, ...body, members: body.members.map((entry: object) => ({ ...entry, accessible: true })) };
      return json(combined);
    }
    if (path === '/combined-devices/1' && method === 'DELETE') {
      combined = undefined;
      return new Response(null, { status: 204 });
    }
    if (path === '/combined-devices/1/power/on') return json({
      results: bulbs.map((bulb) => ({ device_id: bulb.id, outcome: bulb.online ? 'accepted' : 'unavailable' })),
    });
    if (path === '/cloud/topology') return json({
      synced_at: null, warnings: 0,
      placements: bulbs.map((bulb) => ({ device_id: bulb.id, building_id: room.building_id, room_id: room.id })),
      job: { status: 'idle', processed: 0, total: 0, message: null },
    });
    if (path === '/rooms') return json([room]);
    if (['/devices', '/groups', '/buildings'].includes(path)) return json([]);
    if (path === '/cloud/devices') return json(bulbs);
    if (path.startsWith('/activity/')) return json({ events: [], next_before: null });
    if (path.endsWith('/mappings')) return json({ mappings: [] });
    const [, id, action] = /^\/cloud\/devices\/([^/]+)\/([^/]+)$/.exec(path) ?? [];
    const bulb = bulbs.find((item) => item.id === id);
    if (action === 'functions') return json(bulb?.controls?.definitions);
    if (action === 'status') return json(bulb?.controls?.snapshot);
    if (action === 'commands') return json({ acknowledged: true, state_confirmed: false });
    throw new Error(`Unexpected request ${path}`);
  });
  return writes;
}

function openApp(path: string) {
  setLocale('en');
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: 'http://combined.test', token: 'fixture' }));
  window.history.replaceState(null, '', path);
  return render(<App />);
}

describe('combined devices', () => {
  it('saves three cloud bulbs, keeps quick settings independent, routes details, and edits and dissolves the combination', async () => {
    const writes = backend();
    const user = userEvent.setup();
    const app = openApp('/settings/dashboard?room=3');
    await screen.findByRole('listitem', { name: bulbs[0].name });
    expect(screen.queryByRole('button', { name: 'Create combined device' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('button', { name: 'Combined devices' }));
    await user.click(await screen.findByRole('button', { name: 'Create combined device' }));
    const form = within(await screen.findByRole('form', { name: 'Create combined device' }));
    await user.type(form.getByLabelText('Name'), 'Kitchen Lights');
    for (const bulb of bulbs) await user.click(form.getByRole('checkbox', { name: bulb.name }));
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Kitchen Lights' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/combined-devices');
    await user.click(screen.getByRole('button', { name: 'Edit Kitchen Lights' }));
    const managementEditor = within(await screen.findByRole('form', { name: 'Edit combination' }));
    expect(managementEditor.getByLabelText('Name')).toHaveValue('Kitchen Lights');
    await user.click(managementEditor.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Combined devices' });
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('button', { name: 'Control' }));
    const card = await screen.findByRole('listitem', { name: 'Kitchen Lights' });
    expect(writes).toEqual([{
      path: '/combined-devices', method: 'POST',
      body: { name: 'Kitchen Lights', room_id: room.id, members: bulbs.map(({ id }) => ({ device_id: id, route: 'sharing' })) },
    }]);
    for (const bulb of bulbs) {
      expect(screen.queryByRole('listitem', { name: bulb.name })).toBeNull();
      expect(within(card).getByRole('region', { name: bulb.name })).toBeInTheDocument();
    }
    await user.click(within(card).getByRole('heading', { name: 'Kitchen Lights' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Quick controls' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Kitchen Lights' }));
    const first = within(sheet.getByRole('region', { name: bulbs[0].name }));
    const second = within(sheet.getByRole('region', { name: bulbs[1].name }));
    const offline = within(sheet.getByRole('region', { name: bulbs[2].name }));
    expect(first.getByRole('slider', { name: 'Brightness' })).toHaveValue('100');
    expect(first.getByRole('region', { name: 'Color' }).querySelector('.light-color-wheel')).toBeInTheDocument();
    const brightness = second.getByRole('slider', { name: 'Brightness' });
    await waitFor(() => expect(brightness).toBeEnabled());
    expect(offline.getByRole('slider', { name: 'Brightness' })).toBeDisabled();
    fireEvent.change(brightness, { target: { value: '60' } });
    fireEvent.pointerUp(brightness);
    await waitFor(() => expect(writes[1]).toMatchObject({
      path: '/cloud/devices/bulb-2/commands', body: { commands: [{ code: 'bright_value_v2', value: 600 }] },
    }));
    const allOn = sheet.getByRole('button', { name: 'All on' });
    await waitFor(() => expect(allOn).toBeEnabled());
    await user.click(allOn);
    await waitFor(() => expect(writes[2]).toMatchObject({ path: '/combined-devices/1/power/on', method: 'POST' }));
    expect(await sheet.findByText(/Light Kitchen 3 · Unavailable/)).toBeInTheDocument();
    expect(card).toHaveTextContent('Status unknown');
    const close = sheet.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toBeEnabled());
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(card).getByRole('button', { name: 'Details' }));
    const chooser = within(await screen.findByRole('dialog', { name: 'Kitchen Lights' }));
    await user.click(chooser.getByRole('button', { name: bulbs[1].name }));
    expect(await screen.findByRole('dialog', { name: bulbs[1].name })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/devices/bulb-2');
    await user.click(screen.getByRole('button', { name: 'Back to combination' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Kitchen Lights' })).getByRole('button', { name: 'Edit combination' }));
    const editor = within(await screen.findByRole('form', { name: 'Edit combination' }));
    await user.click(editor.getByRole('checkbox', { name: bulbs[2].name }));
    await user.click(editor.getByRole('button', { name: 'Save' }));
    expect(writes[3]).toMatchObject({ path: '/combined-devices/1', method: 'PUT' });

    app.unmount();
    openApp('/combined-devices/1?room=3');
    const reloaded = within(await screen.findByRole('dialog', { name: 'Kitchen Lights' }));
    expect(reloaded.queryByRole('button', { name: bulbs[2].name })).toBeNull();
    expect(screen.getByRole('listitem', { name: bulbs[2].name })).toBeInTheDocument();
    await user.click(reloaded.getByRole('button', { name: 'Edit combination' }));
    const dissolve = within(await screen.findByRole('form', { name: 'Edit combination' }));
    await user.click(dissolve.getByRole('button', { name: 'Dissolve combination' }));
    await user.click(dissolve.getAllByRole('button', { name: 'Dissolve combination' })[1]);
    expect(await screen.findByText('There are no combined devices yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('button', { name: 'Control' }));
    expect(await screen.findByRole('listitem', { name: bulbs[0].name })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Kitchen Lights' })).toBeNull();
    expect(writes[4]).toMatchObject({ path: '/combined-devices/1', method: 'DELETE' });
  }, 15000);

  it('opens old dashboard creation links in the dedicated editor and cancels to the list', async () => {
    backend();
    const user = userEvent.setup();
    openApp('/combined-devices/new?panel=tools&room=3');
    const editor = within(await screen.findByRole('form', { name: 'Create combined device' }));
    expect(editor.getByRole('combobox', { name: 'Room' })).toHaveValue('3');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(editor.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Combined devices' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/combined-devices');
  });

  it('keeps a direct member details link usable while the combined card hides its individual tile', async () => {
    backend({
      id: 1, name: 'Kitchen Lights', room_id: room.id,
      members: bulbs.map(({ id }) => ({ device_id: id, route: 'sharing', accessible: true })),
    });
    openApp('/devices/bulb-1?route=sharing');
    expect(await screen.findByRole('dialog', { name: bulbs[0].name })).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'Kitchen Lights' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: bulbs[0].name })).toBeNull();
  });

  it('uses the selected name language for combination members and their details picker', async () => {
    backend({
      id: 1, name: 'Kitchen Lights', room_id: room.id,
      members: bulbs.map(({ id }) => ({ device_id: id, route: 'sharing', accessible: true })),
    });
    openApp('/combined-devices/1?room=3');
    const chooser = within(await screen.findByRole('dialog', { name: 'Kitchen Lights' }));
    expect(chooser.getByRole('button', { name: bulbs[0].name })).toBeInTheDocument();
    try {
      act(() => setDeviceTextMode('localized', false));
      expect(chooser.getByRole('button', { name: 'Evening bulb' })).toBeInTheDocument();
      const card = within(screen.getByRole('listitem', { name: 'Kitchen Lights' }));
      expect(card.getByRole('region', { name: 'Evening bulb' })).toBeInTheDocument();
    } finally {
      act(() => setDeviceTextMode('original', false));
    }
  });

  it('opens an ordinary bulb header in details and gives quick settings their own button', async () => {
    backend();
    const user = userEvent.setup();
    openApp('/rooms/3');
    const card = await screen.findByRole('listitem', { name: bulbs[0].name });
    await user.click(within(card).getByRole('button', { name: bulbs[0].name }));
    expect(window.location.pathname).toBe('/devices/bulb-1');
    const detail = within(await screen.findByRole('dialog', { name: bulbs[0].name }));
    await waitFor(() => expect(detail.getByRole('button', { name: 'Close' })).toBeEnabled());
    await user.click(detail.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(within(card).getByRole('button', { name: 'Quick controls' }));
    expect(window.location.pathname).toBe('/devices/bulb-1/quick');
  });
});
