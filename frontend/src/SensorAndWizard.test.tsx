import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi, type DeviceEvent } from './api';
import { cloudSpec } from './controls';
import { defaultSchedule, encodeRawSchedule } from './raw-lighting';
import { ScheduleWizard } from './components/ScheduleWizard';
import { DeviceActivity } from './components/DeviceActivity';
import { CloudControl } from './components/CloudControl';

const connection = {baseUrl:'http://api.test',token:'test-key'};
const json = (data: unknown) => new Response(JSON.stringify(data));
const rawSpec = (code: string) => cloudSpec({code,type:'Raw',values:{}},true);

describe('popup schedule wizards', () => {
  it.each(['rhythm_mode','random_timing','wakeup_mode','sleep_mode'])('edits %s in steps and returns a draft only on Done', async code => {
    const onDone = vi.fn(), user = userEvent.setup();
    const value = encodeRawSchedule(code,defaultSchedule(code));
    render(<ScheduleWizard spec={rawSpec(code)} value={value} onDone={onDone} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('list', {name:'Этапы настройки'})).toBeInTheDocument();
    expect(within(dialog).queryByRole('button',{name:'Добавить точку'})).toBeNull();
    await user.click(screen.getByRole('button',{name:'Далее'}));
    expect(screen.getByRole('region',{name:'Настройки точки'})).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Добавить точку'}));
    expect(screen.getByRole('button',{name:/Точка 2/})).toHaveAttribute('aria-pressed','true');
    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'Далее'}));
    expect(screen.getByText(/Точек: 2/)).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Готово'}));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).not.toBe(value);
  });
  it('preserves an unknown format and cancellation discards wizard changes', async () => {
    const done = vi.fn(), close = vi.fn(), user = userEvent.setup();
    render(<ScheduleWizard spec={rawSpec('sleep_mode')} value="AQIDBA==" onDone={done} onClose={close} />);
    expect(screen.getByText(/Исходные данные сохранены/)).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Новое расписание'}));
    await user.click(screen.getByRole('button',{name:'Отмена'}));
    expect(close).toHaveBeenCalledTimes(1); expect(done).not.toHaveBeenCalled();
  });
  it('blocks invalid time values before advancing', async () => {
    const user=userEvent.setup();
    render(<ScheduleWizard spec={rawSpec('sleep_mode')} value={encodeRawSchedule('sleep_mode',defaultSchedule('sleep_mode'))} onDone={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button',{name:'Далее'}));
    fireEvent.change(screen.getByLabelText('Время'),{target:{value:''}});
    await user.click(screen.getByRole('button',{name:'Далее'}));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('region',{name:'Настройки точки'})).toBeInTheDocument();
  });
  it('keeps wizard edits local until Done, then sends them only through the card Apply button', async () => {
    const original=encodeRawSchedule('rhythm_mode',defaultSchedule('rhythm_mode')), writes:unknown[]=[];
    vi.mocked(fetch).mockImplementation(async (input,init) => {
      if (init?.method==='POST') { writes.push(JSON.parse(String(init.body))); return json({acknowledged:true}); }
      return json(new URL(String(input)).pathname.endsWith('/functions') ? {device_id:'lamp',functions:[{code:'rhythm_mode',type:'Raw',values:{}}]} : {device_id:'lamp',online:true,status:{rhythm_mode:original}});
    });
    render(<CloudControl api={new CloudApi(connection)} device={{id:'lamp',name:'Лампа',online:true,has_local_key:false}} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const user=userEvent.setup(); await screen.findByRole('region',{name:'Суточный ритм света'});
    await user.click(screen.getByText('Эффекты и дополнительные параметры'));
    await user.click(screen.getByRole('button',{name:'Настроить'}));
    expect(screen.getByRole('button',{name:'Применить'})).toBeDisabled();
    await user.click(screen.getByRole('button',{name:'Далее'}));
    await user.click(screen.getByRole('button',{name:'Добавить точку'}));
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('button',{name:'Далее'}));
    await user.click(screen.getByRole('button',{name:'Готово'}));
    expect(screen.queryByRole('dialog',{name:/Настройка:/})).toBeNull();
    expect(screen.getByText('Изменено: 1')).toBeInTheDocument();
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('button',{name:'Применить'}));
    await screen.findByText(/Команда принята.*Статус запрошен заново/);
    expect(writes).toHaveLength(1);
    expect((writes[0] as {commands:{code:string;value:string}[]}).commands[0].code).toBe('rhythm_mode');
    expect((writes[0] as {commands:{value:string}[]}).commands[0].value).not.toBe(original);
  });
});

describe('device activity and sensor presentation', () => {
  it('shows real motion events, distinguishes snapshots and command outcomes, and loads older events once', async () => {
    const events: DeviceEvent[] = [
      {id:3,at:'2026-10-10T10:02:00Z',observed_at:null,kind:'report',code:'pir',value:'pir',outcome:null},
      {id:2,at:'2026-10-10T10:01:00Z',observed_at:null,kind:'command',code:'command',value:{switch_led:true},outcome:'accepted'},
    ];
    vi.mocked(fetch).mockImplementation(async input => json(new URL(String(input)).searchParams.has('before') ? {events:[{...events[0],id:1,kind:'snapshot',value:'none'}],next_before:null} : {events,next_before:2}));
    render(<DeviceActivity api={new CloudApi(connection)} deviceId="motion" provider="sharing" primary specs={[cloudSpec({code:'pir',type:'Enum',values:{range:['pir','none']}},false)]} onAuthError={vi.fn()} />);
    expect(await screen.findByText('Движение: Движение обнаружено')).toBeInTheDocument();
    expect(screen.getByText('Команда принята · Питание')).toBeInTheDocument();
    const user=userEvent.setup(); await user.click(screen.getByRole('button',{name:'Более ранние события'}));
    expect(await screen.findByText(/Сохранённый снимок/)).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Более ранние события'})).toBeNull();
    await user.selectOptions(screen.getByRole('combobox',{name:'Показать'}),'commands');
    expect(screen.queryByText('Движение: Движение обнаружено')).toBeNull();
    expect(screen.getByText('Команда принята · Питание')).toBeInTheDocument();
  });
  it('deduplicates cached polls while retaining distinct motion reports and stops polling after unmount', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});
    let events:DeviceEvent[]=[{id:1,at:'2026-10-10T10:00:00Z',observed_at:null,kind:'report',code:'motion',value:true,outcome:null}];
    vi.mocked(fetch).mockImplementation(async () => json({events,next_before:null}));
    const view=render(<DeviceActivity api={new CloudApi(connection)} deviceId="motion" provider="sharing" primary specs={[{key:'motion',label:'Движение',kind:'boolean',indicator:'motion',readable:true,writable:false}]} onAuthError={vi.fn()} />);
    await screen.findByText('Движение: Движение обнаружено');
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getAllByText('Движение: Движение обнаружено')).toHaveLength(1);
    events=[{...events[0],id:2},...events];
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getAllByText('Движение: Движение обнаружено')).toHaveLength(2);
    view.unmount(); const calls=vi.mocked(fetch).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it('translates real va sensor codes, adds measurement icons and moves unitless battery to the header', async () => {
    const ranges=[{code:'va_temperature',type:'Integer',values:{min:-400,max:1200,scale:1,unit:'℃'}},{code:'va_humidity',type:'Integer',values:{min:0,max:100,scale:0,unit:'%'}},{code:'va_battery',type:'Integer',values:{min:0,max:100,scale:0,unit:''}}];
    vi.mocked(fetch).mockImplementation(async input => json(new URL(String(input)).pathname.endsWith('/functions') ? {device_id:'sensor',functions:[],status_range:ranges} : {device_id:'sensor',online:true,status:{va_temperature:205,va_humidity:58,va_battery:100}}));
    render(<CloudControl api={new CloudApi(connection)} device={{id:'sensor',name:'Датчик',online:true,has_local_key:false}} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    expect(await screen.findByRole('region',{name:'Температура'})).toHaveTextContent('20.5 °C');
    expect(screen.getByRole('region',{name:'Влажность'})).toHaveTextContent('58 %');
    expect(screen.getByRole('region',{name:'Температура'}).querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByRole('region',{name:'Батарея'})).toBeNull();
    expect(screen.getByLabelText('Батарея: 100').closest('header')).toBeInTheDocument();
    expect(screen.queryByText('100 %')).toBeNull();
  });
});
