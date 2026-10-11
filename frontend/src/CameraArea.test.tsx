import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { CloudControl } from './components/CloudControl';
import { encodeArea, parseArea, shiftArea } from './camera-area';

const json=(value:unknown)=>new Response(JSON.stringify(value));
const original=JSON.stringify({num:1,region0:{x:10,y:20,xlen:40,ylen:30,vendor:'keep'},version:2});
function mount(storage:unknown=5,area=original) {
  const writes:unknown[]=[];
  const functions=[{code:'motion_area',type:'String',values:'{}'},{code:'motion_area_switch',type:'Boolean',values:'{}'},{code:'record_switch',type:'Boolean',values:'{}'},{code:'record_mode',type:'Enum',values:'{"range":["1","2"]}'},{code:'sd_format',type:'Boolean',values:'{}'}];
  vi.mocked(fetch).mockImplementation(async(input,options)=>{
    if (options?.method==='POST') {writes.push(JSON.parse(String(options.body))); return json({acknowledged:true});}
    return json(String(input).includes('/functions') ? {device_id:'camera',functions,status_range:[{code:'sd_status',type:'Integer',values:'{"scale":1,"min":0,"max":100}'}]} : {device_id:'camera',online:true,source:'cloud',status:{sd_status:storage,record_switch:true,record_mode:'1',sd_format:false,motion_area:area,motion_area_switch:true}});
  });
  render(<CloudControl api={new CloudApi({baseUrl:'http://api.test',token:'test-key'})} device={{id:'camera',name:'Sleep Cam',category:'sp',online:true,has_local_key:false}} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
  return writes;
}

describe('camera storage and activity area',()=>{
  it.each([5,2,3,4,null,42])('blocks unavailable recording for card status %s without changing the reported recording preference',async status=>{
    const writes=mount(status),user=userEvent.setup();
    const recording=await screen.findByRole('region',{name:'Запись на карту памяти'});
    expect(recording).toHaveTextContent('Недоступна');
    expect(recording).toHaveTextContent('Сохранённая настройка записи включена');
    expect(screen.queryByRole('switch',{name:'Запись на карту памяти'})).toBeNull();
    expect(screen.getByRole('combobox',{name:'Режим записи'})).toBeDisabled();
    await user.click(screen.getByText('Дополнительные параметры камеры',{exact:true}));
    expect(screen.getByRole('button',{name:'Форматировать…'})).toHaveProperty('disabled',![2,3].includes(Number(status)));
    if (status===5) expect(screen.getByRole('region',{name:'Состояние карты памяти'})).toHaveTextContent('Карта памяти не установлена');
    expect(writes).toEqual([]);
  });
  it('allows recording only when the raw card status is ready',async()=>{
    mount(1);
    expect(await screen.findByRole('switch',{name:'Запись на карту памяти'})).toBeEnabled();
  });
  it('edits the stored rectangle, cancels without writes and saves only through the common Apply button',async()=>{
    const writes=mount(),user=userEvent.setup();
    const edit=await screen.findByRole('button',{name:'Изменить область'});
    await waitFor(()=>expect(edit).toBeEnabled());
    await user.click(edit);
    let dialog=screen.getByRole('dialog',{name:'Область обнаружения'});
    expect(within(dialog).getByRole('spinbutton',{name:'Слева (%)'})).toHaveValue(10);
    await user.click(within(dialog).getByRole('button',{name:'Изменить размер области'}));
    await user.keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('spinbutton',{name:'Ширина (%)'})).toHaveValue(41);
    await user.click(within(dialog).getByRole('button',{name:'Отмена'}));
    expect(writes).toEqual([]); expect(screen.getByRole('button',{name:/Применить/})).toBeDisabled();
    await user.click(edit); dialog=screen.getByRole('dialog',{name:'Область обнаружения'});
    expect(within(dialog).getByRole('spinbutton',{name:'Ширина (%)'})).toHaveValue(40);
    await user.click(within(dialog).getByRole('button',{name:'Переместить область'})); await user.keyboard('{ArrowRight}');
    await user.click(within(dialog).getByRole('button',{name:'Сохранить'}));
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('button',{name:/Применить/}));
    await waitFor(()=>expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({commands:[{code:'motion_area',value:JSON.stringify({num:1,region0:{x:11,y:20,xlen:40,ylen:30,vendor:'keep'},version:2})}]});
    expect(vi.mocked(fetch).mock.calls.some(([input])=>String(input).includes('/stream'))).toBe(false);
  });
  it('rejects rectangles outside the image and never replaces unsupported areas',()=>{
    const parsed=parseArea(original)!;
    expect(shiftArea(parsed.area,100,100)).toEqual({x:60,y:70,xlen:40,ylen:30});
    expect(shiftArea(parsed.area,-100,-100,true)).toEqual({x:10,y:20,xlen:1,ylen:1});
    expect(()=>encodeArea(parsed.document,{x:90,y:0,xlen:20,ylen:10})).toThrow();
    expect(parseArea('{"num":2,"region0":{"x":0,"y":0,"xlen":20,"ylen":20}}')).toBeNull();
    expect(parseArea('{"num":1,"region0":{"x":0,"y":0,"xlen":0,"ylen":20}}')).toBeNull();
  });
  it('blocks an edited recording command if the card disappears before Apply',async()=>{
    vi.useFakeTimers({shouldAdvanceTime:true});
    const writes=mount(1),user=userEvent.setup({advanceTimers:vi.advanceTimersByTime});
    try {
      const mode=await screen.findByRole('combobox',{name:'Режим записи'});
      await user.selectOptions(mode,'1');
      const originalFetch=vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async(input,options)=>{
        if (options?.method!=='POST' && String(input).includes('/status')) return json({device_id:'camera',online:true,source:'cloud',status:{sd_status:5,record_switch:true,record_mode:'1',motion_area:original}});
        return originalFetch(input,options);
      });
      await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
      expect(mode).toBeDisabled();
      await user.click(screen.getByRole('button',{name:/Применить/}));
      expect(writes).toEqual([]); expect(await screen.findByRole('alert')).toHaveTextContent('Карта памяти не установлена');
    } finally {vi.useRealTimers();}
  });
});
