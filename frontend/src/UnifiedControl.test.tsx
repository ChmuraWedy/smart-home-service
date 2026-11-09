import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ControlCenter } from './components/ControlCenter';
import { renderWithStore } from './test/render-with-store';
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
  it('switches rooms through the drawer and the desktop bar while sharing the active filter', async () => {
    server();
    const user = userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);
    await screen.findByRole('listitem', { name: cloudOnly.name });

    const trigger = screen.getByRole('button', { name: 'Выбрать комнату, сейчас выбрана Все комнаты' });
    await user.click(trigger);
    const drawer = await screen.findByRole('dialog', { name: 'Комнаты' });
    expect(within(drawer).getByRole('button', { name: 'Все комнаты' })).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(drawer).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const reopened = await screen.findByRole('dialog', { name: 'Комнаты' });
    await user.click(within(reopened).getByRole('button', { name: 'Кухня' }));
    expect(screen.queryByRole('dialog', { name: 'Комнаты' })).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: cloudOnly.name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выбрать комнату, сейчас выбрана Кухня' })).toBeInTheDocument();

    const bar = within(screen.getByRole('navigation', { name: 'Комнаты' }));
    expect(bar.getByRole('button', { name: 'Кухня' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(bar.getByRole('button', { name: 'Все комнаты' }));
    expect(await screen.findByRole('listitem', { name: cloudOnly.name })).toBeInTheDocument();
  });

  it('toggles remote-only cards independently of devices that have a local connection', async () => {
    server();
    const original = vi.mocked(fetch).getMockImplementation()!;
    const combinations = [
      {
        id: 1, name: 'Cloud combination', room_id: 2, show_member_cards: false,
        members: [{ device_id: shared.id, route: 'sharing', accessible: true }],
      },
      {
        id: 2, name: 'Local combination', room_id: 2, show_member_cards: true,
        members: [{ device_id: local.device_id, route: 'local', accessible: true }],
      },
    ];
    vi.mocked(fetch).mockImplementation(async (input, init) => new URL(String(input)).pathname.endsWith('/combined-devices')
      ? json(combinations) : original(input, init));
    const user = userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);

    const cloudCard = await screen.findByRole('listitem', { name: cloudOnly.name });
    const cloudGroup = await screen.findByRole('listitem', { name: 'Cloud combination' });
    const toggle = screen.getByRole('button', { name: 'Показать облачные устройства' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(cloudCard).not.toBeInTheDocument();
    expect(cloudGroup).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: local.name })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Local combination' })).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByRole('listitem', { name: cloudOnly.name })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Cloud combination' })).toBeInTheDocument();
  });

  it('puts the disabled presets dropdown in a second bulb header row above the readings', async () => {
    server({ noLocal: true });
    const original = vi.mocked(fetch).getMockImplementation()!;
    const bulb = {
      ...shared,
      controls: {
        ready: true,
        definitions: {
          device_id: shared.id,
          functions: [{ code: 'switch_led', type: 'Boolean', values: '{}' }],
          status_range: [
            { code: 'bright_value_v2', type: 'Integer', values: { min: 10, max: 1000, scale: 0, step: 1 } },
            { code: 'temp_value_v2', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
          ],
        },
        snapshot: { device_id: shared.id, online: true, source: 'cloud', status: { switch_led: true, bright_value_v2: 500, temp_value_v2: 250 } },
      },
    };
    vi.mocked(fetch).mockImplementation(async (input, init) => new URL(String(input)).pathname.endsWith('/cloud/devices')
      ? json([bulb, cloudOnly]) : original(input, init));
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);

    const card = await screen.findByRole('listitem', { name: bulb.name });
    const presets = await within(card).findByRole('combobox', { name: 'Пресеты' });
    expect(presets).toBeDisabled();
    const header = card.querySelector('header')!;
    const secondRow = header.querySelector('.dashboard-card-subheader');
    expect(secondRow).toContainElement(presets);
    const footer = card.querySelector('footer')!;
    const readings = within(footer.querySelector<HTMLElement>('.dashboard-light-readings')!);
    expect(readings.getByText('Яркость')).toBeInTheDocument();
    const temperature = readings.getByText('Цветовая температура');
    expect(presets.compareDocumentPosition(temperature) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const other = await screen.findByRole('listitem', { name: cloudOnly.name });
    expect(within(other).queryByRole('combobox', { name: 'Пресеты' })).toBeNull();
  });

  it('shares an edited device alias immediately and reloads the device name from inventory', async () => {
    server({ noLocal: true });
    const original = vi.mocked(fetch).getMockImplementation()!;
    let name = 'Coffee Machine';
    let aliases = ['Stary ekspres'];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/cloud/devices')) return json([{ ...shared, name, aliases }]);
      if (path.endsWith('/aliases') && init?.method === 'PUT') {
        aliases = JSON.parse(String(init.body)).aliases;
        return json({ device_id: shared.id, aliases });
      }
      return original(input, init);
    });
    const user = userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);
    const card = within(await screen.findByRole('listitem', { name }));
    await user.click(card.getByRole('button', { name: 'Подробнее' }));
    const details = within(await screen.findByRole('dialog', { name }));
    const edit = details.getByRole('button', { name: 'Изменить алиас Stary ekspres' });
    await waitFor(() => expect(edit).toBeEnabled());
    await user.click(edit);
    await user.clear(details.getByRole('textbox', { name: 'Изменить алиас' }));
    await user.type(details.getByRole('textbox', { name: 'Изменить алиас' }), 'Ekspres do kawy');
    await user.click(details.getByRole('button', { name: 'Сохранить' }));
    expect(await card.findByText('Ekspres do kawy')).toBeInTheDocument();
    expect(card.queryByText('Stary ekspres')).toBeNull();
    expect(details.getByRole('heading', { name })).toBeInTheDocument();
    await user.click(details.getByRole('button', { name: 'Закрыть' }));

    name = 'Coffee Station';
    const refresh = screen.getByRole('button', { name: 'Обновить список' });
    await waitFor(() => expect(refresh).toBeEnabled());
    await user.click(refresh);
    expect(await screen.findByRole('listitem', { name })).toHaveTextContent('Ekspres do kawy');
  });

  it.each(['sharing', 'developer'] as const)('updates and removes a saved channel alias on the %s card', async provider => {
    server({ noLocal: true });
    const original = vi.mocked(fetch).getMockImplementation()!;
    const snapshot = { device_id: shared.id, online: true, source: 'cloud', status: { switch_1: false, switch_2: true } };
    const labels: Record<string, string> = { switch_1: 'Kawa', switch_2: 'Woda' };
    const definitions = () => ({ device_id: shared.id, functions: Object.entries(snapshot.status).map(([code]) =>
      ({ code, type: 'Boolean', values: {}, user_label: labels[code] })) });
    const writes: unknown[] = [];
    let inventoryReads = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/channel-labels')) {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        if (body.labels.switch_1 === null) delete labels.switch_1;
        else labels.switch_1 = body.labels.switch_1;
        return json({ device_id: shared.id, labels });
      }
      if (path.endsWith('/cloud/devices')) {
        inventoryReads++;
        const ready = provider === 'sharing';
        return json([{ ...shared, name: 'Coffee Machine', controls: {
          ready, definitions: ready ? definitions() : { device_id: shared.id, functions: [] }, snapshot,
        } }]);
      }
      if (path.endsWith('/functions')) return json(definitions());
      if (path.endsWith('/status')) return json(snapshot);
      return original(input, init);
    });
    const user = userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady={provider === 'sharing'}
      developerReady={provider === 'developer'} onAuthError={vi.fn()} />);
    const card = within(await screen.findByRole('listitem', { name: 'Coffee Machine' }));
    if (provider === 'developer') await user.click(card.getByRole('button', { name: 'Показать состояние' }));
    expect(await card.findByText('Kawa')).toBeInTheDocument();
    const open = async () => {
      await user.click(card.getByRole('button', { name: 'Подробнее' }));
      return within(await screen.findByRole('dialog', { name: 'Coffee Machine' }));
    };
    const close = async (details: ReturnType<typeof within>) => {
      const before = inventoryReads;
      await user.click(details.getByRole('button', { name: 'Закрыть' }));
      await waitFor(() => expect(inventoryReads).toBeGreaterThan(before));
    };
    let details = await open();
    await user.click(await details.findByRole('button', { name: 'Изменить алиас Kawa' }));
    await user.clear(details.getByRole('textbox', { name: 'Изменить алиас' }));
    await user.type(details.getByRole('textbox', { name: 'Изменить алиас' }), 'Kawa świeża');
    await user.click(details.getByRole('button', { name: 'Сохранить' }));
    expect(await details.findByRole('button', { name: 'Изменить алиас Kawa świeża' })).toBeInTheDocument();
    expect(card.getByText('Kawa świeża')).toBeInTheDocument();
    await close(details);
    expect(await card.findByText('Kawa świeża')).toBeInTheDocument();
    expect(card.queryByText('Kawa')).toBeNull();

    details = await open();
    await user.click(await details.findByRole('button', { name: 'Изменить алиас Kawa świeża' }));
    await user.click(details.getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(details.queryByText('Kawa świeża')).toBeNull());
    await close(details);
    expect(card.queryByText('Kawa świeża')).toBeNull();
    expect(card.getByText('Woda')).toBeInTheDocument();
    expect(card.getByRole('switch', { name: 'Канал 1' })).not.toBeChecked();
    expect(writes).toEqual([{ labels: { switch_1: 'Kawa świeża' } }, { labels: { switch_1: null } }]);
  });

  it('shares an awaited cloud command and its confirmation between the card and details', async () => {
    const calls = server({ noLocal: true });
    const original = vi.mocked(fetch).getMockImplementation()!;
    const oldReport = new Date(Date.now() - 5000).toISOString();
    const snapshot = (power: boolean, received: string) => ({
      device_id: shared.id, online: true, source: 'cloud', status: { switch_led: power },
      status_observations: { switch_led: { received_at: received } },
    });
    const inventorySnapshot = snapshot(false, oldReport);
    let report = inventorySnapshot;
    const cloudLists = () => calls.filter(call => call.path.startsWith('/api/v1/cloud/devices?')).length;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/cloud/devices')) {
        calls.push({ path: url.pathname + url.search, method: 'GET' });
        return json([{
          ...shared, controls: {
            ready: true,
            definitions: { device_id: shared.id, functions: [{ code: 'switch_led', type: 'Boolean', values: '{}' }] },
            snapshot: inventorySnapshot,
          },
        }]);
      }
      if (url.pathname.endsWith('/status')) return json(report);
      return original(input, init);
    });
    const user = userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);
    const card = await screen.findByRole('listitem', { name: shared.name });
    const power = await within(card).findByRole('switch', { name: 'Питание' });
    await waitFor(() => expect(power).toBeEnabled());
    expect(power).not.toBeChecked();
    await user.click(power);
    expect(await within(card).findByText('Ожидаем новое показание')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Подробнее' }));
    const details = await screen.findByRole('dialog', { name: shared.name });
    const detailsPower = await within(details).findByRole('switch', { name: 'Питание' });
    expect(detailsPower).toBeChecked();
    expect(within(details).getByText('Ожидаем новое показание')).toBeInTheDocument();

    report = snapshot(true, new Date().toISOString());
    await user.click(within(details).getByRole('button', { name: 'Обновить статус' }));
    await waitFor(() => {
      expect(within(details).queryByText('Ожидаем новое показание')).toBeNull();
      expect(within(card).queryByText('Ожидаем новое показание')).toBeNull();
    });
    expect(detailsPower).toBeChecked();
    expect(power).toBeChecked();

    const listsBeforeClose = cloudLists();
    await user.click(within(details).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(cloudLists()).toBeGreaterThan(listsBeforeClose));
    expect(power).toBeChecked();
    expect(calls.filter(call => call.method === 'POST')).toEqual([{
      path: '/api/v1/cloud/devices/physical-lamp/commands?provider=sharing',
      method: 'POST',
      body: { commands: [{ code: 'switch_led', value: true }] },
    }]);
  });

  it.each(['[Space]', '{Enter}'])('sends a bulb power command with %s', async (key) => {
    const calls = server({noLocal:true});
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/cloud/devices')) return json([{
        ...shared, category:'dj', controls:{
          ready:true,
          definitions:{device_id:shared.id, functions:[{code:'switch_led', type:'Boolean', values:'{}'}]},
          snapshot:{device_id:shared.id, online:true, source:'cloud', status:{switch_led:false}},
        },
      }]);
      return original(input, init);
    });
    const user = userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);
    const card = await screen.findByRole('listitem',{name:shared.name});
    const toggle = await within(card).findByRole('switch',{name:'Питание'});
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(card).toHaveAttribute('data-slot','card');
    expect(toggle).toHaveAttribute('data-slot','power-button');
    expect(toggle).not.toBeChecked();
    toggle.focus();
    await user.keyboard(key);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
      {commands:[{code:'switch_led',value:true}]},
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens details from the card header using the selected route',async()=>{
    const calls=server(),user=userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady developerReady onAuthError={vi.fn()} />);
    const card=await screen.findByRole('listitem',{name:local.name});
    await user.selectOptions(within(card).getByRole('combobox'),'developer');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(card);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(card).getByRole('heading',{name:local.name}));
    expect(await screen.findByRole('dialog',{name:local.name})).toBeInTheDocument();
    await waitFor(()=>expect(calls.some(call=>call.path.endsWith('/functions?provider=developer'))).toBe(true));
    expect(calls.filter(call=>call.method==='POST')).toEqual([]);
  });

  it('keeps the power button and refresh separate from details and blocks opening during a command',async()=>{
    const calls=server(),original=vi.mocked(fetch).getMockImplementation()!,user=userEvent.setup();
    let finish!:(value:Response)=>void;
    const pending=new Promise<Response>(resolve=>{finish=resolve;});
    vi.mocked(fetch).mockImplementation(async(input,init)=>{
      const url=new URL(String(input));
      if (url.pathname.endsWith('/cloud/devices')) return json([{...shared,controls:{ready:true,definitions:{device_id:shared.id,functions:[{code:'switch_led',type:'Boolean',values:{}}]},snapshot:{device_id:shared.id,online:true,source:'cloud',status:{switch_led:false}}}}]);
      if (init?.method==='POST') {calls.push({path:url.pathname+url.search,method:'POST',body:JSON.parse(String(init.body))}); return pending;}
      return original(input,init);
    });
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);
    const card=await screen.findByRole('listitem',{name:local.name}),power=await within(card).findByRole('switch',{name:'Питание'});
    await waitFor(()=>expect(power).toBeEnabled());
    await user.click(within(card).getByRole('button',{name:'Обновить параметры'}));
    await waitFor(()=>expect(power).toBeEnabled());
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(power);
    await waitFor(()=>expect(power).toBeDisabled());
    await user.click(card);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter(call=>call.method==='POST')).toHaveLength(1);
    await act(async()=>finish(json({acknowledged:true})));
    await waitFor(()=>expect(power).toBeEnabled());
    await user.click(within(card).getByRole('button',{name:'Подробнее'}));
    expect(await screen.findByRole('dialog',{name:local.name})).toBeInTheDocument();
    expect(calls.filter(call=>call.method==='POST')).toHaveLength(1);
  });

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
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready dashboardPanel="tools" sharingReady developerReady onAuthError={vi.fn()} />);
    await screen.findByRole('listitem', { name: 'Только в аккаунте' });
    const card = screen.getByRole('listitem', { name: local.name });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).getByRole('combobox')).toHaveValue('sharing');
    const header=card.querySelector('header')!;
    expect(header).toHaveTextContent(local.name);
    expect(header).toHaveTextContent('Кухня');
    expect(card.querySelector('.device-card-identity')).toHaveTextContent(local.name);
    expect(card.querySelector('.device-card-identity')).toHaveTextContent('kitchen_light');
    expect(card.querySelector('.device-card-context')).toHaveTextContent('Кухня');
    expect(card.querySelector('.device-card-context')).toHaveTextContent('В сети');
    expect(header).not.toHaveTextContent('Через шлюз');
    expect(within(screen.getByRole('listitem',{name:'Только в аккаунте'})).queryByText('Через интернет · Smart Life')).toBeNull();
    expect(header.querySelector('[data-device-type=\"switch\"]')).not.toBeNull();
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

  it('resumes TRACER FOCUS 3 controls and local setup without sending device commands', async () => {
    const calls=server({noLocal:true}), original=vi.mocked(fetch).getMockImplementation()!, user=userEvent.setup();
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      if (new URL(String(input)).pathname.endsWith('/cloud/devices')) return json([{...shared,id:'tracer-real',name:'TRACER FOCUS 3',sub:false}]);
      return original(input,init);
    });
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);
    const card=await screen.findByRole('listitem',{name:'TRACER FOCUS 3'});
    expect(within(card).queryByText('Настройка отложена')).toBeNull();
    expect(within(card).getByRole('group',{name:'Основные параметры: TRACER FOCUS 3'})).toBeInTheDocument();
    await user.click(within(card).getByRole('button',{name:'Настроить локальное подключение'}));
    expect(screen.getByLabelText('Название')).toHaveValue('TRACER FOCUS 3');
    expect(screen.getByLabelText('Tuya device ID')).toHaveValue('tracer-real');
    expect(screen.getByLabelText('Подключение устройства')).toHaveValue('wifi');
    expect(screen.getByRole('button',{name:'Начать опрос'})).toBeDisabled();
    expect(calls.every(call=>call.method==='GET')).toBe(true);
  });

  it('resumes WorkGtZb setup from its tile and treats cloud gateways as gateways even with sub=true', async () => {
    const calls=server({noLocal:true}), original=vi.mocked(fetch).getMockImplementation()!, user=userEvent.setup();
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      if (new URL(String(input)).pathname.endsWith('/cloud/devices')) return json([{...shared,id:'actual-gateway',name:'WorkGtZb',category:'wg2',sub:true}]);
      return original(input,init);
    });
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);
    const card=await screen.findByRole('listitem',{name:'WorkGtZb'});
    expect(within(card).queryByText('Настройка отложена')).toBeNull();
    await user.click(within(card).getByRole('button',{name:'Настроить локальное подключение'}));
    expect(screen.getByLabelText('Название')).toHaveValue('WorkGtZb');
    expect(screen.getByLabelText('Tuya device ID')).toHaveValue('actual-gateway');
    expect(screen.getByLabelText('Подключение устройства')).toHaveValue('gateway');
    expect(screen.getByLabelText('Подключение устройства')).toBeDisabled();
    expect(within(screen.getByLabelText('Подключение устройства')).getAllByRole('option')).toHaveLength(1);
    expect(screen.getByLabelText('IP в домашней сети')).toBeInTheDocument();
    expect(screen.queryByLabelText('Шлюз')).toBeNull();
    expect(screen.getByRole('button',{name:'Начать опрос'})).toBeDisabled();
    expect(calls.every(call=>call.method==='GET')).toBe(true);
  });

  it('routes commands by the chosen provider or local numeric record, without an automatic fallback', async () => {
    const calls = server({ commandFailure: true }); const user = userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady developerReady onAuthError={vi.fn()} />);
    await screen.findByRole('listitem', { name: local.name });
    const card = screen.getByRole('listitem', { name: local.name });
    await user.selectOptions(within(card).getByRole('combobox'), 'developer');
    await user.click(within(card).getByRole('button', { name: 'Подробнее' }));
    const cloud = await screen.findByRole('dialog', { name: local.name });
    expect(within(cloud).queryByText('Tuya Developer · через интернет')).toBeNull();
    const connectionSummary=within(cloud).getByRole('region',{name:'Подключение устройства'});
    expect(connectionSummary).toBeVisible();
    for (const text of ['Комната','Кухня','Подключение','Через шлюз','Управление','Через интернет · Tuya Developer','Состояние связи']) {
      expect(within(connectionSummary).getByText(text,{exact:true})).toBeVisible();
    }
    expect(await within(connectionSummary).findByText('В сети',{exact:true})).toBeVisible();
    const info=within(cloud).getByRole('button',{name:'О подключении устройства'});
    expect(info).toHaveAttribute('aria-expanded','false');
    await user.click(info);
    const description=within(cloud).getByRole('region',{name:'О подключении устройства'});
    expect(description).toHaveTextContent('Кухня');
    expect(description).toHaveTextContent('Устройство подключено через шлюз');
    expect(description).toHaveTextContent('через подключённый аккаунт Tuya Developer');
    await user.keyboard('{Escape}');
    expect(within(cloud).queryByRole('region',{name:'О подключении устройства'})).toBeNull();
    expect(cloud).toBeInTheDocument();
    await user.click(info);
    await user.click(within(cloud).getByRole('heading',{name:local.name}));
    expect(within(cloud).queryByRole('region',{name:'О подключении устройства'})).toBeNull();
    await user.click(await within(cloud).findByRole('switch'));

    expect(await screen.findByRole('alert')).toHaveTextContent('результат команды неизвестен');
    expect(calls.filter(call => call.method === 'POST')).toEqual([{ path: '/api/v1/cloud/devices/physical-lamp/commands?provider=developer', method: 'POST', body: { commands: [{ code: 'switch_led', value: true }] } }]);
    await user.click(within(cloud).getByRole('button', { name: 'Закрыть' }));
    const reloaded = await screen.findByRole('listitem', { name: local.name });
    expect(within(reloaded).getByRole('combobox')).toHaveValue('developer');
    await user.selectOptions(within(reloaded).getByRole('combobox'), 'local');
    await user.click(within(reloaded).getByRole('button', { name: 'Подробнее' }));
    const home = await screen.findByRole('dialog', { name: local.name });
    const localSummary=within(home).getByRole('region',{name:'Подключение устройства'});
    for (const text of ['Кухня','Через шлюз','В домашней сети','Состояние связи']) {
      expect(within(localSummary).getByText(text,{exact:true})).toBeVisible();
    }
    expect(await within(localSummary).findByText('Доступно дома',{exact:true})).toBeVisible();
    await user.click(within(home).getByRole('button',{name:'О подключении устройства'}));
    expect(within(home).getByRole('region',{name:'О подключении устройства'})).toHaveTextContent('настроенному шлюзу в домашней сети');
    await user.click(await within(home).findByRole('switch'));

    expect(calls.filter(call => call.method === 'POST')[1]).toEqual({ path: '/api/v1/devices/7/commands/capabilities', method: 'POST', body: { values: { switch: true } } });
    expect(calls.some(call => call.path.includes('/cloud/devices/7/'))).toBe(false);
  });

  it('shows cloud-only devices without import, and keeps cloud access when the local inventory fails', async () => {
    server({ localFailure: true, noLocal: true });
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={vi.fn()} />);
    expect(await screen.findByRole('listitem', { name: shared.name })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Inventory unavailable');
    expect(screen.queryByText(/импортируйте|parent\/cid|REST API/)).toBeNull();
  });

  it('keeps local and Developer controls when Sharing fails', async () => {
    const calls = server({ cloudFailure: true });
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady developerReady onAuthError={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Smart Life: Cloud unavailable');
    const card = await screen.findByRole('listitem', { name: local.name });
    expect(within(card).getByRole('combobox')).toHaveValue('developer');
    expect(within(card).getAllByRole('option')).toHaveLength(2);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('hides old cloud and local cards immediately on server replacement and ignores late old responses', async () => {
    server(); const onAuthError = vi.fn();
    const view = renderWithStore(<ControlCenter api={new HomeApi(connection)} ready sharingReady onAuthError={onAuthError} />);
    await screen.findByRole('listitem', { name: 'Только в аккаунте' });
    const pending: ((value: Response) => void)[] = [];
    vi.mocked(fetch).mockImplementation((_input, init) => {
      expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('new-key');
      return new Promise(resolve => pending.push(resolve));
    });
    view.rerender(<ControlCenter api={new HomeApi({ baseUrl: 'http://new-api.test', token: 'new-key' })} ready sharingReady onAuthError={onAuthError} />);
    expect(screen.queryByRole('listitem')).toBeNull();
    // Cancel all requests while they are pending, then allow their transport to
    // resolve anyway. No late inventory is allowed to resurrect old controls.
    view.rerender(<ControlCenter api={new HomeApi(connection)} ready={false} sharingReady onAuthError={onAuthError} />);
    await act(async () => { pending.forEach(resolve => resolve(json([shared]))); });
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
