import { renderWithStore } from './test/render-with-store';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CloudDevice, CloudFunctions, CloudSnapshot } from './api';
import { HomeApi } from './home-api';
import type { LocalDevice } from './home-api';
import type { ComponentProps } from 'react';
import { CardControls } from './components/CardControls';
import { ControlDialog } from './components/DeviceControls';
import { DeviceActivity } from './components/DeviceActivity';
import { cloudSpec } from './controls';

const connection = {baseUrl:'http://api.test',token:'test-key'};
const definitions:CloudFunctions = {device_id:'lamp',functions:[
  {code:'switch_led',type:'Boolean',values:{}},
  {code:'bright_value_v2',type:'Integer',values:{min:10,max:1000,scale:0,step:1}},
  {code:'colour_data_v2',type:'Json',values:{}},
  {code:'relay_status',type:'Enum',values:{range:['off','on','last']}},
  {code:'rhythm_mode',type:'Raw',values:{}},
]};
const snapshot:CloudSnapshot = {device_id:'lamp',online:true,source:'cloud',status:{switch_led:false,bright_value_v2:100,colour_data_v2:{h:0,s:1000,v:1000}}};
const lamp:CloudDevice = {id:'lamp',name:'Лампа',online:true,has_local_key:false,controls:{ready:true,definitions,snapshot}};
const json = (value:unknown,status=200) => new Response(JSON.stringify(value),{status});

const axis = (max: number) => ({ min: 0, max, step: 1 });
const sceneFunctions = [
  ...definitions.functions,
  { code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene'] } },
  { code: 'scene_data_v2', type: 'Json', values: {
    scene_num: { min: 1, max: 8, step: 1 },
    scene_units: {
      unit_change_mode: { range: ['static', 'jump', 'gradient'] },
      unit_switch_duration: axis(100),
      unit_gradient_duration: axis(100),
      bright: axis(1000), temperature: axis(1000), h: axis(360), s: axis(1000), v: axis(1000),
    },
  } },
];
const staticWhiteScene = {
  scene_num: 8,
  scene_units: [{ unit_change_mode: 'static', unit_switch_duration: 0, unit_gradient_duration: 0,
    h: 0, s: 0, v: 0, bright: 775, temperature: 41 }],
};

function mount(cloud=lamp, route:'sharing'|'developer'='sharing', sheet?:ComponentProps<typeof CardControls>['sheet']) {
  return renderWithStore(<CardControls api={new HomeApi(connection)} device={{id:'lamp',name:'Лампа',cloud:{[route]:cloud}}} route={route} now={Date.now()} paused={false} onAuthError={vi.fn()} onBusy={vi.fn()} sheet={sheet} />);
}

describe('main controls on device cards', () => {
  it('hides electrical telemetry on a socket card while keeping unrelated readings', async () => {
    const statusRange = ['cur_current', 'cur_voltage', 'cur_power', 'add_ele', 'electricity_coe', 'fault', 'temp_current'].map((code) => ({
      code, type: 'Integer', values: { min: 0, max: 1000 },
    }));
    const state = { ...snapshot, status: { switch_1: true, ...Object.fromEntries(statusRange.map(({ code }) => [code, 23])) } };
    const capabilities = { device_id: 'lamp', functions: [{ code: 'switch_1', type: 'Boolean', values: {} }], status_range: statusRange };
    const { container } = mount({ ...lamp, category: 'cz', controls: { ready: true, definitions: capabilities, snapshot: state } });
    expect(await screen.findByRole('switch', { name: 'Канал 1' })).toBeChecked();
    expect([...container.querySelectorAll('[data-reading]')].map((node) => node.getAttribute('data-reading'))).toEqual(['temp_current']);
  });

  it.each(['sharing','developer'] as const)('sends the four advertised camera toggles immediately through %s without exposing other settings',async route=>{
    const codes=['basic_private','motion_switch','decibel_switch','siren_switch'];
    const cameraDefinitions:CloudFunctions={device_id:'lamp',functions:[...codes.map(code=>({code,type:'Boolean',values:{}})),{code:'sd_format',type:'Boolean',values:{}}],status_range:[{code:'sd_status',type:'Integer',values:{min:1,max:5,scale:0}}]};
    const state={...snapshot,status:Object.fromEntries([...codes.map(code=>[code,false]),['sd_status',5]])};
    const writes:{path:string;body:unknown}[]=[];
    vi.mocked(fetch).mockImplementation(async (input,options)=>{
      if (options?.method==='POST') {writes.push({path:String(input),body:JSON.parse(String(options.body))}); return json({acknowledged:true});}
      return json(state);
    });
    mount({...lamp,category:'sp',controls:{ready:true,definitions:cameraDefinitions,snapshot:state}},route);
    const user=userEvent.setup();
    for (const [index,label] of ['Приватность','Движение','Звук','Сирена'].entries()) {
      const toggle=await screen.findByRole(label==='Приватность' ? 'button' : 'switch',{name:label});
      await waitFor(()=>expect(toggle).toBeEnabled());
      expect(toggle).toHaveAttribute(label==='Приватность' ? 'aria-pressed' : 'aria-checked','false');
      await user.click(toggle);
      await waitFor(()=>expect(toggle).toBeEnabled());
      expect(toggle).toHaveAttribute(label==='Приватность' ? 'aria-pressed' : 'aria-checked','true');
      expect(writes[index].path).toContain('provider='+route);
      expect(writes[index].body).toEqual({commands:[{code:codes[index],value:true}]});
    }
    expect(writes).toHaveLength(4);
    expect(screen.getAllByRole('switch')).toHaveLength(3);
    expect(screen.queryByRole('switch',{name:'Приватность'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
    expect(screen.queryByText('5')).toBeNull();
  });
  it('never turns a camera read-only status or missing function into a main-screen toggle',async()=>{
    mount({...lamp,category:'sp',controls:{ready:true,definitions:{device_id:'lamp',functions:[{code:'motion_switch',type:'Boolean',values:{}}],status_range:[{code:'siren_switch',type:'Boolean',values:{}}]},snapshot:{...snapshot,status:{motion_switch:false,siren_switch:false}}}});
    expect(await screen.findByRole('switch',{name:'Движение'})).toBeEnabled();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.queryByRole('switch',{name:'Сирена'})).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends power immediately without secondary editors or Apply, and retains its target against an old snapshot', async () => {
    const writes:unknown[]=[];
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return json({acknowledged:true}); }
      expect(new URL(String(input)).pathname).toMatch(/\/status$/);
      return json(snapshot);
    });
    mount(); const user=userEvent.setup();
    const power=await screen.findByRole('switch',{name:'Питание'});
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('region',{name:'Состояние после подачи питания'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Настроить'})).toBeNull();
    await waitFor(() => expect(power).toBeEnabled());
    expect(power).toHaveAttribute('data-slot','power-button');
    expect(screen.getByText('Выключено')).toBeInTheDocument();
    expect(screen.queryByText('10 %')).toBeNull();
    await user.click(power);
    await waitFor(() => expect(power).toBeEnabled());
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
    expect(writes).toEqual([{commands:[{code:'switch_led',value:true}]}]);
    expect(power).toHaveAttribute('aria-checked','true');
    expect(screen.getByText('10 %')).toBeInTheDocument();
    expect(screen.getByText('Ожидаем новое показание')).toBeInTheDocument();
  });

  it('commits quick lighting sliders once on release, with the reported device ranges', async () => {
    const writes:unknown[]=[];
    const functions=[...definitions.functions, {code:'temp_value_v2',type:'Integer',values:{min:0,max:1000,scale:0,step:10}}];
    const latest={...snapshot,status:{...snapshot.status,switch_led:true,temp_value_v2:500}};
    vi.mocked(fetch).mockImplementation(async (_input,init) => {
      if (init?.method==='POST') { writes.push(JSON.parse(String(init.body))); return json({acknowledged:true}); }
      return json(latest);
    });
    const close=vi.fn();
    mount({...lamp,controls:{ready:true,definitions:{...definitions,functions},snapshot:latest}}, 'sharing', {open:true,close,trigger:{current:null}});
    const user=userEvent.setup();
    const sheet=await screen.findByRole('dialog',{name:'Лампа'});
    const brightness=within(sheet).getByRole('slider',{name:'Яркость'});
    const temperature=within(sheet).getByRole('slider',{name:'Цветовая температура'});
    expect(brightness).toHaveValue('10');
    expect(temperature).toHaveValue('50');
    fireEvent.change(brightness,{target:{value:'55'}});
    fireEvent.change(brightness,{target:{value:'65'}});
    expect(writes).toEqual([]);
    fireEvent.pointerUp(brightness);
    await waitFor(()=>expect(brightness).toBeEnabled());
    fireEvent.blur(brightness);
    fireEvent.change(temperature,{target:{value:'35'}});
    fireEvent.keyUp(temperature,{key:'ArrowLeft'});
    await waitFor(()=>expect(writes).toEqual([
      {commands:[{code:'bright_value_v2',value:650}]},
      {commands:[{code:'temp_value_v2',value:350}]},
    ]));
    await user.click(within(sheet).getByRole('button',{name:'Закрыть'}));
    expect(close).toHaveBeenCalledOnce();
  });

  it('switches between color and white and hides the raw scene editor', async () => {
    const functions = [...definitions.functions,
      { code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene', 'music'] } },
      { code: 'temp_value_v2', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
      { code: 'scene_data_v2', type: 'Json', values: { scene_num: { min: 1, max: 8, scale: 0, step: 1 } } },
    ];
    const writes: { commands: { code: string; value: unknown }[] }[] = [];
    const status = { ...snapshot.status, switch_led: true, work_mode: 'scene', temp_value_v2: 500, scene_data_v2: { scene_num: 5 } };
    let latest = { ...snapshot, status };
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        const mode = body.commands.find((command: { code: string }) => command.code === 'work_mode');
        if (mode) latest = { ...latest, status: { ...latest.status, work_mode: mode.value } };
        return json({ acknowledged: true });
      }
      return json(latest);
    });
    mount({ ...lamp, controls: { ready: true, definitions: { ...definitions, functions }, snapshot: latest } },
      'sharing', { open: true, close: vi.fn(), trigger: { current: null } });
    const sheet = within(await screen.findByRole('dialog', { name: 'Лампа' }));
    const user = userEvent.setup();
    expect(sheet.getByRole('button', { name: 'Сцена' })).toHaveAttribute('aria-pressed', 'true');
    expect(sheet.queryByRole('slider', { name: 'Цветовая температура' })).toBeNull();
    expect(sheet.queryByRole('button', { name: 'Музыка' })).toBeNull();
    expect(sheet.queryByRole('button', { name: 'Настроить' })).toBeNull();
    const colorMode = sheet.getByRole('button', { name: 'Цветной свет' });
    await waitFor(() => expect(colorMode).toBeEnabled());
    await user.click(colorMode);
    const color = await sheet.findByRole('region', { name: 'Цвет' });
    const brightness = within(color).getByRole('slider', { name: 'Яркость' });
    expect(brightness).toHaveValue('100');
    expect(color.querySelector('.light-color-wheel')).toBeInTheDocument();
    const modes = colorMode.closest('.dashboard-sheet-light-toolbar');
    expect(within(modes as HTMLElement).getByRole('switch', { name: 'Питание' })).toBeInTheDocument();
    fireEvent.change(brightness, { target: { value: '64.8' } });
    expect(writes).toHaveLength(1);
    fireEvent.pointerUp(brightness);
    await waitFor(() => expect(writes[1]).toEqual({ commands: [{ code: 'colour_data_v2', value: { h: 0, s: 1000, v: 648 } }] }));
    expect(sheet.queryByRole('slider', { name: 'Цветовая температура' })).toBeNull();
    const whiteMode = sheet.getByRole('button', { name: 'Белый свет' });
    await waitFor(() => expect(whiteMode).toBeEnabled());
    await user.click(whiteMode);
    expect(await sheet.findByRole('slider', { name: 'Цветовая температура' })).toHaveValue('50');
    expect(sheet.queryByRole('region', { name: 'Цвет' })).toBeNull();
    expect(writes).toEqual([
      { commands: [{ code: 'work_mode', value: 'colour' }] },
      { commands: [{ code: 'colour_data_v2', value: { h: 0, s: 1000, v: 648 } }] },
      { commands: [{ code: 'work_mode', value: 'white' }] },
    ]);
  });

  it.each([
    { effect: 'static', white: true, expected: ['77.5 %', '4.1 %'] },
    { effect: 'static', white: false, expected: ['50 %', '#800000'] },
    { effect: 'jump', white: false, expected: ['Вспышки'] },
    { effect: 'gradient', white: false, expected: ['Дыхание'] },
  ])('shows $effect scene readings on the card (white: $white)', async ({ effect, white, expected }) => {
    const values = white ? staticWhiteScene.scene_units[0] : { h: 0, s: 1000, v: 500, bright: 0, temperature: 0 };
    const scene = {
      ...staticWhiteScene,
      scene_units: [{
        ...staticWhiteScene.scene_units[0],
        ...values,
        unit_change_mode: effect,
      }],
    };
    const latest = { ...snapshot, status: {
      ...snapshot.status, switch_led: true, work_mode: 'scene', scene_data_v2: JSON.stringify(scene),
    } };
    vi.mocked(fetch).mockResolvedValue(json(latest));
    const view = mount({ ...lamp, controls: {
      ready: true, definitions: { ...definitions, functions: sceneFunctions }, snapshot: latest,
    } });
    await waitFor(() => {
      const valuesOnCard = Array.from(view.container.querySelectorAll('.dashboard-light-value-text'), (node) => node.textContent);
      expect(valuesOnCard).toEqual(expected);
    });
  });

  it('saves distinct scenes with the same bulb slot, and applies only the selected scene', async () => {
    const latest = { ...snapshot, status: {
      ...snapshot.status, switch_led: true, work_mode: 'scene', scene_data_v2: JSON.stringify(staticWhiteScene),
    } };
    const writes: unknown[] = [];
    const saved: { id: number; name: string; tuya_scene_id?: string }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/cloud/scenes')) return json([{ id: 'tuya-id', name: 'Tuya living scene' }]);
      if (url.includes('/light-presets/')) {
        if (init?.method !== 'POST') return json(saved);
        const row = { ...JSON.parse(String(init.body)), id: saved.length + 1 };
        saved.push(row);
        return json(row, 201);
      }
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        return json({ acknowledged: true });
      }
      return json(latest);
    });
    const configured = { ...lamp, controls: { ready: true, definitions: { ...definitions, functions: sceneFunctions }, snapshot: latest } };
    const slot = document.createElement('div');
    document.body.append(slot);
    const props = { open: true, close: vi.fn(), trigger: { current: null }, presetSlot: slot };
    const view = mount(configured, 'sharing', props);
    await waitFor(() => expect(view.container.querySelector('.dashboard-light-value-text')).toHaveTextContent('77.5 %'));
    const sheet = within(await screen.findByRole('dialog', { name: 'Лампа' }));
    expect(sheet.getByText('4.1 %')).toBeInTheDocument();
    const user = userEvent.setup();
    const add = sheet.getByRole('button', { name: 'Добавить сцену' });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    let editor = within(await screen.findByRole('dialog', { name: /Добавить сцену/ }));
    expect(editor.getByRole('button', { name: 'Статичный' })).toHaveAttribute('aria-pressed', 'true');
    expect(editor.getByRole('slider', { name: 'Яркость' })).toHaveValue('77.5');
    expect(editor.getByRole('slider', { name: 'Цветовая температура' })).toHaveValue('4.1');
    expect(editor.queryByRole('slider', { name: 'Скорость' })).toBeNull();
    await user.type(editor.getByRole('textbox', { name: 'Название' }), 'Warm static');
    await user.selectOptions(await editor.findByRole('combobox', { name: 'Ссылка на сцену Smart Life' }), 'tuya-id');
    await user.click(editor.getByRole('button', { name: 'Сохранить' }));
    expect(await sheet.findByText('Warm static')).toBeInTheDocument();
    expect(saved[0].tuya_scene_id).toBe('tuya-id');
    expect(within(slot).getByRole('option', { name: 'Warm static' })).toBeInTheDocument();

    await user.click(add);
    editor = within(await screen.findByRole('dialog', { name: /Добавить сцену/ }));
    await user.type(editor.getByRole('textbox', { name: 'Название' }), 'Color flash');
    await user.click(editor.getByRole('button', { name: 'Вспышки' }));
    fireEvent.change(editor.getByRole('slider', { name: 'Скорость' }), { target: { value: '49' } });
    await user.click(editor.getByRole('button', { name: 'Добавить шаг' }));
    await user.click(editor.getByRole('button', { name: 'Добавить шаг' }));
    await user.click(editor.getByRole('button', { name: 'Удалить шаг 3' }));
    await user.click(editor.getByRole('button', { name: 'Цвет' }));
    fireEvent.change(editor.getByRole('slider', { name: 'Яркость' }), { target: { value: '65.8' } });
    await user.click(editor.getByRole('button', { name: 'Сохранить' }));
    expect(await sheet.findByText('Color flash')).toBeInTheDocument();
    expect(writes).toEqual([]);
    view.unmount();
    mount(configured, 'sharing', props);
    const reopened = within(await screen.findByRole('dialog', { name: 'Лампа' }));
    expect(await reopened.findByText('Warm static')).toBeInTheDocument();
    await user.selectOptions(within(slot).getByRole('combobox', { name: 'Пресеты' }), 'Color flash');
    expect(writes).toEqual([{ commands: [{ code: 'scene_data_v2', value: {
      scene_num: 8,
      scene_units: [
        { unit_change_mode: 'jump', unit_switch_duration: 49, unit_gradient_duration: 49, h: 0, s: 0, v: 0, bright: 775, temperature: 41 },
        { unit_change_mode: 'jump', unit_switch_duration: 49, unit_gradient_duration: 49, h: 0, s: 0, v: 658, bright: 0, temperature: 0 },
      ],
    } }] }]);
    slot.remove();
  });

  it('shows two bulb readings, switching from white temperature to the reported active color', async () => {
    const functions = [...definitions.functions,
      { code: 'work_mode', type: 'Enum', values: { range: ['white', 'colour', 'scene'] } },
      { code: 'temp_value_v2', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 10 } },
    ];
    const white = { ...snapshot, status: { ...snapshot.status, switch_led: true, temp_value_v2: 500, work_mode: 'white' } };
    const color = { ...white, status: { ...white.status, work_mode: 'colour', colour_data_v2: { h: 120, s: 1000, v: 500 } } };
    vi.mocked(fetch).mockResolvedValueOnce(json(color));
    const { container } = mount({ ...lamp, controls: { ready: true, definitions: { ...definitions, functions }, snapshot: white } });
    const power = await screen.findByRole('switch', { name: 'Питание' });
    expect(power).toBeChecked();
    expect(screen.getByText('Яркость')).toBeVisible();
    expect(screen.getByText('Цветовая температура')).toBeVisible();
    expect(screen.getByText('10 %')).toBeVisible();
    expect(screen.getByText('50 %')).toBeVisible();
    expect(screen.queryByText('#FF0000')).toBeNull();
    expect(container.querySelector('.dashboard-light-tint')).toHaveStyle({ backgroundColor: 'rgb(220, 205, 171)' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Обновить параметры' }));
    expect(await screen.findByText('#008000')).toBeVisible();
    expect(screen.getByText('Цвет')).toBeVisible();
    expect(screen.getByText('50 %')).toBeVisible();
    expect(screen.queryByText('Цветовая температура')).toBeNull();
    expect(screen.queryByText('10 %')).toBeNull();
    expect(container.querySelector('.dashboard-light-tint')).toHaveStyle({ backgroundColor: '#008000' });
    expect(power).toBeChecked();
  });

  it.each([false, true])('shows the reported power when brightness and temperature are command-only (on: %s)', async (power) => {
    const functions = [
      ...definitions.functions,
      { code: 'temp_value_v2', type: 'Integer', values: { min: 0, max: 1000, scale: 0, step: 1 } },
    ];
    const powerOnly = { ...snapshot, status: { switch_led: power } };
    const view = mount({ ...lamp, controls: { ready: true, definitions: { ...definitions, functions }, snapshot: powerOnly } });
    const toggle = await screen.findByRole('switch', { name: 'Питание' });
    expect(toggle).toHaveAttribute('aria-checked', String(power));
    const readings = view.container.querySelector<HTMLElement>('.dashboard-light-readings');
    expect(readings).toHaveTextContent(power ? 'Включено' : 'Выключено');
    expect(readings).not.toHaveTextContent('Цветовая температура');
    if (power) expect(readings).toHaveTextContent(/Яркость.*Нет данных/);
    else expect(readings).not.toHaveTextContent('Яркость');
  });

  it('keeps the last reported bulb values visible with disabled controls while offline', async () => {
    const online = { ...snapshot, status: { ...snapshot.status, switch_led: true, bright_value_v2: 640 } };
    vi.mocked(fetch).mockResolvedValueOnce(json(online));
    mount({ ...lamp, online: false, controls: { ready: true, definitions, snapshot: { ...online, online: false } } });
    const power = await screen.findByRole('switch', { name: 'Питание' });
    expect(power).toBeDisabled();
    expect(power).toBeChecked();
    expect(screen.getByText('64 %')).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Обновить параметры' }));
    expect(await screen.findByText('64 %')).toBeVisible();
    expect(power).toBeEnabled();
    expect(power).toBeChecked();
  });

  it('sends once while awaiting an acknowledgement and clears waiting after a matching report', async () => {
    let accept!:() => void;
    const ack=new Promise<Response>(resolve => {accept=() => resolve(json({acknowledged:true}));});
    let writes=0;
    vi.mocked(fetch).mockImplementation(async (_input,init) => {
      if (init?.method==='POST') { writes++; return ack; }
      return json({...snapshot,status:{...snapshot.status,switch_led:true}});
    });
    mount(); const user=userEvent.setup(),power=await screen.findByRole('switch',{name:'Питание'});
    await waitFor(() => expect(power).toBeEnabled());
    await user.dblClick(power);
    expect(writes).toBe(1); expect(power).toBeDisabled();
    await act(async () => accept());
    await waitFor(() => expect(power).toBeEnabled());
    await waitFor(() => expect(screen.queryByText('Ожидаем новое показание')).toBeNull());
    expect(power).toHaveAttribute('aria-checked','true');
    expect(writes).toBe(1);
  });

  it('loads missing definitions only after the card becomes visible and uses the inventory snapshot', async () => {
    const observers:IntersectionObserverCallback[]=[];
    vi.stubGlobal('IntersectionObserver',class { constructor(callback:IntersectionObserverCallback){observers.push(callback);} observe(){} disconnect(){} });
    const cloud={...lamp,controls:{ready:false,definitions:{device_id:'lamp',functions:[]},snapshot}};
    vi.mocked(fetch).mockImplementation(async () => json(definitions));
    try {
      mount(cloud);
      expect(fetch).not.toHaveBeenCalled();
      await act(async () => observers[0]([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver));
      await screen.findByRole('switch',{name:'Питание'});
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/functions?provider=sharing');
    } finally { vi.unstubAllGlobals(); }
  });

  it('stops cached polling when the card scrolls out of view', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});
    const observers:IntersectionObserverCallback[]=[];
    vi.stubGlobal('IntersectionObserver',class { constructor(callback:IntersectionObserverCallback){observers.push(callback);} observe(){} disconnect(){} });
    vi.mocked(fetch).mockImplementation(async () => json(snapshot));
    const view=mount();
    try {
      await screen.findByRole('switch',{name:'Питание'});
      await act(async () => observers[0]([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver));
      await act(async () => { vi.advanceTimersByTime(3999); });
      expect(fetch).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('refresh=false&provider=sharing&watch=true');
      await act(async () => observers[0]([{isIntersecting:false} as IntersectionObserverEntry],{} as IntersectionObserver));
      await act(async () => { vi.advanceTimersByTime(6000); });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('switch',{name:'Питание'})).toHaveAttribute('aria-checked','false');
    } finally { view.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it.each(['sharing','developer'] as const)('keeps %s errors on the selected route without retry or fallback', async route => {
    const writes:string[]=[];
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      if (init?.method==='POST') { writes.push(String(input)); return json({detail:'Нет связи'},409); }
      return json(snapshot);
    });
    mount(lamp,route); const user=userEvent.setup();
    const power=await screen.findByRole('switch',{name:'Питание'});
    await waitFor(() => expect(power).toBeEnabled());
    await user.click(power);
    expect(await screen.findByRole('alert')).toHaveTextContent('Команда отклонена');
    expect(writes).toHaveLength(1); expect(writes[0]).toContain('provider='+route);
    expect(screen.getByRole('switch',{name:'Питание'})).toBeEnabled();
    expect(screen.getByRole('switch',{name:'Питание'})).toHaveAttribute('aria-checked','false');
  });

  it('uses the numeric local record for local card commands', async () => {
    const calls:{path:string;body:unknown}[]=[];
    const local={id:7,device_id:'physical',name:'Локальный свет',transport:'wifi' as const,parent_id:null,cid:null,aliases:[],building_id:null,room_id:null,enabled:true,capabilities:{switch:{type:'boolean' as const,readable:true,writable:true}}};
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      if (init?.method==='POST') {calls.push({path:String(input),body:JSON.parse(String(init.body))}); return json({acknowledged:true});}
      return json({device_id:7,enabled:true,available:true,values:{switch:{value:false,known:true,stale:false,observed_at:new Date().toISOString()}}});
    });
    const props={api:new HomeApi(connection),device:{id:'physical',name:local.name,local,cloud:{}},route:'local' as const,now:Date.now(),paused:false,onAuthError:vi.fn(),onBusy:vi.fn()};
    renderWithStore(<CardControls {...props} />);
    const user=userEvent.setup(),power=await screen.findByRole('switch',{name:'Питание'});
    await waitFor(() => expect(power).toBeEnabled());
    await user.click(power);
    await waitFor(() => expect(power).toBeEnabled());
    expect(calls).toEqual([{path:'http://api.test/api/v1/devices/7/commands/capabilities',body:{values:{switch:true}}}]);
  });
  it('shows local bulb brightness as a percentage and keeps settings out of the dashboard footer', async () => {
    const local: LocalDevice = {
      id: 7, device_id: 'physical', name: 'Лампа', transport: 'wifi', parent_id: null, cid: null,
      aliases: [], building_id: null, room_id: null, enabled: true,
      capabilities: {
        switch_led: { type: 'boolean', readable: true, writable: true },
        work_mode: { type: 'string', readable: true, writable: true, enum: ['white', 'colour', 'scene'] },
        bright_value_v2: { type: 'integer', readable: true, writable: true, minimum: 10, maximum: 1000, step: 1 },
        temp_value_v2: { type: 'integer', readable: true, writable: false },
        colour_data_v2: { type: 'object', readable: true, writable: true, encoding: 'tuya_hsv' },
        countdown_1: { type: 'integer', readable: true, writable: false, unit: 's' },
        do_not_disturb: { type: 'boolean', readable: true, writable: false },
        remote_switch: { type: 'boolean', readable: true, writable: false },
        relay_status: { type: 'string', readable: true, writable: false, enum: ['last'] },
        switch_backlight: { type: 'boolean', readable: true, writable: false },
        scene_data_v2: { type: 'string', readable: true, writable: false },
      },
    };
    const values = Object.fromEntries(Object.entries({
      switch_led: true, work_mode: 'white', bright_value_v2: 469, temp_value_v2: 0,
      countdown_1: 0, do_not_disturb: false, remote_switch: true, relay_status: 'last', switch_backlight: true, scene_data_v2: 'raw-scene',
    })
      .map(([key, value]) => [key, {
        value, known: true, stale: false, observed_at: new Date().toISOString(),
      }]));
    const writes: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        return json({ acknowledged: true });
      }
      return json({ device_id: local.id, enabled: true, available: true, values });
    });

    renderWithStore(
      <CardControls
        api={new HomeApi(connection)}
        device={{ id: local.device_id, name: local.name, local, cloud: {} }}
        route="local"
        now={Date.now()}
        paused={false}
        onAuthError={vi.fn()}
        onBusy={vi.fn()}
        sheet={{ open: true, close: vi.fn(), trigger: { current: null } }}
      />,
    );

    const sheet = within(await screen.findByRole('dialog', { name: local.name }));
    const brightness = sheet.getByRole('slider', { name: 'Яркость' });
    await waitFor(() => expect(brightness).toBeEnabled());
    expect(brightness).toHaveAttribute('min', '1');
    expect(brightness).toHaveAttribute('max', '100');
    expect(brightness).toHaveValue('46.9');
    expect(sheet.getByText('46.9 %')).toBeInTheDocument();
    expect(document.querySelector('.card-sensor-values')).toBeNull();
    expect(sheet.queryByRole('slider', { name: 'Цветовая температура' })).toBeNull();
    expect(sheet.getByRole('button', { name: 'Сцена' })).toBeDisabled();
    fireEvent.change(brightness, { target: { value: '52.5' } });
    fireEvent.pointerUp(brightness);
    await waitFor(() => expect(writes).toEqual([{ values: { bright_value_v2: 525 } }]));
  });

  it('shows sensor values with accessible labels and no settings editors', async () => {
    const sensorDefinitions:CloudFunctions={device_id:'lamp',functions:[{code:'temp_unit_convert',type:'Enum',values:{range:['c','f']}}],status_range:[{code:'va_temperature',type:'Integer',values:{unit:'℃',scale:1}},{code:'va_humidity',type:'Integer',values:{unit:'%',scale:0}}]};
    mount({...lamp,controls:{ready:true,definitions:sensorDefinitions,snapshot:{...snapshot,status:{va_temperature:225,va_humidity:48}}}});
    expect(await screen.findByTitle('Температура: 22.5 °C')).toHaveTextContent('Температура: 22.5 °C');
    expect(screen.getByTitle('Влажность: 48 %')).toHaveTextContent('Влажность: 48 %');
    expect(screen.getByText('Температура:')).toHaveClass('sr-only');
    expect(screen.getByText('Влажность:')).toHaveClass('sr-only');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks inline writes when the local device or its gateway is disabled', async () => {
    const local={id:7,device_id:'physical',name:'Локальный свет',transport:'wifi' as const,parent_id:null,cid:null,aliases:[],building_id:null,room_id:null,enabled:false,capabilities:{switch:{type:'boolean' as const,readable:true,writable:true}}};
    vi.mocked(fetch).mockResolvedValue(json({device_id:7,name:local.name,enabled:false,available:false,values:{switch:{value:true,known:true,stale:false}}}));
    renderWithStore(<CardControls api={new HomeApi(connection)} device={{id:'physical',name:local.name,local,cloud:{}}} route="local" now={Date.now()} paused={false} onAuthError={vi.fn()} onBusy={vi.fn()} />);
    const power = await screen.findByRole('switch', {name:'Питание'});
    await waitFor(() => expect(power).toBeChecked());
    expect(power).toBeDisabled();
    expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
    expect(vi.mocked(fetch).mock.calls.every(([,init]) => init?.method === 'GET')).toBe(true);
  });

  it('renews the local watch only while the card is visible and its dashboard is active', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let visibilityChanged!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { visibilityChanged = callback; }
      observe() {}
      disconnect() {}
    });
    const local = {id:7, device_id:'physical', name:'Локальный свет', transport:'wifi' as const, parent_id:null,
      cid:null, aliases:[], building_id:null, room_id:null, enabled:true,
      capabilities:{switch:{type:'boolean' as const, readable:true, writable:true}}};
    vi.mocked(fetch).mockImplementation(async () => json({ device_id:7, enabled:true, available:true,
      values:{switch:{value:false, known:true, stale:false}} }));
    const props = {api:new HomeApi(connection), device:{id:'physical', name:local.name, local, cloud:{}},
      route:'local' as const, now:Date.now(), onAuthError:vi.fn(), onBusy:vi.fn()};
    const view = renderWithStore(<CardControls {...props} paused={false} />);
    const tick = () => act(async () => { vi.advanceTimersByTime(4000); });
    const intersect = (isIntersecting: boolean) =>
      act(async () => visibilityChanged([{isIntersecting} as IntersectionObserverEntry], {} as IntersectionObserver));
    const watches = () => vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).searchParams.has('watch'));
    try {
      const power = await screen.findByRole('switch');
      await waitFor(() => expect(power).toBeEnabled());
      await tick();
      expect(watches()).toHaveLength(0);
      await intersect(true);
      await tick();
      expect(watches()).toHaveLength(1);
      await intersect(false);
      await tick();
      expect(watches()).toHaveLength(1);
      await intersect(true);
      view.rerender(<CardControls {...props} paused />);
      await intersect(true);
      await tick();
      expect(watches()).toHaveLength(1);
      view.rerender(<CardControls {...props} paused={false} />);
      await intersect(true);
      await tick();
      expect(watches()).toHaveLength(2);
      view.unmount();
      await tick();
      expect(watches()).toHaveLength(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

});

describe('card close action and relevant activity filters', () => {
  it('uses an accessible icon for closing and preserves the back action', async () => {
    const close=vi.fn(),user=userEvent.setup();
    renderWithStore(<ControlDialog title="Датчик" subtitle="Комната" busy={false} onClose={close}><p>Показания</p></ControlDialog>);
    const button=screen.getByRole('button',{name:'Закрыть'});
    expect(button).toHaveAttribute('title','Закрыть'); expect(button.textContent).toBe('');
    await user.click(button); expect(close).toHaveBeenCalledTimes(1);
  });
  it('does not suggest motion or commands on a read-only temperature sensor', async () => {
    vi.mocked(fetch).mockResolvedValue(json({events:[{id:1,at:new Date().toISOString(),observed_at:null,kind:'report',code:'va_temperature',value:22,outcome:null}],next_before:null}));
    renderWithStore(<DeviceActivity api={new HomeApi(connection)} deviceId="temp" provider="sharing" specs={[cloudSpec({code:'va_temperature',type:'Integer',values:{unit:'℃',scale:0}},false)]} onAuthError={vi.fn()} />);
    await userEvent.setup().click(screen.getByText('Журнал устройства'));
    expect(await screen.findByText('Температура: 22 °C')).toBeInTheDocument();
    expect(screen.queryByRole('option',{name:'Движение'})).toBeNull();
    expect(screen.queryByRole('combobox',{name:'Показать'})).toBeNull();
  });
});

it('updates the tile connection status and battery from cached reports',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  const observers:IntersectionObserverCallback[]=[];
  vi.stubGlobal('IntersectionObserver',class {constructor(callback:IntersectionObserverCallback){observers.push(callback);}observe(){}disconnect(){}});
  const onStatus=vi.fn();
  const cloud={...lamp,controls:{ready:true,definitions,snapshot}};
  vi.mocked(fetch).mockImplementation(async()=>json({...snapshot,online:false,status:{...snapshot.status,battery_percentage:42}}));
  const view=renderWithStore(<CardControls api={new HomeApi(connection)} device={{id:'lamp',name:'Лампа',cloud:{sharing:cloud}}} route="sharing" now={Date.now()} paused={false} onAuthError={vi.fn()} onBusy={vi.fn()} onStatus={onStatus}/>);
  try {
    await screen.findByRole('switch');
    await waitFor(()=>expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({online:true})));
    await act(async()=>observers[0]([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver));
    await act(async()=>{vi.advanceTimersByTime(4000);});
    expect(fetch).toHaveBeenCalledOnce();
    await act(async()=>{vi.advanceTimersByTime(50);});
    await waitFor(()=>expect(onStatus).toHaveBeenLastCalledWith({online:false,battery:{code:'battery_percentage',value:42,unit:undefined}}));
  } finally {view.unmount();}
});
