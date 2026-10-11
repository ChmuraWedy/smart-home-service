import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { CloudControl } from './components/CloudControl';

const json=(value:unknown)=>new Response(JSON.stringify(value));
function mountSettings(provider:'sharing'|'developer'='sharing',pending?:Promise<Response>) {
  const writes:{path:string;body:unknown}[]=[];
  const functions=[{code:'basic_private',type:'Boolean',values:'{}'}, {code:'humanoid_filter',type:'Boolean',values:'{}'}, {code:'sd_format',type:'Boolean',values:'{}'}, {code:'basic_nightvision',type:'Enum',values:'{"range":["0","1","2"]}'}];
  vi.mocked(fetch).mockImplementation(async (input,options)=>{
    if (options?.method==='POST') {writes.push({path:String(input),body:JSON.parse(String(options.body))}); return pending || json({acknowledged:true});}
    return json(String(input).includes('/functions') ? {device_id:'camera',functions} : {device_id:'camera',online:true,source:'cloud',status:{basic_private:false,humanoid_filter:false,sd_format:false,sd_status:1,basic_nightvision:'0'}});
  });
  render(<CloudControl api={new CloudApi({baseUrl:'http://api.test',token:'test-key'})} device={{id:'camera',name:'Sleep Cam',category:'sp',online:true,has_local_key:false}} provider={provider} onClose={vi.fn()} onAuthError={vi.fn()} />);
  return writes;
}

describe('camera action buttons',()=>{
  it('toggles privacy immediately while leaving other edited settings for Apply',async()=>{
    const writes=mountSettings(),user=userEvent.setup();
    const privacy=await screen.findByRole('button',{name:'Режим приватности'});
    await waitFor(()=>expect(privacy).toBeEnabled());
    expect(screen.queryByRole('switch',{name:'Режим приватности'})).toBeNull();
    expect(within(screen.getByRole('region',{name:'Видео камеры'})).getByRole('button',{name:'Режим приватности'})).toBe(privacy);
    expect(within(screen.getByRole('region',{name:'Изображение и звук'})).queryByRole('button',{name:'Режим приватности'})).toBeNull();
    const night=screen.getByRole('combobox',{name:'Ночное видение'});
    await waitFor(()=>expect(night).toHaveDisplayValue('Авто'));
    await user.selectOptions(night,'1');
    await user.click(privacy); await waitFor(()=>expect(privacy).toBeEnabled());
    expect(privacy).toHaveAttribute('aria-pressed','true');
    expect(writes.map(write=>write.body)).toEqual([{commands:[{code:'basic_private',value:true}]}]);
    expect(night).toHaveDisplayValue('Выключено');
    await user.click(screen.getByRole('button',{name:/Применить/}));
    await waitFor(()=>expect(writes).toHaveLength(2));
    expect(writes[1].body).toEqual({commands:[{code:'basic_nightvision',value:'1'}]});
  });
  it('shows the human detection explanation only from its info button and closes it without closing the device',async()=>{
    const writes=mountSettings(),user=userEvent.setup();
    const info=await screen.findByRole('button',{name:'Подробнее: Обнаружение человека'});
    expect(screen.queryByText('Камера предоставляет параметр обнаружения человека. API не сообщает, нужна ли подписка и активирована ли функция. Наличие переключателя не подтверждает доступность распознавания; условия проверьте в Smart Life.')).toBeNull();
    await user.click(info);
    expect(screen.getByRole('note',{name:'Обнаружение человека'})).toHaveTextContent('Камера предоставляет параметр обнаружения человека. API не сообщает, нужна ли подписка и активирована ли функция. Наличие переключателя не подтверждает доступность распознавания; условия проверьте в Smart Life.');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('dialog',{name:'Sleep Cam'})).toBeInTheDocument();
    await user.click(info); await user.click(screen.getByRole('button',{name:'Закрыть пояснение'}));
    expect(screen.queryByRole('note')).toBeNull(); expect(info).toHaveFocus();
    await user.click(info); await user.click(screen.getByRole('heading',{name:'Изображение и звук'}));
    expect(screen.queryByRole('note')).toBeNull(); expect(writes).toEqual([]);
  });
  it('formats only after confirmation, never stages an off value, and prevents double submissions',async()=>{
    let resolve!:(response:Response)=>void;
    const pending=new Promise<Response>(r=>{resolve=r;});
    const writes=mountSettings('developer',pending),user=userEvent.setup();
    await user.click(await screen.findByText('Дополнительные параметры камеры',{exact:true}));
    const format=screen.getByRole('button',{name:'Форматировать…'});
    await waitFor(()=>expect(format).toBeEnabled());
    expect(screen.queryByRole('switch',{name:'Форматирование карты памяти'})).toBeNull();
    await user.click(format);
    let confirmation=screen.getByRole('dialog',{name:'Форматирование карты памяти'});
    expect(confirmation).toHaveTextContent('Все записи на карте памяти будут удалены.');
    expect(writes).toEqual([]);
    await user.click(within(confirmation).getByRole('button',{name:'Отмена'}));
    expect(screen.queryByRole('dialog',{name:'Форматирование карты памяти'})).toBeNull();
    expect(writes).toEqual([]);
    await user.click(format); confirmation=screen.getByRole('dialog',{name:'Форматирование карты памяти'});
    await user.dblClick(within(confirmation).getByRole('button',{name:'Форматировать карту'}));
    expect(writes).toEqual([{path:'http://api.test/api/v1/cloud/devices/camera/commands?provider=developer',body:{commands:[{code:'sd_format',value:true}]}}]);
    expect(within(confirmation).getByRole('button',{name:'Отправляем…'})).toBeDisabled();
    await act(async()=>resolve(json({acknowledged:true})));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Форматирование карты памяти'})).toBeNull());
    expect(writes).toHaveLength(1);
    expect(screen.getByRole('button',{name:/Применить/})).toBeDisabled();
  });
});
