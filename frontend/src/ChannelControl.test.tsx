import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi, type CloudDevice, type CloudSnapshot, type CloudFunctions } from './api';
import { CloudControl } from './components/CloudControl';
import { CardControls } from './components/CardControls';
import { HomeApi } from './home-api';

const connection = {baseUrl:'http://api.test',token:'test-key'};
const definitions:CloudFunctions = {device_id:'switch',functions:[
  {code:'switch_1',type:'Boolean',values:{}}, {code:'switch_2',type:'Boolean',values:{}},
  {code:'countdown_1',type:'Integer',values:{min:0,max:86400,step:1,unit:'s'}},
  {code:'countdown_2',type:'Integer',values:{min:0,max:86400,step:1,unit:'s'}},
]};
const snapshot:CloudSnapshot = {source:'cloud',device_id:'switch',online:true,status:{switch_1:false,switch_2:true,countdown_1:30,countdown_2:60}};
const device:CloudDevice = {id:'switch',name:'Выключатель',online:true,has_local_key:false,controls:{ready:true,definitions,snapshot}};
const json=(value:unknown)=>new Response(JSON.stringify(value));
function server() {
  const writes:unknown[]=[];
  vi.mocked(fetch).mockImplementation(async (input,init) => {
    if (init?.method==='POST') { writes.push(JSON.parse(String(init.body))); return json({acknowledged:true}); }
    return json(String(input).includes('/functions') ? definitions : snapshot);
  });
  return writes;
}

describe('channel timer disclosure',()=>{
  it('preserves a collapsed timer draft and applies only that channel timer with the shared Apply',async()=>{
    const writes=server(),user=userEvent.setup();
    render(<CloudControl api={new CloudApi(connection)} device={device} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const clock=await screen.findByRole('button',{name:'Таймер канала 2'});
    expect(screen.queryByRole('spinbutton',{name:'Таймер канала 2 (с)'})).toBeNull();
    await user.click(clock);
    const input=screen.getByRole('spinbutton',{name:'Таймер канала 2 (с)'});
    expect(input).toHaveValue(60);
    fireEvent.change(input,{target:{value:'120'}});
    await user.click(clock);
    expect(screen.queryByRole('spinbutton',{name:'Таймер канала 2 (с)'})).toBeNull();
    expect(writes).toEqual([]);
    await user.click(clock);
    expect(screen.getByRole('spinbutton',{name:'Таймер канала 2 (с)'})).toHaveValue(120);
    expect(screen.getByRole('switch',{name:'Канал 1'})).toHaveAttribute('aria-checked','false');
    expect(screen.getByRole('switch',{name:'Канал 2'})).toHaveAttribute('aria-checked','true');
    await user.click(screen.getByRole('button',{name:'Применить'}));
    await waitFor(()=>expect(writes).toEqual([{commands:[{code:'countdown_2',value:120}]}]));
  });
  it('keeps both power channels on the main card and reserves timers for the full editor',async()=>{
    const writes=server();
    render(<CardControls api={new HomeApi(connection)} device={{id:device.id,name:device.name,cloud:{sharing:device}}} route="sharing" now={Date.now()} paused={false} onAuthError={vi.fn()} onBusy={vi.fn()} />);
    expect(await screen.findByRole('switch',{name:'Канал 1'})).toHaveAttribute('aria-checked','false');
    expect(screen.getByRole('switch',{name:'Канал 2'})).toHaveAttribute('aria-checked','true');
    expect(screen.queryByRole('button',{name:/Таймер канала/})).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(writes).toEqual([]);
  });
});
