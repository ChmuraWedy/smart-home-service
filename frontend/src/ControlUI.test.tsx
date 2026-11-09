import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { HomeApi } from './home-api';
import type { Capability, DeviceState, LocalDevice } from './home-api';
import { CloudControl } from './components/CloudControl';
import { ControlCenter } from './components/ControlCenter';
import { renderWithStore } from './test/render-with-store';
import { LocalControl, GroupControl } from './components/LocalControls';

const connection = { baseUrl: 'http://api.test:8765', token: 'test-service-key' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const boolean: Capability = { type: 'boolean', readable: true, writable: true };
const light: LocalDevice = { id: 1, device_id: 'wifi-lamp', name: 'Лампа кухни', aliases: ['kitchen_light', 'лампа кухни'], building_id: 1, room_id: 1, transport: 'wifi', parent_id: null, cid: null, enabled: true,
  capabilities: { switch: boolean, brightness: { type: 'number', readable: true, writable: true, minimum: 1, maximum: 100, step: 1, unit: '%' }, color: { type: 'object', encoding: 'tuya_hsv', readable: true, writable: true } } };
const child: LocalDevice = { ...light, id: 2, device_id: 'zigbee-lamp', name: 'Лампа Zigbee', aliases: ['child_light'], transport: 'zigbee', parent_id: 9, cid: 'child-node' };
const thermostat: LocalDevice = { ...light, id: 3, device_id: 'thermostat', name: 'Термостат', aliases: ['heater'], room_id: 2,
  capabilities: { target_temperature: { type: 'number', readable: true, writable: true, minimum: 5, maximum: 35, step: .5, unit: '°C' }, temperature: { type: 'number', readable: true, writable: false, unit: '°C' }, mode: { type: 'integer', readable: true, writable: true, enum: [0, 1] } } };
const sensor: LocalDevice = { ...child, id: 4, device_id: 'motion-sensor', name: 'Датчик', aliases: ['sensor'], capabilities: { humidity: { type: 'number', readable: true, writable: false, unit: '%' }, motion: { type: 'boolean', readable: true, writable: false } } };
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
    if (path.includes('/activity/')) return json({events:[],next_before:null});
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
  it('shows saved aliases as tags without replacing channel or timer names, restores them on reopen and keeps DP routing', async () => {
    let labels: Record<string, string> = {};
    const writes: { method: string; body: unknown }[] = [];
    const functions = [
      { code: 'switch_1', type: 'Boolean', values: '{}' },
      { code: 'countdown_1', type: 'Integer', values: '{"min":0,"max":86400,"step":1,"unit":"s"}' },
    ];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)); writes.push({ method: 'PUT', body });
        labels = Object.fromEntries(Object.entries(body.labels).filter(([, value]) => value !== null)) as Record<string, string>;
        return json({ device_id: cloudDevice.id, labels });
      }
      if (init?.method === 'POST') { writes.push({ method: 'POST', body: JSON.parse(String(init.body)) }); return json({ acknowledged: true }); }
      if (path.endsWith('/functions')) return json({ device_id: cloudDevice.id, functions: functions.map(fn => ({ ...fn, user_label: labels[fn.code] })) });
      return json({ device_id: cloudDevice.id, source: 'cloud', online: true, status: { switch_1: false, countdown_1: 0 } });
    });
    const api = new CloudApi(connection), user = userEvent.setup();
    const props = { api, device: cloudDevice, provider: 'sharing' as const, onClose: vi.fn(), onAuthError: vi.fn() };
    const view = renderWithStore(<CloudControl {...props} />);
    await screen.findByRole('region', { name: 'Канал 1' });
    await user.click(within(screen.getByRole('region', { name: 'Канал 1' })).getByRole('button', { name: 'Добавить алиас' }));
    await user.type(screen.getByLabelText('Новый алиас'), 'Настольный свет');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    const aliases = await within(screen.getByRole('region', { name: 'Канал 1' })).findByRole('group', { name: 'Алиасы' });
    expect(within(aliases).getByText('Настольный свет', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Настольный свет' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Таймер канала 1' })).toBeNull();
    await user.click(screen.getByRole('button',{name:'Таймер канала 1'}));
    expect(screen.getByRole('region', { name: 'Таймер канала 1' })).toBeInTheDocument();
    expect(writes).toEqual([{ method: 'PUT', body: { labels: { switch_1: 'Настольный свет' } } }]);
    view.unmount(); renderWithStore(<CloudControl {...props} />);
    const channel = await screen.findByRole('region', { name: 'Канал 1' });
    expect(within(channel).getByRole('heading', { name: 'Канал 1' })).toBeInTheDocument();
    expect(within(channel).getByRole('group', { name: 'Алиасы' })).toHaveTextContent('Настольный свет');
    await user.click(within(channel).getByRole('switch'));

    await waitFor(() => expect(writes[1]).toEqual({ method: 'POST', body: { commands: [{ code: 'switch_1', value: true }] } }));
  });
  it('keeps raw codes in collapsed mapping diagnostics instead of ordinary device properties', async () => {
    cloudServer();
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={{...cloudDevice,category:'dj',sub:true}} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    await screen.findByRole('region',{name:'Яркость'});
    const user=userEvent.setup();
    const properties=screen.getByText('Свойства устройства').closest('details')!;
    const diagnostics=screen.getByText('Технические данные для настройки связей').closest('details')!;
    expect(diagnostics).not.toHaveAttribute('open');
    await user.click(screen.getByText('Свойства устройства'));
    expect(within(properties).getByText('Лампа')).toBeInTheDocument();
    expect(within(properties).getByText('Через Tuya')).toBeInTheDocument();
    expect(within(properties).getByText('Через шлюз')).toBeInTheDocument();
    expect(within(properties).queryByText('bright_value_v2')).toBeNull();
    expect(screen.queryByText('Номер DP не указан')).toBeNull();
    await user.click(screen.getByText('Технические данные для настройки связей'));
    expect(diagnostics).toHaveAttribute('open');
    expect(within(diagnostics).getByText('bright_value_v2')).toBeInTheDocument();
  });

  it.each([['Яркость', 'bright_value_v2', '65', 650], ['Цветовая температура', 'temp_value_v2', '40', 400]] as const)('applies %s with missing DP metadata and an on/off-only status without fabricating a reading', async (label,code,value,raw) => {
    const functions=[
      {code:'switch_led',type:'Boolean',values:'{}',dp_id:1},
      {code:'work_mode',type:'Enum',values:{range:['white','colour','scene','music']}},
      {code:'bright_value_v2',type:'Integer',values:{min:10,max:1000,scale:0,step:1}},
      {code:'temp_value_v2',type:'Integer',values:{min:0,max:1000,scale:0,step:1}},
    ];
    const writes:unknown[]=[];
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      const path=new URL(String(input)).pathname;
      if(init?.method==='POST') {writes.push(JSON.parse(String(init.body)));return json({acknowledged:true});}
      if(path.endsWith('/functions')) return json({device_id:'cloud-lamp',functions,status_range:[functions[0]]});
      return json({device_id:'cloud-lamp',online:true,status:{switch_led:true},status_range:[functions[0]]});
    });
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={{...cloudDevice,sub:true,category:'dj'}} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const field=await screen.findByRole('region',{name:label});
    expect(within(field).getByText('Нет показания')).toBeInTheDocument();
    const user=userEvent.setup();
    await waitFor(() => expect(within(field).getByRole('slider')).toBeEnabled());
    fireEvent.change(within(field).getByRole('slider'),{target:{value}});

    await screen.findByText(/Команда принята/);
    expect(writes).toEqual([{commands:[{code:'work_mode',value:'white'},{code,value:raw}]}]);
    expect(within(field).getByText('Нет показания')).toBeInTheDocument();
    expect(within(field).getByRole('spinbutton')).toHaveValue(Number(value));
    expect(within(field).getByRole('slider')).toHaveValue(value);
    expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
  });

  it('polls only the server report cache, updates channel 2 and preserves an invalid brightness draft', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});
    const reads:string[]=[];
    let report=false;
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      expect(init?.method).toBe('GET');
      const url=new URL(String(input)); reads.push(url.pathname+url.search);
      if(url.pathname.endsWith('/functions')) return json({device_id:'cloud-lamp',functions:[
        {code:'switch_1',type:'Boolean',values:'{}'}, {code:'switch_2',type:'Boolean',values:'{}'},
        {code:'bright_value_v2',type:'Integer',values:{min:10,max:1000,scale:0,step:10}},
      ]});
      return json({device_id:'cloud-lamp',online:true,status:{switch_1:false,switch_2:report,bright_value_v2:report?600:500},
        snapshot_received_at:'2026-10-08T07:00:00Z',event_stream_connected:true,
        status_observations:report?{switch_2:{observed_at:'2026-10-08T07:01:00Z',received_at:'2026-10-08T07:01:00.2Z'}}:{}});
    });
    const view=renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    try {
      const channel=await screen.findByRole('region',{name:'Канал 2'});
      expect(within(channel).getByRole('switch')).toHaveAttribute('aria-checked','false');
      const input=screen.getByRole('spinbutton',{name:'Яркость (%)'});
      await waitFor(()=>expect(input).toBeEnabled());
      await act(async()=>{fireEvent.change(input,{target:{value:'70.5'}});});
      expect(input).toHaveValue(70.5);
      report=true;
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(within(channel).getByRole('switch')).toHaveAttribute('aria-checked','true');
      expect(within(channel).queryByText('Отчёт устройства')).not.toBeInTheDocument();
      expect(within(channel).queryByRole('button', {name:/Обновить показание/})).toBeNull();
      expect(input).toHaveValue(70.5);
      expect(reads.filter(path=>path.includes('/functions'))).toHaveLength(1);
      expect(reads.filter(path=>path.includes('/status?refresh=true'))).toHaveLength(1);
      expect(reads.filter(path=>path.includes('/status?refresh=false'))).toHaveLength(1);
      fireEvent.click(screen.getByRole('button',{name:'Обновить статус'}));
      await act(async()=>{});
      expect(reads.filter(path=>path.includes('/functions'))).toHaveLength(1);
      view.unmount();
      const count=reads.length;
      await act(async () => { vi.advanceTimersByTime(6000); });
      expect(reads).toHaveLength(count);
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('ignores a late cache poll after an explicit status refresh', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});
    let fresh=0, resolvePoll:(value:Response)=>void=()=>{};
    const snapshot=(on:boolean)=>({device_id:'cloud-lamp',online:true,status:{switch_2:on}});
    vi.mocked(fetch).mockImplementation(async input => {
      const url=new URL(String(input));
      if(url.pathname.endsWith('/functions')) return json({device_id:'cloud-lamp',functions:[{code:'switch_2',type:'Boolean',values:'{}'}]});
      if(url.searchParams.get('refresh')==='false') return new Promise<Response>(resolve=>{resolvePoll=resolve;});
      return json(snapshot(++fresh>1));
    });
    const view=renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    try {
      const channel=await screen.findByRole('region',{name:'Канал 2'});
      await act(async()=>{vi.advanceTimersByTime(1000);});
      fireEvent.click(screen.getByRole('button',{name:'Обновить статус'}));
      await act(async()=>{});
      expect(within(channel).getByRole('switch')).toHaveAttribute('aria-checked','true');
      await act(async()=>{resolvePoll(json(snapshot(false)));});
      expect(within(channel).getByRole('switch')).toHaveAttribute('aria-checked','true');
    } finally {view.unmount();vi.useRealTimers();}
  });

  it('shows only the lighting modes and schedules declared by the device', async () => {
    const functions = [
      {code:'switch_led',type:'Boolean',values:{}},
      {code:'work_mode',type:'Enum',values:{range:['white','colour','music']}},
      {code:'music_data',type:'Json',values:{}},
    ];
    vi.mocked(fetch).mockImplementation(async input => json(String(input).includes('/functions')
      ? {device_id:cloudDevice.id,functions}
      : {device_id:cloudDevice.id,online:true,status:{switch_led:false,work_mode:'white'}}));
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const modes=await screen.findByRole('combobox',{name:'Режим'});
    expect(within(modes).getAllByRole('option').map(option => option.textContent)).toEqual(['Выберите значение','Белый свет','Цветной свет','Музыка']);
    expect(screen.queryByRole('region',{name:'Расписания света'})).toBeNull();
    expect(within(screen.getByRole('region',{name:'Световые эффекты'})).getByRole('button',{name:'Настроить'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Обновить статус'}).closest('header')).not.toBeNull();
  });

  it('keeps music wizard edits local until Done, then sends using the actual 255 range', async () => {
    const schema={change_mode:{range:['direct','gradient']},bright:{min:0,max:1000},temperature:{min:0,max:1000},h:{min:0,max:360},s:{min:0,max:255},v:{min:0,max:255}};
    const functions=[{code:'music_data',type:'Json',values:schema},{code:'work_mode',type:'Enum',values:{range:['white','music']}}];
    const writes:unknown[]=[];
    vi.mocked(fetch).mockImplementation(async(input,init) => {
      if(init?.method==='POST') {writes.push(JSON.parse(String(init.body)));return json({acknowledged:true});}
      if(String(input).includes('/functions')) return json({device_id:cloudDevice.id,functions});
      return json({device_id:cloudDevice.id,online:true,source:'cloud',status:{music_data:'',work_mode:'white'}});
    });
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const user=userEvent.setup();
    const music=await screen.findByRole('region',{name:'Светомузыка'});
    await user.click(within(music).getByRole('button',{name:'Настроить'}));
    const wizard=screen.getByRole('dialog',{name:'Настройка: Светомузыка'});
    expect(within(music).queryByRole('textbox')).toBeNull();
    await user.selectOptions(within(wizard).getByLabelText('music_data.change_mode'),'gradient');
    fireEvent.change(within(wizard).getByLabelText('Выбор цвета'),{target:{value:'#00ff00'}});
    expect(within(wizard).getByLabelText('music_data.s')).toHaveValue(255);
    expect(writes).toHaveLength(0);
    await user.click(within(wizard).getByRole('button',{name:'Далее'}));
    await user.click(within(wizard).getByRole('button',{name:'Готово'}));
    expect(writes).toHaveLength(0);

    await screen.findByText(/Команда принята/);
    expect(writes).toEqual([{commands:[{code:'work_mode',value:'music'},{code:'music_data',value:{change_mode:'gradient',bright:0,temperature:0,h:120,s:255,v:255}}]}]);
    expect(music.querySelector('.reading')).toBeNull();
  });
  it('separates lighting payloads from everyday controls and sends remote_switch only as a lamp flag', async () => {
    const functions = [
      { code: 'switch_led', type: 'Boolean', values: '{}' },
      { code: 'music_data', type: 'Json', values: '{}' },
      { code: 'control_data', type: 'Json', values: '{}' },
      { code: 'remote_switch', type: 'Boolean', values: '{}' },
      { code: 'power_memory', type: 'Raw', values: '{}' },
    ];
    const writes: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return json({ acknowledged: true }); }
      if (url.pathname.endsWith('/functions')) return json({ device_id: cloudDevice.id, functions, status_range: functions });
      return json({ device_id: cloudDevice.id, online: true, source: 'cloud', status: { switch_led: true, music_data: '', control_data: '', remote_switch: true, power_memory: 'AAEAAAAAAAAAAAAA' } });
    });
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const power = await screen.findByRole('region', { name: 'Питание' });
    expect(power.closest('details')).toBeNull();
    const summary = screen.getByText('Эффекты и дополнительные параметры');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(writes).toHaveLength(0);
    const user = userEvent.setup(); await user.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    for (const name of ['Светомузыка', 'Переход света']) {
      const command = screen.getByRole('region', { name });
      expect(command.querySelector('.reading')).toBeNull();
      expect(within(command).getByText('Команда')).toBeInTheDocument();
      expect(within(command).queryByRole('textbox')).toBeNull();
      expect(within(command).getByRole('button',{name:'Настроить'})).toBeVisible();
      expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
    }
    const remote = screen.getByRole('region', { name: 'Параметр пульта' });
    expect(remote.closest('details')).toBe(summary.closest('details'));
    expect(within(remote).getByText(/Связанные устройства добавляются в Smart Life/)).toBeInTheDocument();
    expect(within(remote).queryByRole('combobox')).toBeNull();
    expect(writes).toHaveLength(0);
    await user.click(within(remote).getByRole('switch'));

    await screen.findByText(/Команда принята/);
    expect(writes).toEqual([{ commands: [{ code: 'remote_switch', value: false }] }]);
    expect(within(remote).getByText('Да')).toBeInTheDocument(); // Cloud echo remains separate from ACK.
  });
  it('shows a gateway PIR sensor with no writable functions and refreshes its motion without sending commands', async () => {
    const device = { id: 'cloud-motion-sensor', name: 'Датчик ванной', category: 'pir', sub: true, online: true, has_local_key: true };
    const ranges = [{ code: 'pir', type: 'Enum', values: '{"range":["pir","none"]}' },
      { code: 'battery', type: 'Integer', values: '{"unit":"","min":0,"max":500,"scale":0,"step":1}' }];
    const requests: { method: string; provider: string | null }[] = [];
    let motion = 'pir';
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method || 'GET', provider: url.searchParams.get('provider') });
      if (url.pathname.includes('/activity/')) return json({events:[],next_before:null});
      if (url.pathname.endsWith('/functions')) return json({ device_id: device.id, functions: [], status_range: ranges });
      return json({ device_id: device.id, online: true, source: 'cloud', status_range: ranges, status: { pir: motion, battery: 90 }, device_update_time: 1 });
    });
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={device} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    expect(await screen.findByText('Движение обнаружено')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByLabelText('Батарея: 90')).toHaveAttribute('title', 'Последнее известное показание батареи');
    expect(screen.getByText(/Снимок получен:/)).not.toHaveTextContent('1970');
    expect(screen.getByText('Датчик движения')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Подключение устройства' })).getByText('Через шлюз')).toBeVisible();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Применить' })).toBeNull();
    const user = userEvent.setup(); motion = 'none';
    await user.click(screen.getByRole('button', { name: 'Обновить статус' }));
    expect(await screen.findByText('Движения нет')).toBeInTheDocument();
    expect(requests.every(request => request.method === 'GET' && request.provider === 'sharing')).toBe(true);
    motion = 'unknown';
    await user.click(screen.getByRole('button', { name: 'Обновить статус' }));
    expect(await screen.findByText('Нет данных')).toBeInTheDocument();
    expect(screen.queryByText('Движения нет')).toBeNull();
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each(['sharing', 'developer'] as const)('sends one explicit %s command and keeps the observed state separate from ACK', async provider => {
    const server = cloudServer(); const user = userEvent.setup();
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider={provider} onClose={vi.fn()} onAuthError={vi.fn()} />);
    const power = await screen.findByRole('region', { name: 'Питание' });
    await user.click(within(power).getByRole('switch'));

    await screen.findByText(/Команда принята/);
    expect(server.writes).toEqual([{ commands: [{ code: 'switch_led', value: true }] }]);
    expect(server.providers.every(value => value === provider)).toBe(true);
    expect(within(power).getByText('Выключено')).toBeInTheDocument();
    expect(within(power).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('21.5 °C')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Обновить статус'})).toBeEnabled();
    expect(screen.queryByRole('button',{name:/Обновить показание/})).toBeNull();
  });
  it('sends brightness and color automatically with their matching mode', async () => {
    const server = cloudServer(); const user = userEvent.setup();
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const brightness = await screen.findByRole('region', { name: 'Яркость' });
    fireEvent.change(within(brightness).getByRole('slider'), { target: { value: '65' } });
    expect(server.writes).toHaveLength(0);

    await screen.findByText(/Команда принята/);
    expect(server.writes[0]).toEqual({ commands: [{ code: 'bright_value_v2', value: 650 }] });
    const color = screen.getByRole('region', { name: 'Цвет' });
    fireEvent.change(within(color).getByLabelText('Выбор цвета'), { target: { value: '#00ff00' } });

    await screen.findByText(/Команда принята/);
    await waitFor(()=>expect(server.writes[1]).toEqual({ commands: [{ code: 'work_mode', value: 'colour' }, { code: 'colour_data_v2', value: { h: 120, s: 1000, v: 1000 } }] }));
  });
  it('allows an explicit command despite an advisory offline flag from Tuya', async () => {
    const server = cloudServer({ offline: true });
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const button = await screen.findByRole('switch');
    expect(button).toBeEnabled();
    expect(server.writes).toHaveLength(0);
    await userEvent.setup().click(button);

    await waitFor(() => expect(server.writes).toEqual([{commands:[{code:'switch_led',value:true}]}]));
  });
  it('distinguishes accepted command from a failed follow-up status and never retries the command', async () => {
    const server = cloudServer({ postReadError: true }); const user = userEvent.setup();
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="developer" onClose={vi.fn()} onAuthError={vi.fn()} />);
    await user.click(await screen.findByRole('switch'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Команда принята. Обновить статус не удалось');
    expect(server.writes).toHaveLength(1);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
  it('guards rapid duplicate input and prevents closing while a command is pending', async () => {
    const server = cloudServer({ pending: true }); const close = vi.fn();
    renderWithStore(<CloudControl api={new CloudApi(connection)} device={cloudDevice} provider="sharing" onClose={close} onAuthError={vi.fn()} />);
    const button = await screen.findByRole('switch');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
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
    renderWithStore(<LocalControl api={new HomeApi(connection)} device={device} onClose={vi.fn()} onAuthError={vi.fn()} />);
    await user.click(await screen.findByRole('switch'));

    await screen.findByText(/Команда принята/);
    expect(server.writes).toEqual([{ path: `/api/v1/devices/${device.id}/commands/capabilities`, body: { values: { switch: true } } }]);
    expect(server.reads).not.toContain(`/api/v1/devices/${device.id}/state?refresh=true&max_age=60`);
    expect(screen.getByText('Выключено')).toBeInTheDocument();
  });
  it('applies a temperature step and typed enum while keeping measured temperature read-only', async () => {
    const server = localServer(); const user = userEvent.setup();
    renderWithStore(<LocalControl api={new HomeApi(connection)} device={thermostat} onClose={vi.fn()} onAuthError={vi.fn()} />);
    const target = await screen.findByRole('region', { name: 'Заданная температура' });
    fireEvent.change(within(target).getByRole('spinbutton'), { target: { value: '23' } });

    await screen.findByText(/Команда принята/);
    expect(server.writes[0].body).toEqual({ values: { target_temperature: 23 } });
    const mode = screen.getByRole('region', { name: 'Режим' });
    await user.selectOptions(within(mode).getByRole('combobox'), '1');

    await screen.findByText(/Команда принята/);
    await waitFor(()=>expect(server.writes[1]?.body).toEqual({ values: { mode: 1 } }));
    expect(within(screen.getByRole('region', { name: 'Температура' })).queryByRole('spinbutton')).toBeNull();
  });
  it('shows stale humidity and unknown motion without false values or write controls', async () => {
    localServer({ stale: true });
    renderWithStore(<LocalControl api={new HomeApi(connection)} device={sensor} onClose={vi.fn()} onAuthError={vi.fn()} />);
    await screen.findByText('Устарело');
    expect(within(screen.getByRole('region', { name: 'Движение' })).getByText('Нет данных')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
  it('reports partial group acknowledgement by member and requests statuses separately', async () => {
    const server = localServer({ partial: true }); const user = userEvent.setup();
    renderWithStore(<GroupControl api={new HomeApi(connection)} group={group} onClose={vi.fn()} onDevice={vi.fn()} onAuthError={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Включить группу' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Команда принята 1 из 2 устройств. Не подтверждено: Лампа Zigbee.');
    expect(server.writes).toEqual([{ path: '/api/v1/groups/1/commands/on', body: undefined }]);
    expect(server.reads).toContain('/api/v1/devices/1/state?refresh=true&max_age=60');
    expect(server.reads).toContain('/api/v1/devices/2/state?refresh=true&max_age=60');
    expect(screen.getByText('Все выключены')).toBeInTheDocument();
  });
  it('uses cached reads while filtering rooms and aliases and opening group members', async () => {
    const server = localServer(); const user = userEvent.setup();
    renderWithStore(<ControlCenter api={new HomeApi(connection)} ready dashboardPanel="tools" onAuthError={vi.fn()} />);
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
    expect(within(deviceDialog).getByRole('region',{name:'Подключение устройства'})).toHaveTextContent('Через шлюз');
    await waitFor(()=>expect(within(deviceDialog).getByRole('button',{name:'Назад к группе'})).toBeEnabled());
    await user.click(within(deviceDialog).getByRole('button', { name: 'Назад к группе' }));
    expect(await screen.findByRole('dialog', { name: 'Свет кухни' })).toBeInTheDocument();
    expect(server.writes).toHaveLength(0);
  });
  it('clears the previous server inventory before a replacement server responds', async () => {
    localServer(); const onAuthError = vi.fn();
    const view = renderWithStore(<ControlCenter api={new HomeApi(connection)} ready onAuthError={onAuthError} />);
    await screen.findByText('Лампа кухни');
    vi.mocked(fetch).mockImplementation((input, init) => {
      expect(String(input)).toContain('http://other-api.test');
      expect((init?.headers as Record<string,string>)['X-API-Key']).toBe('new-service-key');
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    });
    view.rerender(<ControlCenter api={new HomeApi({ baseUrl:'http://other-api.test',token:'new-service-key' })} ready onAuthError={onAuthError} />);
    expect(screen.queryByText('Лампа кухни')).toBeNull();
    expect(screen.queryByRole('button', { name:'Подробнее' })).toBeNull();
    expect(screen.getByText('Загружаем список…')).toBeInTheDocument();
  });
  it('disables a locally disabled device and reports a command timeout without retry', async () => {
    localServer({ disabled: true });
    const first = renderWithStore(<LocalControl api={new HomeApi(connection)} device={light} onClose={vi.fn()} onAuthError={vi.fn()} />);
    await screen.findByText('Устройство или его шлюз отключены в настройках сервиса.');
    expect(screen.getByRole('switch')).toBeDisabled(); first.unmount();
    const server = localServer({ postError: true });
    renderWithStore(<LocalControl api={new HomeApi(connection)} device={light} onClose={vi.fn()} onAuthError={vi.fn()} />);
    const power = await screen.findByRole('switch');
    await waitFor(() => expect(power).toBeEnabled());
    fireEvent.click(power);

    expect(await screen.findByRole('alert')).toHaveTextContent('результат команды неизвестен');
    expect(server.writes).toHaveLength(1);
  });
});
