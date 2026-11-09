import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router';
import type { AppRoomAssignment, CloudDevice, CloudFunctions, CloudSnapshot } from './api';
import type { CombinedDevice, CombinedInput } from './home-api';
import { HomeApi } from './home-api';
import { cloudDeviceKey, readCloudDevice } from './cloud-device-cache';
import CombinedDeviceCard from './components/CombinedDeviceCard';
import { STORAGE_KEY } from './connection';
import { setDeviceTextMode } from './device-translations';
import { setLocale } from './i18n';
import { createAppStore } from './store';
import { App } from './test/App';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const room = { id: 3, name: 'Kitchen', building_id: 2, aliases: [] };
const otherRoom = { ...room, id: 4, name: 'Living Room' };
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

const relay = { id: 'workroom-relay', name: 'Workroom light switch', online: true, has_local_key: false };
const relayDefinitions: CloudFunctions = {
  device_id: relay.id,
  functions: [
    { code: 'switch_1', type: 'Boolean', values: {} },
    { code: 'switch_2', type: 'Boolean', values: {} },
    { code: 'switch_backlight', type: 'Boolean', values: {} },
  ],
};

function backend(
  initial?: CombinedDevice,
  developerConnected = false,
  allMembersReachable = false,
  includeRelay = false,
  options?: { memberRooms?: Record<string, number>; otherCombinations?: CombinedDevice[]; singleRelay?: boolean; extraDevices?: CloudDevice[] },
) {
  let combined = initial;
  const roomOverrides = new Map<string, AppRoomAssignment>();
  const cloudDevices = [...bulbs, ...(options?.extraDevices ?? [])];
  const refreshedPower = new Map<string, boolean>();
  const refreshedMembers: string[] = [];
  const writes: { path: string; method: string; body?: CombinedInput | Record<string, unknown> }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.slice('/api/v1'.length);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/cloud/status') return json({
      enabled: true, connected: true, has_saved_user_code: false, saved_user_code_requires_login: false,
      developer: { configured: developerConnected, connected: developerConnected },
    });
    if (path === '/combined-devices') {
      if (method === 'POST') {
        combined = { id: 1, ...body, members: body.members.map((entry: object) => ({ ...entry, accessible: true })) };
        return json(combined, 201);
      }
      return json([...(combined ? [combined] : []), ...(options?.otherCombinations ?? [])]);
    }
    if (path === '/combined-devices/1' && method === 'PUT') {
      combined = { ...combined, id: 1, ...body, members: body.members.map((entry: object) => ({ ...entry, accessible: true })) };
      return json(combined);
    }
    if (path === '/combined-devices/1/aliases' && method === 'PUT' && combined) {
      const aliases = (body.aliases as string[]).map((alias) => alias.normalize('NFC').toLowerCase());
      combined = { ...combined, aliases };
      return json({ aliases });
    }
    if (path === '/combined-devices/1' && method === 'DELETE') {
      combined = undefined;
      return new Response(null, { status: 204 });
    }
    if (path === '/combined-devices/1/power/on' || path === '/combined-devices/1/power/off') {
      const power = path.endsWith('/on');
      const results = bulbs.map((bulb) => {
        if (!allMembersReachable && !bulb.online) return { device_id: bulb.id, outcome: 'unavailable' };
        refreshedPower.set(bulb.id, power);
        return { device_id: bulb.id, outcome: 'accepted' };
      });
      return json({ results });
    }
    if (path === '/cloud/topology') return json({
      synced_at: null, warnings: 0,
      placements: cloudDevices.map((bulb) => ({
        device_id: bulb.id, building_id: room.building_id, room_id: options?.memberRooms?.[bulb.id] ?? room.id,
      })),
      job: { status: 'idle', processed: 0, total: 0, message: null },
    });
    if (path === '/rooms') return json([room, otherRoom]);
    if (['/devices', '/groups', '/buildings'].includes(path)) return json([]);
    if (path === '/cloud/devices') {
      if (url.searchParams.get('provider') === 'developer') return json(bulbs.slice(0, 1));
      return json((includeRelay ? [...cloudDevices, relay] : cloudDevices).map((device) => ({ ...device, app_room: roomOverrides.get(device.id) })));
    }
    if (path.startsWith('/activity/')) return json({ events: [], next_before: null });
    const [, id, action] = /^\/cloud\/devices\/([^/]+)\/([^/]+)$/.exec(path) ?? [];
    const bulb = cloudDevices.find((item) => item.id === id);
    if (action === 'room' && method === 'PUT') {
      const assignment = { room_id: body.room_id, building_id: body.room_id ? room.building_id : null };
      roomOverrides.set(id, assignment);
      return json(assignment);
    }
    if (action === 'functions') {
      if (id !== relay.id) return json(bulb?.controls?.definitions);
      const functions = options?.singleRelay ? relayDefinitions.functions.filter(({ code }) => code !== 'switch_2') : relayDefinitions.functions;
      return json({ ...relayDefinitions, functions });
    }
    if (action === 'status') {
      if (id === relay.id) return json({ device_id: id, online: true, source: 'cloud', status: { switch_1: true, switch_2: true } });
      const snapshot = bulb?.controls?.snapshot;
      if (snapshot && url.searchParams.get('refresh') === 'true' && refreshedPower.has(id)) {
        refreshedMembers.push(id);
        return json({ ...snapshot, online: true, status: { ...snapshot.status, switch_led: refreshedPower.get(id) } });
      }
      return json(snapshot);
    }
    if (action === 'commands') return json({ acknowledged: true, state_confirmed: false });
    throw new Error(`Unexpected request ${path}`);
  });
  return { writes, refreshedMembers };
}

function openApp(path: string) {
  setLocale('en');
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: 'http://combined.test', token: 'fixture' }));
  window.history.replaceState(null, '', path);
  return render(<App />);
}

function renderWiredCard(source: CloudDevice, child: CloudDevice, quickOpen = false) {
  setLocale('en', false);
  const api = new HomeApi({ baseUrl: 'http://combined.test', token: 'fixture' });
  const store = createAppStore();
  const wiring = { device_id: source.id, channel: 'switch_1' };
  const members = [source, child].map((device) => ({
    member: { device_id: device.id, route: 'sharing' as const, power_source: device === child ? wiring : undefined },
    device: { id: device.id, name: device.name, cloud: { sharing: device } },
  }));
  render(
    <Provider store={store}>
      <MemoryRouter>
        <CombinedDeviceCard
          api={api}
          combined={{ id: 1, name: 'Wired devices', show_all_power: false }}
          members={members}
          room={room.name}
          now={Date.now()}
          quickOpen={quickOpen}
          onAuthError={vi.fn()}
        />
      </MemoryRouter>
    </Provider>,
  );
  return () => store.dispatch(readCloudDevice(api, cloudDeviceKey(api, source.id, 'sharing'), { refresh: true }));
}

function relayWithReading(online: boolean, power: boolean): CloudDevice {
  const statusRange = ['add_ele', 'cur_power', 'cur_voltage', 'cur_current', 'electric_coe', 'fault'].map((code) => ({
    code, type: 'Integer', values: { min: 0, max: 3000 },
  }));
  return {
    ...relay,
    online,
    category: 'cz',
    controls: {
      ready: true,
      definitions: { ...relayDefinitions, status_range: statusRange },
      snapshot: {
        device_id: relay.id, source: 'cloud', online,
        status: { switch_1: power, switch_2: true, ...Object.fromEntries(statusRange.map(({ code }) => [code, 125])) },
      },
    },
  };
}

function cameraWithPrivacy(privateMode: boolean): CloudDevice {
  return {
    id: 'camera', name: 'Sleep camera', category: 'sp', online: true, has_local_key: false,
    controls: {
      ready: true,
      definitions: { device_id: 'camera', functions: [{ code: 'basic_private', type: 'Boolean', values: {} }] },
      snapshot: { device_id: 'camera', source: 'cloud', online: true, status: { basic_private: privateMode } },
    },
  };
}

describe('combined devices', () => {
  it('adds a separate browser-saved video card only to the camera room, even for a hidden combination member', async () => {
    const camera = cameraWithPrivacy(true);
    const { writes } = backend({
      id: 1, name: 'Camera and socket', room_id: room.id, show_member_cards: false,
      members: [relay, camera].map(({ id }) => ({ device_id: id, route: 'sharing', accessible: true })),
    }, false, false, true, { extraDevices: [camera] });
    const user = userEvent.setup();
    const app = openApp('/devices/camera?room=3&route=sharing');
    const detail = within(await screen.findByRole('dialog', { name: camera.name }));
    const setting = detail.getByRole('switch', { name: 'Show room preview' });
    expect(setting).not.toBeChecked();
    await user.click(setting);
    expect(setting).toBeChecked();
    await user.click(detail.getByRole('button', { name: 'Close' }));
    const videoTitle = `${camera.name} · Camera video`;
    const video = within(await screen.findByRole('listitem', { name: videoTitle }));
    expect(await video.findByRole('region', { name: 'Camera video' })).toBeInTheDocument();
    expect(video.getByRole('button', { name: 'Watch video' })).toBeDisabled();
    expect(screen.queryByRole('listitem', { name: camera.name })).toBeNull();
    expect(writes).toEqual([]);

    app.unmount();
    openApp('/rooms/3');
    expect(await screen.findByRole('listitem', { name: videoTitle })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: otherRoom.name }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: videoTitle })).toBeNull());
  });

  it('saves a cloud device room in the app and updates its detail and dashboard placement', async () => {
    const { writes } = backend();
    const user = userEvent.setup();
    openApp('/devices/bulb-1?room=3&route=sharing');
    const detail = within(await screen.findByRole('dialog', { name: bulbs[0].name }));
    await user.click(detail.getByText('Edit device room'));
    const choice = detail.getByRole('combobox', { name: 'Room in this app' });
    await user.selectOptions(choice, String(otherRoom.id));
    await user.click(detail.getByRole('button', { name: 'Save room assignment' }));
    const metadata = within(detail.getByRole('region', { name: 'Device connection' }));
    expect(await metadata.findByText(otherRoom.name)).toBeInTheDocument();
    expect(writes).toEqual([{ method: 'PUT', path: '/cloud/devices/bulb-1/room', body: { room_id: otherRoom.id } }]);
    await user.click(detail.getByRole('button', { name: 'Close' }));
    await user.click(await screen.findByRole('button', { name: otherRoom.name }));
    expect(await screen.findByRole('listitem', { name: bulbs[0].name })).toBeInTheDocument();
  });

  it.each([false, true])('shows the live player in the combined popup and respects camera privacy %s', async (privateMode) => {
    vi.mocked(fetch).mockResolvedValue(json({ detail: 'Test stream unavailable' }, 503));
    renderWiredCard(relayWithReading(false, true), cameraWithPrivacy(privateMode), true);
    const sheet = within(await screen.findByRole('dialog', { name: 'Wired devices' }));
    const player = within(await sheet.findByRole('region', { name: 'Camera video' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    if (privateMode) {
      const privacyStatus = await player.findByText('Privacy mode enabled');
      expect(privacyStatus.closest('.camera-frame')).toHaveClass('camera-frame-blocked');
      expect(player.getByRole('button', { name: 'Watch video' })).toBeDisabled();
      expect(fetch).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/cloud/devices/camera/stream/relay?provider=sharing'), expect.objectContaining({ method: 'POST' })));
      expect(await player.findByRole('button', { name: 'Reconnect' })).toBeEnabled();
    }
  });

  it('disables a wired bulb when its channel is off and rereads it when the relay confirms on', async () => {
    const child = bulbs[0];
    const childReading = child.controls!.snapshot;
    let finishRead!: (response: Response) => void;
    const fresh = new Promise<Response>((resolve) => { finishRead = resolve; });
    const refreshes: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      expect(options?.method).toBe('GET');
      if (url.pathname.includes('/light-presets/')) return json([]);
      expect(url.searchParams.get('refresh')).toBe('true');
      if (url.pathname.endsWith(`/${relay.id}/status`)) return json(relayWithReading(true, true).controls!.snapshot);
      expect(url.pathname).toMatch(/\/bulb-1\/status$/);
      refreshes.push(url.pathname);
      return fresh;
    });
    const updateRelay = renderWiredCard(relayWithReading(true, false), child);
    const bulbRegion = () => screen.getByRole('region', { name: child.name });
    const power = await waitFor(() => within(bulbRegion()).getByRole('switch', { name: 'Power' }));
    const bulb = bulbRegion();
    expect(bulb).toHaveAttribute('data-unavailable');
    expect(power).toBeDisabled();
    expect(power).not.toBeChecked();
    expect(within(bulb).getByText('Off')).toBeInTheDocument();
    expect(refreshes).toHaveLength(0);

    await act(async () => { await updateRelay(); });
    await waitFor(() => expect(refreshes).toHaveLength(1));
    expect(power).toBeDisabled();
    expect(within(bulb).queryByText('#FF0000')).toBeNull();
    await act(async () => finishRead(json({
      ...childReading, status: { ...childReading.status, switch_led: false },
    })));
    await waitFor(() => expect(power).toBeEnabled());
    expect(power).not.toBeChecked();
    expect(bulb).not.toHaveAttribute('data-unavailable');
    expect(refreshes).toHaveLength(1);
  });

  it.each([false, true])('keeps an online camera controllable when its offline socket last reported %s', async (lastPower) => {
    const camera = cameraWithPrivacy(false);
    renderWiredCard(relayWithReading(false, lastPower), camera);
    const source = await screen.findByRole('region', { name: relay.name });
    const channel = await within(source).findByRole('switch', { name: 'Channel 1' });
    expect(source).toHaveAttribute('data-unavailable');
    expect(channel).toHaveAttribute('aria-checked', String(lastPower));
    expect(channel).toBeDisabled();
    expect(source.querySelector('.card-sensor-values')).toBeNull();
    const child = screen.getByRole('region', { name: camera.name });
    expect(child).not.toHaveAttribute('data-unavailable');
    expect(screen.getByRole('listitem', { name: 'Wired devices' })).not.toHaveAttribute('data-unavailable');
    expect(await within(child).findByRole('button', { name: 'Privacy' })).toBeEnabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the same channel power glyph for a wired relay with a single output', async () => {
    backend({
      id: 1,
      name: 'Wired lamp',
      room_id: room.id,
      members: [
        { device_id: relay.id, route: 'sharing', accessible: true },
        { device_id: bulbs[0].id, route: 'sharing', accessible: true, power_source: { device_id: relay.id, channel: 'switch_1' } },
      ],
    }, false, false, true, { singleRelay: true });
    openApp('/');
    const card = within(await screen.findByRole('listitem', { name: 'Wired lamp' }));
    const channel = await card.findByRole('switch', { name: 'Channel 1' });
    expect(channel.querySelector('.parameter-icon')).toBeInTheDocument();
    expect(channel.querySelector('.device-type-icon')).not.toBeInTheDocument();
    expect(card.getByText(`Powered by ${relay.name} · Channel 1`)).toBeInTheDocument();
  });

  it('groups wired devices by relay channel and saves their reordered layout', async () => {
    const { writes } = backend(undefined, false, false, true);
    const user = userEvent.setup();
    openApp('/combined-devices/new?room=3');
    const form = within(await screen.findByRole('form', { name: 'Create combined device' }));
    await user.selectOptions(form.getByRole('combobox', { name: 'Filter devices by room' }), 'all');
    await user.click(await form.findByRole('checkbox', { name: relay.name }));
    for (const bulb of bulbs) await user.click(form.getByRole('checkbox', { name: bulb.name }));
    expect(form.queryByRole('group', { name: 'Wiring (optional)' })).toBeNull();
    await user.click(form.getByRole('button', { name: 'Next' }));
    const wiring = within(form.getByRole('group', { name: 'Wiring (optional)' }));
    const source = (index: number) => wiring.findByRole('combobox', { name: `Power source for ${bulbs[index].name}` });
    const first = await source(0);
    expect(within(first).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No power source assigned', `${relay.name} · Channel 1`, `${relay.name} · Channel 2`,
    ]);
    await user.selectOptions(first, `${relay.name} · Channel 1`);
    await user.selectOptions(await source(1), `${relay.name} · Channel 2`);
    await user.selectOptions(await source(2), `${relay.name} · Channel 2`);
    await user.click(form.getByRole('button', { name: 'Next' }));
    expect(window.location.pathname + window.location.search).toBe('/combined-devices/new/preview?room=3');
    expect(form.getByText('Card preview', { selector: 'li' })).toHaveAttribute('aria-current', 'step');
    const preview = within(form.getByRole('group', { name: 'Card preview' }));
    const draftCard = within(preview.getByRole('listitem', { name: 'Devices in Kitchen' }));
    expect(draftCard.getByText('Kitchen')).toBeInTheDocument();
    expect(draftCard.getByText(`Powered by ${relay.name} · Channel 1`)).toBeInTheDocument();
    expect(draftCard.getAllByText(`Powered by ${relay.name} · Channel 2`)).toHaveLength(2);
    const channel = async (name: string) => (await draftCard.findByRole('switch', { name })).closest<HTMLElement>('[data-relay-channel]')!;
    const firstRelay = await channel('Channel 1');
    const firstChannel = within(firstRelay);
    const relayPower = firstChannel.getByRole('switch', { name: 'Channel 1' });
    expect(relayPower).toBeDisabled();
    expect(relayPower.closest('.capability-row')).toHaveAttribute('data-power-side', 'start');
    const disclosure = firstChannel.getByRole('button', { name: 'Devices on Channel 1' });
    expect(disclosure).toBeEnabled();
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(firstChannel.queryByRole('region', { name: bulbs[0].name })).toBeNull();
    expect(draftCard.getAllByText(`Powered by ${relay.name} · Channel 2`)).toHaveLength(2);
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const secondChannel = await channel('Channel 2');
    const orderedNames = (element: HTMLElement) => [...element.querySelectorAll('.combined-member-name')].map((heading) => heading.textContent);
    expect(firstChannel.getByRole('region', { name: bulbs[0].name })).toBeInTheDocument();
    expect(firstChannel.queryByRole('region', { name: bulbs[1].name })).toBeNull();
    expect(orderedNames(secondChannel)).toEqual([bulbs[1].name, bulbs[2].name]);
    const order = within(form.getByRole('group', { name: 'Device order' }));
    expect(order.getByRole('button', { name: `Move ${bulbs[0].name} up` })).toBeDisabled();
    await user.click(order.getByRole('button', { name: `Move ${bulbs[2].name} up` }));
    expect(orderedNames(secondChannel)).toEqual([bulbs[2].name, bulbs[1].name]);
    const power = draftCard.getByRole('switch', { name: 'Power for all devices' });
    expect(power).toBeDisabled();
    const powerFooter = power.closest('footer')?.lastElementChild;
    expect(powerFooter).toContainElement(power);
    expect(powerFooter?.querySelector('.dashboard-power-state')).toHaveTextContent('Status unknown');
    expect(draftCard.getByRole('button', { name: 'Quick controls' })).toBeDisabled();
    const lamp = within(draftCard.getByRole('region', { name: bulbs[0].name }));
    const lampPower = await lamp.findByRole('switch');
    expect(lampPower).toBeDisabled();
    const lampRow = lampPower.closest('.capability-row');
    expect(lampRow).toHaveAttribute('data-power-side', 'start');
    const inline = lampRow?.querySelector('.combined-member-inline');
    expect(inline).toHaveTextContent(bulbs[0].name);
    expect(inline).toHaveTextContent('Brightness');
    expect(inline).toHaveTextContent('Color');
    await user.click(power);
    expect(writes).toHaveLength(0);

    await user.click(form.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(window.location.pathname).toBe('/combined-devices/new'));
    const restored = await form.findByRole('combobox', { name: `Power source for ${bulbs[0].name}` });
    expect(restored).toHaveDisplayValue(`${relay.name} · Channel 1`);
    await user.click(form.getByRole('button', { name: 'Next' }));
    await user.click(form.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Devices in Kitchen' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: '/combined-devices', method: 'POST', body: {
        members: [
          { device_id: relay.id, route: 'sharing' },
          ...[bulbs[0], bulbs[2], bulbs[1]].map((bulb) => ({
            device_id: bulb.id, route: 'sharing', power_source: { device_id: relay.id, channel: bulb === bulbs[0] ? 'switch_1' : 'switch_2' },
          })),
        ],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    const card = within(await screen.findByRole('listitem', { name: 'Devices in Kitchen' }));
    expect(card.getByText(`Powered by ${relay.name} · Channel 1`)).toBeInTheDocument();
    expect(card.getAllByText(`Powered by ${relay.name} · Channel 2`)).toHaveLength(2);
    const liveChannel = await card.findByRole('switch', { name: 'Channel 2' });
    await waitFor(() => expect(liveChannel).toBeEnabled());
    const liveDisclosure = card.getByRole('button', { name: 'Devices on Channel 2' });
    await user.click(liveDisclosure);
    expect(card.queryByRole('region', { name: bulbs[1].name })).toBeNull();
    expect(writes).toHaveLength(1);
    await user.click(liveChannel);
    expect(writes[1]).toMatchObject({
      path: `/cloud/devices/${relay.id}/commands`,
      body: { commands: [{ code: 'switch_2', value: false }] },
    });
  });

  it('saves three cloud bulbs, keeps quick settings independent, routes details, and edits and dissolves the combination', async () => {
    const { writes } = backend();
    const user = userEvent.setup();
    const app = openApp('/settings/dashboard?room=3');
    await screen.findByRole('listitem', { name: bulbs[0].name });
    expect(screen.queryByRole('button', { name: 'Create combined device' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('button', { name: 'Combined devices' }));
    await user.click(await screen.findByRole('button', { name: 'Create combined device' }));
    const form = within(await screen.findByRole('form', { name: 'Create combined device' }));
    expect(form.queryByLabelText('Name')).toBeNull();
    expect(form.queryByRole('combobox', { name: 'Room' })).toBeNull();
    expect(form.getByRole('button', { name: 'Next' })).toBeDisabled();
    for (const bulb of bulbs) await user.click(form.getByRole('checkbox', { name: bulb.name }));
    expect(form.queryByRole('combobox', { name: /Control method/ })).toBeNull();
    await user.click(form.getByRole('button', { name: 'Next' }));
    expect(form.getByText('Name and room')).toHaveAttribute('aria-current', 'step');
    expect(form.getByRole('combobox', { name: 'Room' })).toHaveValue('3');
    expect(form.getByLabelText('Name')).toHaveValue('Devices in Kitchen');
    expect(form.queryByRole('checkbox', { name: bulbs[0].name })).toBeNull();
    await user.click(form.getByRole('button', { name: 'Back' }));
    expect(form.getByRole('checkbox', { name: bulbs[0].name })).toBeChecked();
    await user.click(form.getByRole('button', { name: 'Next' }));
    await user.clear(form.getByLabelText('Name'));
    await user.type(form.getByLabelText('Name'), 'Kitchen Lights');
    const roomField = form.getByRole('combobox', { name: 'Room' });
    await user.selectOptions(roomField, '');
    expect(form.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.selectOptions(roomField, '3');
    await user.click(form.getByRole('button', { name: 'Next' }));
    await user.click(form.getByRole('button', { name: 'Save' }));
    const editKitchen = await screen.findByRole('button', { name: 'Edit Kitchen Lights' });
    expect(window.location.pathname).toBe('/combined-devices');
    await user.click(editKitchen);
    const managementEditor = within(await screen.findByRole('form', { name: 'Edit combination' }));
    expect(managementEditor.getByLabelText('Name')).toHaveValue('Kitchen Lights');
    await user.click(managementEditor.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Combined devices' });
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    const card = await screen.findByRole('listitem', { name: 'Kitchen Lights' });
    expect(writes).toEqual([{
      path: '/combined-devices', method: 'POST',
      body: { name: 'Kitchen Lights', room_id: room.id, show_all_power: true, show_member_cards: false, members: bulbs.map(({ id }) => ({ device_id: id, route: 'sharing' })) },
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
    expect(sheet.queryByRole('switch', { name: 'Power for all devices' })).toBeNull();
    const close = sheet.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toBeEnabled());
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const power = within(card).getByRole('switch', { name: 'Power for all devices' });
    expect(card.querySelector('footer')?.lastElementChild).toContainElement(power);
    await user.click(power);
    await waitFor(() => expect(writes[2]).toMatchObject({ path: '/combined-devices/1/power/on', method: 'POST' }));
    expect(await within(card).findByText(/Light Kitchen 3 · Unavailable/)).toBeInTheDocument();
    expect(within(card).queryByText(/Command accepted/)).toBeNull();
    expect(card).toHaveTextContent('Status unknown');

    await user.click(within(card).getByRole('button', { name: 'Details' }));
    const chooser = within(await screen.findByRole('dialog', { name: 'Kitchen Lights' }));
    await user.click(chooser.getByRole('button', { name: bulbs[1].name }));
    expect(await screen.findByRole('dialog', { name: bulbs[1].name })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/devices/bulb-2');
    await user.click(screen.getByRole('button', { name: 'Back to combination' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Kitchen Lights' })).getByRole('button', { name: 'Edit combination' }));
    const editor = within(await screen.findByRole('form', { name: 'Edit combination' }));
    await user.click(editor.getByRole('checkbox', { name: bulbs[2].name }));
    await user.click(editor.getByRole('button', { name: 'Card preview' }));
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
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(await screen.findByRole('listitem', { name: bulbs[0].name })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Kitchen Lights' })).toBeNull();
    expect(writes[4]).toMatchObject({ path: '/combined-devices/1', method: 'DELETE' });
  }, 15000);

  it('uses one footer switch and refreshes every member after all-on and all-off', async () => {
    const { writes, refreshedMembers } = backend({
      id: 1, name: 'Kitchen Lights', room_id: room.id,
      members: bulbs.map(({ id }) => ({ device_id: id, route: 'sharing', accessible: true })),
    }, false, true);
    const user = userEvent.setup();
    openApp('/rooms/3');
    const card = within(await screen.findByRole('listitem', { name: 'Kitchen Lights' }));
    const power = card.getByRole('switch', { name: 'Power for all devices' });
    const members = bulbs.map(({ name }) => within(card.getByRole('region', { name })));
    await waitFor(() => expect(members[1].getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    await user.click(power);
    await waitFor(() => {
      for (const member of members) expect(member.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
      expect(power).toHaveAttribute('aria-checked', 'true');
      expect(power).toBeEnabled();
    });
    expect(refreshedMembers.slice().sort()).toEqual(bulbs.map(({ id }) => id));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card.queryByText(/Command accepted/)).toBeNull();

    await user.click(power);
    await waitFor(() => {
      for (const member of members) expect(member.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
      expect(power).toHaveAttribute('aria-checked', 'false');
    });
    expect(refreshedMembers.slice(3).sort()).toEqual(bulbs.map(({ id }) => id));
    expect(writes.map(({ path }) => path)).toEqual(['/combined-devices/1/power/on', '/combined-devices/1/power/off']);
  });

  it('uses the default control route at creation and never shows a route selector in the combination', async () => {
    const { writes } = backend(undefined, true, false, false, { memberRooms: { [bulbs[2].id]: otherRoom.id } });
    const user = userEvent.setup();
    openApp('/combined-devices/new?room=3');
    const creation = within(await screen.findByRole('form', { name: 'Create combined device' }));
    const filter = creation.getByRole('combobox', { name: 'Filter devices by room' });
    expect(filter).toHaveValue(String(room.id));
    expect(creation.queryByRole('checkbox', { name: bulbs[2].name })).toBeNull();
    await user.click(creation.getByRole('checkbox', { name: bulbs[0].name }));
    await user.click(creation.getByRole('checkbox', { name: bulbs[1].name }));
    await user.selectOptions(filter, String(otherRoom.id));
    expect(creation.getByRole('checkbox', { name: bulbs[2].name })).toBeInTheDocument();
    expect(creation.getByRole('checkbox', { name: bulbs[0].name })).toBeChecked();
    expect(creation.queryByRole('combobox', { name: /Control method/ })).toBeNull();
    await user.click(creation.getByRole('button', { name: 'Next' }));
    await user.click(creation.getByRole('button', { name: 'Next' }));
    await user.click(creation.getByRole('button', { name: 'Save' }));
    const edit = await screen.findByRole('button', { name: 'Edit Devices in Kitchen' });
    expect(writes[0]).toMatchObject({ body: { members: [
      { device_id: bulbs[0].id, route: 'sharing' },
      { device_id: bulbs[1].id, route: 'sharing' },
    ] } });
    await user.click(edit);
    const editor = within(await screen.findByRole('form', { name: 'Edit combination' }));
    const editFilter = editor.getByRole('combobox', { name: 'Filter devices by room' });
    expect(editFilter).toHaveValue(String(room.id));
    expect(editor.queryByRole('checkbox', { name: bulbs[2].name })).toBeNull();
    await user.selectOptions(editFilter, 'all');
    expect(editor.getByRole('checkbox', { name: bulbs[2].name })).toBeInTheDocument();
    expect(editor.queryByRole('combobox', { name: /Control method/ })).toBeNull();
  });

  it('previews unsaved edits, then saves existing member routes and chooses a route for new members', async () => {
    const { writes } = backend({
      id: 1, name: 'Kitchen lights', room_id: room.id, members: [
        { device_id: bulbs[0].id, route: 'developer', accessible: true },
        { device_id: bulbs[1].id, route: 'sharing', accessible: true },
      ],
    }, true);
    const user = userEvent.setup();
    openApp('/combined-devices/1/edit');
    const editor = within(await screen.findByRole('form', { name: 'Edit combination' }));
    await user.click(await editor.findByRole('checkbox', { name: bulbs[2].name }));
    await user.clear(editor.getByRole('textbox', { name: 'Name' }));
    await user.type(editor.getByRole('textbox', { name: 'Name' }), 'Evening lights');
    await user.click(editor.getByRole('button', { name: 'Card preview' }));
    expect(window.location.pathname).toBe('/combined-devices/1/edit/preview');
    expect(editor.getByText('Card preview', { selector: 'li' })).toHaveAttribute('aria-current', 'step');
    const preview = within(editor.getByRole('group', { name: 'Card preview' }));
    const draft = within(preview.getByRole('listitem', { name: 'Evening lights' }));
    expect(draft.getByRole('region', { name: bulbs[2].name })).toBeInTheDocument();
    await user.click(editor.getByRole('button', { name: `Move ${bulbs[2].name} up` }));
    const memberNames = draft.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    expect(memberNames.filter((name) => bulbs.some((bulb) => bulb.name === name))).toEqual([bulbs[0].name, bulbs[2].name, bulbs[1].name]);
    expect(draft.getByRole('switch', { name: 'Power for all devices' })).toBeDisabled();
    expect(writes).toHaveLength(0);
    act(() => window.history.back());
    expect(await editor.findByRole('textbox', { name: 'Name' })).toHaveValue('Evening lights');
    expect(window.location.pathname).toBe('/combined-devices/1/edit');
    expect(editor.getByRole('checkbox', { name: bulbs[2].name })).toBeChecked();
    await user.click(editor.getByRole('button', { name: 'Card preview' }));
    await user.click(editor.getByRole('button', { name: 'Save' }));
    expect(writes[0]).toMatchObject({ path: '/combined-devices/1', method: 'PUT', body: { name: 'Evening lights', members: [
      { device_id: bulbs[0].id, route: 'developer' },
      { device_id: bulbs[2].id, route: 'sharing' },
      { device_id: bulbs[1].id, route: 'sharing' },
    ] } });
  });

  it('opens a direct edit preview with saved data and can return to its editor', async () => {
    backend({
      id: 1, name: 'Kitchen lights', room_id: room.id,
      members: bulbs.map(({ id }) => ({ device_id: id, route: 'sharing', accessible: true })),
    });
    const user = userEvent.setup();
    openApp('/combined-devices/1/edit/preview?room=3');
    const editor = within(await screen.findByRole('form', { name: 'Edit combination' }));
    expect(editor.getByRole('listitem', { name: 'Kitchen lights' })).toBeInTheDocument();
    await user.click(editor.getByRole('button', { name: 'Back' }));
    expect(await editor.findByRole('textbox', { name: 'Name' })).toHaveValue('Kitchen lights');
    expect(window.location.pathname + window.location.search).toBe('/combined-devices/1/edit?room=3');
  });

  it('previews and saves hiding the aggregate power button without hiding member controls', async () => {
    const { writes } = backend({
      id: 1, name: 'Kitchen lights', room_id: room.id,
      members: bulbs.map(({ id }) => ({ device_id: id, route: 'sharing', accessible: true })),
    });
    const user = userEvent.setup();
    const app = openApp('/combined-devices/1/edit/preview');
    const visibilityName = 'Show power button for all devices';
    const powerName = 'Power for all devices';
    const visibility = await screen.findByRole('switch', { name: visibilityName });
    expect(visibility).toBeChecked();
    expect(screen.getByRole('switch', { name: powerName })).toBeDisabled();
    await user.click(visibility);
    expect(screen.queryByRole('switch', { name: powerName })).toBeNull();
    const member = within(screen.getByRole('region', { name: bulbs[0].name }));
    expect(await member.findByRole('switch')).toBeDisabled();
    expect(writes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Combined devices' });
    expect(writes[0]).toMatchObject({ path: '/combined-devices/1', method: 'PUT', body: { show_all_power: false } });

    app.unmount();
    openApp('/rooms/3');
    const card = within(await screen.findByRole('listitem', { name: 'Kitchen lights' }));
    expect(card.queryByRole('switch', { name: powerName })).toBeNull();
    const savedMember = within(card.getByRole('region', { name: bulbs[0].name }));
    const memberPower = await savedMember.findByRole('switch');
    await waitFor(() => expect(memberPower).toBeEnabled());
  });

  it('saves Unicode aliases inline, updates card tags, and finds the combination by alias', async () => {
    const { writes } = backend({
      id: 1,
      name: 'Kitchen lights',
      room_id: room.id,
      members: bulbs.slice(0, 2).map(({ id }) => ({ device_id: id, route: 'sharing', accessible: true })),
    });
    const user = userEvent.setup();
    openApp('/rooms/3');
    const card = within(await screen.findByRole('listitem', { name: 'Kitchen lights' }));
    await user.click(card.getByRole('button', { name: 'Details' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Kitchen lights' }));
    await user.click(dialog.getByRole('button', { name: 'Add alias' }));
    await user.type(dialog.getByRole('textbox', { name: 'New alias' }), 'Святло Łódź');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('святло łódź')).toBeInTheDocument();
    expect(await card.findByText('святло łódź')).toBeInTheDocument();
    expect(writes).toEqual([{
      path: '/combined-devices/1/aliases',
      method: 'PUT',
      body: { aliases: ['Святло Łódź'] },
    }]);
    await user.click(dialog.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Kitchen lights' })).toBeNull());
    const searchToggle = screen.getByRole('button', { name: 'Search' });
    await waitFor(() => expect(searchToggle).toBeEnabled());
    await user.click(searchToggle);
    const search = await screen.findByRole('searchbox');
    fireEvent.change(search, { target: { value: 'ŁÓDŹ' } });
    expect(await screen.findByRole('listitem', { name: 'Kitchen lights' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: bulbs[2].name })).toBeNull();
  });

  it('shows original cards from other rooms, including a member of another combination', async () => {
    const members = bulbs.slice(0, 2).map(({ id }) => ({ device_id: id, route: 'sharing' as const, accessible: true }));
    const { writes } = backend({
      id: 1,
      name: 'Kitchen lights',
      room_id: room.id,
      show_member_cards: true,
      members,
    }, false, false, false, {
      memberRooms: { [bulbs[0].id]: otherRoom.id },
      otherCombinations: [{ id: 2, name: 'Other lights', room_id: room.id, members }],
    });
    const user = userEvent.setup();
    const app = openApp('/rooms/3');
    await screen.findByRole('listitem', { name: 'Kitchen lights' });
    const lamp = within(await screen.findByRole('listitem', { name: bulbs[0].name }));
    expect(lamp.getByText(otherRoom.name)).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: bulbs[1].name })).toBeInTheDocument();
    app.unmount();

    openApp('/combined-devices/1/edit/preview');
    const visibility = await screen.findByRole('switch', { name: 'Show original device cards' });
    expect(visibility).toBeChecked();
    await user.click(visibility);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes[0]).toMatchObject({
      path: '/combined-devices/1', method: 'PUT', body: { show_member_cards: false },
    }));
  });

  it('returns a direct creation preview without a draft to device selection', async () => {
    backend();
    openApp('/combined-devices/new/preview?room=3');
    const editor = within(await screen.findByRole('form', { name: 'Create combined device' }));
    expect(editor.getByRole('checkbox', { name: bulbs[0].name })).not.toBeChecked();
    expect(window.location.pathname + window.location.search).toBe('/combined-devices/new?room=3');
  });

  it('opens old dashboard creation links in the dedicated editor and cancels to the list', async () => {
    backend();
    const user = userEvent.setup();
    openApp('/combined-devices/new?panel=tools&room=3');
    const editor = within(await screen.findByRole('form', { name: 'Create combined device' }));
    await user.click(editor.getByRole('checkbox', { name: bulbs[0].name }));
    await user.click(editor.getByRole('checkbox', { name: bulbs[1].name }));
    await user.click(editor.getByRole('button', { name: 'Next' }));
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
