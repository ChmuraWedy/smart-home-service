import { renderWithStore } from './test/render-with-store';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { CloudControl } from './components/CloudControl';
import { CapabilityField } from './components/DeviceControls';
import type { ControlSpec } from './controls';
import type { Reading } from './home-api';

it.each([
  {key:'countdown_1',label:'Таймер канала 1',kind:'number',minimum:0,maximum:86400,initial:0,target:120},
  {key:'bright_value_v2',label:'Яркость',kind:'number',minimum:1,maximum:100,initial:40,target:65},
  {key:'temp_value_v2',label:'Цветовая температура',kind:'number',minimum:0,maximum:100,initial:20,target:50},
  {key:'work_mode',label:'Режим',kind:'enum',choices:['white','colour'],initial:'colour',target:'white'},
] as const)('keeps $label selected through stale snapshots, then accepts a new device report', async setup => {
  const spec = {...setup,readable:true,writable:true} as unknown as ControlSpec;
  const sentAt=Date.now(), send=vi.fn().mockResolvedValue(true), user=userEvent.setup();
  const reading:Reading={known:true,value:setup.initial,stale:false,observed_at:new Date(sentAt-10000).toISOString()};
  const props={pendingScope:'device',spec,reading,now:sentAt,local:false,disabled:false,onSend:send};
  const view=renderWithStore(<CapabilityField {...props}/>);
  const input=screen.getByRole(setup.kind==='number'?'spinbutton':'combobox');
  if(setup.kind==='enum') await user.selectOptions(input,'0');
  else fireEvent.change(input,{target:{value:String(setup.target)}});
  await user.click(screen.getByRole('button',{name:'Применить'}));
  expect(send).toHaveBeenCalledWith(setup.target);
  await screen.findByText('Ожидаем новое показание');
  view.rerender(<CapabilityField {...props} now={sentAt+6000} reading={{...reading}}/>);
  expect(input).toHaveValue(setup.kind==='enum'?'0':setup.target);
  expect(send).toHaveBeenCalledTimes(1);
  const actual=setup.key==='countdown_1'?119:setup.target;
  view.rerender(<CapabilityField {...props} now={sentAt+7000} reading={{...reading,value:actual,observed_at:new Date(sentAt+7000).toISOString()}}/>);
  await waitFor(()=>expect(screen.queryByText('Ожидаем новое показание')).not.toBeInTheDocument());
  expect(input).toHaveValue(setup.kind==='enum'?'0':actual);
});

it('keeps the draft available when a command is rejected', async()=>{
  const send=vi.fn().mockResolvedValue(false), user=userEvent.setup();
  renderWithStore(<CapabilityField pendingScope="device" spec={{key:'timer',label:'Таймер',kind:'number',minimum:0,maximum:100,readable:true,writable:true}} reading={{known:true,value:0,stale:false}} now={Date.now()} local={false} disabled={false} onSend={send}/>);
  fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'50'}});
  await user.click(screen.getByRole('button',{name:'Применить'}));
  expect(screen.queryByText('Ожидаем новое показание')).not.toBeInTheDocument();
  expect(screen.getByRole('spinbutton')).toHaveValue(50);
  expect(screen.getByRole('button',{name:'Применить'})).toBeEnabled();
});

it('puts switch configuration in collapsed additional settings and shows relative report age with refresh',async()=>{
  const snapshot={device_id:'switch',online:true,status:{switch_1:true,relay_status:'last',switch_backlight:true,switch_inching:''},status_observations:{switch_1:{received_at:new Date(Date.now()-5000).toISOString()}}};
  const functions=[{code:'switch_1',type:'Boolean',values:'{}'},{code:'relay_status',type:'Enum',values:{range:['on','off','last']}},{code:'switch_backlight',type:'Boolean',values:'{}'},{code:'switch_inching',type:'String',values:'{}'}];
  vi.mocked(fetch).mockImplementation(async input=>new Response(JSON.stringify(String(input).includes('/functions')?{device_id:'switch',functions}:snapshot),{status:200}));
  renderWithStore(<CloudControl api={new CloudApi({baseUrl:'http://api.test',token:'key'})} device={{id:'switch',name:'Switch',online:true,has_local_key:false}} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()}/>);
  const channel=await screen.findByRole('region',{name:'Канал 1'});
  expect(within(channel).getByText(/\d+ с назад/)).toBeInTheDocument();
  expect(within(channel).getByRole('button',{name:'Добавить алиас'})).toBeInTheDocument();
  const details=screen.getByText('Дополнительные настройки').closest('details')!;
  expect(details).not.toHaveAttribute('open');
  expect(within(details).getByRole('heading',{name:'Состояние после подачи питания'})).toBeInTheDocument();
  expect(within(details).getByRole('heading',{name:'Подсветка выключателя'})).toBeInTheDocument();
  expect(within(details).getByRole('heading',{name:'Автовыключение (импульсный режим)'})).toBeInTheDocument();
  const before=vi.mocked(fetch).mock.calls.length;
  await userEvent.setup().click(screen.getByRole('button',{name:'Обновить статус'}));
  await waitFor(()=>expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(before));
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
});
