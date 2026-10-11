import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CloudDevice, CloudFunctions, CloudSnapshot } from './api';
import { HomeApi } from './home-api';
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

function mount(cloud=lamp, route:'sharing'|'developer'='sharing') {
  return render(<CardControls api={new HomeApi(connection)} device={{id:'lamp',name:'Лампа',cloud:{[route]:cloud}}} route={route} now={Date.now()} paused={false} onAuthError={vi.fn()} onBusy={vi.fn()} />);
}

describe('main controls on device cards', () => {
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
      const toggle=await screen.findByRole('switch',{name:label});
      await waitFor(()=>expect(toggle).toBeEnabled());
      expect(toggle).not.toBeChecked();
      await user.click(toggle);
      await waitFor(()=>expect(toggle).toBeEnabled());
      expect(toggle).toBeChecked();
      expect(writes[index].path).toContain('provider='+route);
      expect(writes[index].body).toEqual({commands:[{code:codes[index],value:true}]});
    }
    expect(writes).toHaveLength(4);
    expect(screen.getAllByRole('switch')).toHaveLength(4);
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
    expect(screen.queryByText('Выключено')).toBeNull();
    await user.click(power);
    await waitFor(() => expect(power).toBeEnabled());
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
    expect(writes).toEqual([{commands:[{code:'switch_led',value:true}]}]);
    expect(power).toHaveAttribute('aria-checked','true');
    expect(screen.getByText('Ожидаем новое показание')).toBeInTheDocument();
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
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('refresh=false');
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
    render(<CardControls {...props} />);
    const user=userEvent.setup(),power=await screen.findByRole('switch',{name:'Питание'});
    await waitFor(() => expect(power).toBeEnabled());
    await user.click(power);
    await waitFor(() => expect(power).toBeEnabled());
    expect(calls).toEqual([{path:'http://api.test/api/v1/devices/7/commands/capabilities',body:{values:{switch:true}}}]);
  });
  it('shows sensor values with accessible labels and no settings editors', async () => {
    const sensorDefinitions:CloudFunctions={device_id:'lamp',functions:[{code:'temp_unit_convert',type:'Enum',values:{range:['c','f']}}],status_range:[{code:'va_temperature',type:'Integer',values:{unit:'℃',scale:1}},{code:'va_humidity',type:'Integer',values:{unit:'%',scale:0}}]};
    mount({...lamp,controls:{ready:true,definitions:sensorDefinitions,snapshot:{...snapshot,status:{va_temperature:225,va_humidity:48}}}});
    expect(await screen.findByLabelText('Температура: 22.5 °C')).toHaveTextContent('22.5 °C');
    expect(screen.getByLabelText('Влажность: 48 %')).toHaveTextContent('48 %');
    expect(screen.queryByText('Температура')).toBeNull();
    expect(screen.queryByText('Влажность')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks inline writes when the local device or its gateway is disabled', async () => {
    const local={id:7,device_id:'physical',name:'Локальный свет',transport:'wifi' as const,parent_id:null,cid:null,aliases:[],building_id:null,room_id:null,enabled:false,capabilities:{switch:{type:'boolean' as const,readable:true,writable:true}}};
    render(<CardControls api={new HomeApi(connection)} device={{id:'physical',name:local.name,local,cloud:{}}} route="local" state={{device_id:7,name:local.name,enabled:false,available:false,values:{switch:{value:false,known:true,stale:false}}}} now={Date.now()} paused={false} onAuthError={vi.fn()} onBusy={vi.fn()} />);
    expect(await screen.findByRole('switch',{name:'Питание'})).toBeDisabled();
    expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

});

describe('card close action and relevant activity filters', () => {
  it('uses an accessible icon for closing and preserves the back action', async () => {
    const close=vi.fn(),user=userEvent.setup();
    render(<ControlDialog title="Датчик" subtitle="Комната" busy={false} onClose={close}><p>Показания</p></ControlDialog>);
    const button=screen.getByRole('button',{name:'Закрыть'});
    expect(button).toHaveAttribute('title','Закрыть'); expect(button.textContent).toBe('');
    await user.click(button); expect(close).toHaveBeenCalledTimes(1);
  });
  it('does not suggest motion or commands on a read-only temperature sensor', async () => {
    vi.mocked(fetch).mockResolvedValue(json({events:[{id:1,at:new Date().toISOString(),observed_at:null,kind:'report',code:'va_temperature',value:22,outcome:null}],next_before:null}));
    render(<DeviceActivity api={new HomeApi(connection)} deviceId="temp" provider="sharing" specs={[cloudSpec({code:'va_temperature',type:'Integer',values:{unit:'℃',scale:0}},false)]} onAuthError={vi.fn()} />);
    await userEvent.setup().click(screen.getByText('Журнал устройства'));
    expect(await screen.findByText('Температура: 22 °C')).toBeInTheDocument();
    expect(screen.queryByRole('option',{name:'Движение'})).toBeNull();
    expect(screen.queryByRole('combobox',{name:'Показать'})).toBeNull();
  });
});
