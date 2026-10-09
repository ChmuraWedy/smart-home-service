import { act, render, screen } from '@testing-library/react';
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
  it('uses cached inventory, stages edits, sends one validated batch, and retains targets against an old snapshot', async () => {
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
    await user.click(power);
    const bright=screen.getByRole('spinbutton',{name:'Яркость (%)'});
    await user.clear(bright); await user.type(bright,'35');
    expect(writes).toHaveLength(0);
    await user.click(screen.getByRole('button',{name:'Применить'}));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(writes).toEqual([{commands:[{code:'switch_led',value:true},{code:'bright_value_v2',value:350}]}]);
    expect(power).toHaveAttribute('aria-checked','true');
    expect(bright).toHaveValue(35);
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

  it('keeps drafts but stops cached polling when the card scrolls out of view', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});
    const observers:IntersectionObserverCallback[]=[];
    vi.stubGlobal('IntersectionObserver',class { constructor(callback:IntersectionObserverCallback){observers.push(callback);} observe(){} disconnect(){} });
    vi.mocked(fetch).mockImplementation(async () => json(snapshot));
    const view=mount();
    try {
      const user=userEvent.setup();
      await user.click(await screen.findByRole('switch',{name:'Питание'}));
      await act(async () => observers[0]([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver));
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('refresh=false');
      await act(async () => observers[0]([{isIntersecting:false} as IntersectionObserverEntry],{} as IntersectionObserver));
      await act(async () => { vi.advanceTimersByTime(6000); });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('switch',{name:'Питание'})).toHaveAttribute('aria-checked','true');
      expect(screen.getByRole('button',{name:'Применить'})).toBeEnabled();
    } finally { view.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it.each(['sharing','developer'] as const)('keeps %s errors on the selected route without retry or fallback', async route => {
    const writes:string[]=[];
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      if (init?.method==='POST') { writes.push(String(input)); return json({detail:'Нет связи'},409); }
      return json(snapshot);
    });
    mount(lamp,route); const user=userEvent.setup();
    await user.click(await screen.findByRole('switch',{name:'Питание'}));
    await user.click(screen.getByRole('button',{name:'Применить'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Команда отклонена');
    expect(writes).toHaveLength(1); expect(writes[0]).toContain('provider='+route);
    expect(screen.getByRole('button',{name:'Применить'})).toBeEnabled();
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
    const user=userEvent.setup(); await user.click(await screen.findByRole('switch',{name:'Питание'}));
    await user.click(screen.getByRole('button',{name:'Применить'}));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(calls).toEqual([{path:'http://api.test/api/v1/devices/7/commands/capabilities',body:{values:{switch:true}}}]);
  });
  it('blocks inline writes when the local device or its gateway is disabled', async () => {
    const local={id:7,device_id:'physical',name:'Локальный свет',transport:'wifi' as const,parent_id:null,cid:null,aliases:[],building_id:null,room_id:null,enabled:false,capabilities:{switch:{type:'boolean' as const,readable:true,writable:true}}};
    render(<CardControls api={new HomeApi(connection)} device={{id:'physical',name:local.name,local,cloud:{}}} route="local" state={{device_id:7,name:local.name,enabled:false,available:false,values:{switch:{value:false,known:true,stale:false}}}} now={Date.now()} paused={false} onAuthError={vi.fn()} onBusy={vi.fn()} />);
    expect(await screen.findByRole('switch',{name:'Питание'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Применить'})).toBeDisabled();
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
