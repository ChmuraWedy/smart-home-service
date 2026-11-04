import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { CameraLive } from './components/CameraLive';
import { CloudControl } from './components/CloudControl';
import { ControlCenter } from './components/ControlCenter';
import { HomeApi } from './home-api';

const hls = vi.hoisted(() => ({ destroy:vi.fn(), load:vi.fn(), attach:vi.fn(), handlers:{} as Record<string, (...args:any[])=>void>, supported:true, levels:[] as {width:number;height:number;bitrate:number}[], currentLevel:-1 }));
vi.mock('hls.js', () => ({default:class {
  static Events = {ERROR:'error',MANIFEST_PARSED:'manifest',FRAG_LOADED:'fragment'};
  static isSupported() { return hls.supported; }
  get levels() { return hls.levels; }
  set currentLevel(value:number) { hls.currentLevel=value; }
  destroy = hls.destroy; loadSource = hls.load; attachMedia = hls.attach;
  on(event:string, handler:(...args:any[])=>void) { hls.handlers[event]=handler; }
}}));
const connection={baseUrl:'http://api.test',token:'private-test-key'};
const url='https://video.example.test/live.m3u8?sign=temporary';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function mount(provider:'sharing'|'developer'='sharing',onAuthError=vi.fn()) {
  return render(<CameraLive api={new CloudApi(connection)} deviceId="camera" provider={provider} onAuthError={onAuthError} />);
}
function mountTiles(privacy?:boolean) {
  const functions=privacy===undefined ? [] : [{code:'basic_private',type:'Boolean',values:'{}'}];
  const snapshot={device_id:'camera',online:true,source:'cloud',status:privacy===undefined ? {} : {basic_private:privacy}};
  const definitions={device_id:'camera',functions};
  vi.mocked(fetch).mockImplementation(async (input) => {
    const path=new URL(String(input)).pathname;
    if (path.endsWith('/stream')) return json({device_id:'camera',type:'hls',url});
    if (path.endsWith('/cloud/topology')) return json({synced_at:null,warnings:0,placements:[],job:{status:'idle',processed:0,total:0,message:null}});
    if (path.endsWith('/cloud/devices')) return json([{id:'camera',name:'Sleep Cam',category:'sp',online:true,has_local_key:false,...(privacy===undefined ? {} : {controls:{ready:true,definitions,snapshot}})}]);
    if (path.endsWith('/functions')) return json(definitions);
    if (path.endsWith('/status')) return json(snapshot);
    return json([]);
  });
  return render(<ControlCenter api={new HomeApi(connection)} ready sharingReady developerReady onAuthError={vi.fn()} onLock={vi.fn()} />);
}
beforeEach(()=>{
  hls.supported=true; hls.handlers={}; hls.levels=[]; hls.currentLevel=-1;
  vi.spyOn(HTMLMediaElement.prototype,'canPlayType').mockReturnValue('');
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
  vi.mocked(fetch).mockResolvedValue(json({device_id:'camera',type:'hls',url}));
});

describe('camera live viewing',()=>{
  it('blocks preview allocation during privacy and keeps playback stopped when privacy is turned off',async()=>{
    const api=new CloudApi(connection),onAuthError=vi.fn(),blocked='Режим приватности включён. Выключите его для просмотра видео.';
    const view=render(<CameraLive api={api} deviceId="camera" provider="sharing" onAuthError={onAuthError} compact autoStart viewingBlocked={blocked} />);
    expect(screen.getByRole('button',{name:'Смотреть видео'})).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(<CameraLive api={api} deviceId="camera" provider="sharing" onAuthError={onAuthError} compact autoStart />);
    expect(screen.getByRole('button',{name:'Смотреть видео'})).toBeEnabled();
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button',{name:'Смотреть видео'}));
    await waitFor(()=>expect(hls.attach).toHaveBeenCalled());
    view.rerender(<CameraLive api={api} deviceId="camera" provider="sharing" onAuthError={onAuthError} compact autoStart viewingBlocked={blocked} />);
    expect(hls.destroy).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Прямой эфир камеры')).toBeNull();
    view.rerender(<CameraLive api={api} deviceId="camera" provider="sharing" onAuthError={onAuthError} compact autoStart />);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('discards an in-flight stream if privacy becomes enabled',async()=>{
    let resolve!:(value:Response)=>void;
    vi.mocked(fetch).mockReturnValue(new Promise(r=>{resolve=r;}));
    const api=new CloudApi(connection),onAuthError=vi.fn();
    const view=render(<CameraLive api={api} deviceId="camera" provider="sharing" onAuthError={onAuthError} />);
    await userEvent.setup().click(screen.getByRole('button',{name:'Смотреть видео'}));
    view.rerender(<CameraLive api={api} deviceId="camera" provider="sharing" onAuthError={onAuthError} viewingBlocked="Режим приватности включён." />);
    await act(async()=>resolve(json({device_id:'camera',type:'hls',url})));
    expect(hls.attach).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Прямой эфир камеры')).toBeNull();
    expect(screen.getByRole('button',{name:'Смотреть видео'})).toBeDisabled();
  });

  it('selects only actual stream variants, reports playback and download speed, and clears measurements on stop',async()=>{
    hls.levels=[{width:640,height:360,bitrate:500000},{width:1920,height:1080,bitrate:2000000}];
    mount(); const user=userEvent.setup();
    const quality=screen.getByRole('combobox',{name:'Качество видео HD/SD'});
    expect(quality).toBeDisabled(); expect(screen.getByText('Wi-Fi: Нет данных')).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Смотреть видео'}));
    await waitFor(()=>expect(hls.attach).toHaveBeenCalled());
    await act(async()=>hls.handlers.manifest());
    expect(quality).toBeEnabled();
    expect(within(quality).getByRole('option',{name:'SD · 640×360 · 500 кбит/с'})).toBeInTheDocument();
    await user.selectOptions(quality,'1');
    expect(hls.currentLevel).toBe(1);
    await user.selectOptions(quality,'-1'); expect(hls.currentLevel).toBe(-1);
    const video=screen.getByLabelText('Прямой эфир камеры');
    Object.defineProperties(video,{videoWidth:{value:1920},videoHeight:{value:1080}});
    fireEvent.playing(video);
    expect(screen.getByText('HD · 1920×1080',{exact:true})).toBeInTheDocument();
    expect(screen.getByText('Видеосвязь: Воспроизводится')).toBeInTheDocument();
    fireEvent.waiting(video); expect(screen.getByText('Видеосвязь: Буферизация')).toBeInTheDocument();
    await act(async()=>hls.handlers.fragment('fragment',{frag:{type:'main',stats:{loaded:250000,loading:{start:100,end:1100}}}}));
    expect(screen.getByText('Загрузка: 250 КБ/с')).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Остановить'}));
    expect(quality).toBeDisabled(); expect(screen.getByText('Загрузка: —')).toBeInTheDocument();
    expect(screen.queryByText('HD · 1920×1080',{exact:true})).toBeNull();
    expect(screen.getByText('Видеосвязь: Просмотр выключен')).toBeInTheDocument();
  });
  it('does not invent an SD variant for a single-quality stream and does not confuse Wi-Fi signal with loading speed',async()=>{
    hls.levels=[{width:1920,height:1080,bitrate:2000000}];
    render(<CameraLive api={new CloudApi(connection)} deviceId="camera" provider="sharing" onAuthError={vi.fn()} networkSignal="-55 dBm" />);
    await userEvent.setup().click(screen.getByRole('button',{name:'Смотреть видео'}));
    await waitFor(()=>expect(hls.attach).toHaveBeenCalled());
    await act(async()=>hls.handlers.manifest());
    const quality=screen.getByRole('combobox',{name:'Качество видео HD/SD'});
    expect(quality).toBeDisabled(); expect(within(quality).getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('Переключение HD/SD недоступно для этого потока.')).toBeInTheDocument();
    expect(screen.getByText('Wi-Fi: -55 dBm')).toBeInTheDocument();
  });
  it('shows the privacy explanation instead of allocating a main tile preview',async()=>{
    mountTiles(true); const user=userEvent.setup();
    const card=await screen.findByRole('listitem',{name:'Sleep Cam'});
    const privacy=await within(card).findByRole('button',{name:'Приватность'});
    await waitFor(()=>expect(privacy).toHaveAttribute('aria-pressed','true'));
    await user.click(within(card).getByRole('button',{name:'Показать видео камеры'}));
    expect(within(card).getByRole('button',{name:'Смотреть видео'})).toBeDisabled();
    expect(card).toHaveTextContent('Выключите его для просмотра видео');
    expect(vi.mocked(fetch).mock.calls.some(([input])=>String(input).includes('/stream'))).toBe(false);
  });
  it('expands a main tile into live video without opening details and destroys the player on collapse',async()=>{
    mountTiles(); const user=userEvent.setup();
    const card=await screen.findByRole('listitem',{name:'Sleep Cam'});
    expect(hls.attach).not.toHaveBeenCalled();
    await user.click(within(card).getByRole('button',{name:'Показать видео камеры'}));
    await waitFor(()=>expect(hls.load).toHaveBeenCalledWith(url));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card.querySelector('.camera-live-compact')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Прямой эфир камеры'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([input])=>String(input).includes('/stream')).map(([input])=>String(input))).toEqual(['http://api.test/api/v1/cloud/devices/camera/stream?provider=sharing']);
    await user.click(within(card).getByRole('button',{name:'Свернуть видео камеры'}));
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(within(card).queryByRole('region',{name:'Видео камеры'})).toBeNull();
    expect(within(card).getByRole('button',{name:'Показать видео камеры'})).toHaveAttribute('aria-expanded','false');
  });
  it('stops and collapses inline viewing on route changes and opening details without restarting on close',async()=>{
    mountTiles(); const user=userEvent.setup();
    const card=await screen.findByRole('listitem',{name:'Sleep Cam'});
    await user.click(within(card).getByRole('button',{name:'Показать видео камеры'}));
    await waitFor(()=>expect(hls.attach).toHaveBeenCalledTimes(1));
    await user.selectOptions(within(card).getByRole('combobox'),'developer');
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(within(card).queryByRole('region',{name:'Видео камеры'})).toBeNull();
    await user.click(within(card).getByRole('button',{name:'Показать видео камеры'}));
    await waitFor(()=>expect(hls.attach).toHaveBeenCalledTimes(2));
    const streams=()=>vi.mocked(fetch).mock.calls.filter(([input])=>String(input).includes('/stream'));
    expect(String(streams()[1][0])).toContain('provider=developer');
    await user.click(within(card).getByRole('button',{name:'Подробнее'}));
    expect(hls.destroy).toHaveBeenCalledTimes(2);
    const dialog=screen.getByRole('dialog');
    expect(within(dialog).getByRole('button',{name:'Смотреть видео'})).toBeEnabled();
    await user.click(within(dialog).getByRole('button',{name:'Закрыть'}));
    expect(within(card).queryByRole('region',{name:'Видео камеры'})).toBeNull();
    expect(streams()).toHaveLength(2);
  });
  it('does not allocate on opening; starts only the selected route and stops the HLS player',async()=>{
    const view=mount('developer'),user=userEvent.setup();
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'Смотреть видео'}));
    await waitFor(()=>expect(hls.load).toHaveBeenCalledWith(url));
    const [path,options]=vi.mocked(fetch).mock.calls[0];
    expect(String(path)).toContain('/devices/camera/stream?provider=developer');
    expect(options?.method).toBe('POST');
    expect(hls.attach).toHaveBeenCalledWith(screen.getByLabelText('Прямой эфир камеры'));
    await act(async()=>hls.handlers.manifest());
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    fireEvent.playing(screen.getByLabelText('Прямой эфир камеры'));
    expect(screen.getByRole('status')).toHaveTextContent('Прямой эфир');
    await user.click(screen.getByRole('button',{name:'Остановить'}));
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Прямой эфир камеры')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Просмотр остановлен');
    view.unmount();
  });
  it('destroys the stream on unmount and never records or requests a microphone',async()=>{
    const view=mount();
    await userEvent.setup().click(screen.getByRole('button',{name:'Смотреть видео'}));
    await waitFor(()=>expect(hls.attach).toHaveBeenCalled());
    expect(screen.getByLabelText('Прямой эфир камеры')).toHaveAttribute('playsinline');
    view.unmount();
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
  it('cancels an in-flight allocation without starting a late stream',async()=>{
    let resolve!:(value:Response)=>void;
    vi.mocked(fetch).mockReturnValue(new Promise(r=>{resolve=r;}));
    mount(); const user=userEvent.setup();
    await user.click(screen.getByRole('button',{name:'Смотреть видео'}));
    await user.click(screen.getByRole('button',{name:'Остановить'}));
    await act(async()=>resolve(json({device_id:'camera',type:'hls',url})));
    expect(hls.attach).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Прямой эфир камеры')).toBeNull();
  });
  it('reports a fatal playback error without showing the signed address',async()=>{
    mount(); await userEvent.setup().click(screen.getByRole('button',{name:'Смотреть видео'}));
    await waitFor(()=>expect(hls.attach).toHaveBeenCalled());
    await act(async()=>hls.handlers.error('error',{fatal:true,url}));
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось воспроизвести');
    expect(screen.getByRole('alert')).not.toHaveTextContent('temporary');
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button',{name:'Подключиться заново'})).toBeEnabled();
  });
  it('uses native HLS when MediaSource is unavailable',async()=>{
    hls.supported=false;
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue('probably');
    mount(); await userEvent.setup().click(screen.getByRole('button',{name:'Смотреть видео'}));
    await waitFor(()=>expect(screen.getByLabelText('Прямой эфир камеры')).toHaveAttribute('src',url));
    expect(hls.attach).not.toHaveBeenCalled();
  });
  it('handles authentication failure without fallback',async()=>{
    const onAuthError=vi.fn(); vi.mocked(fetch).mockResolvedValue(json({},401));
    mount('sharing',onAuthError); await userEvent.setup().click(screen.getByRole('button',{name:'Смотреть видео'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ключ доступа');
    expect(onAuthError).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('places video in the full camera editor without allocating automatically',async()=>{
    vi.mocked(fetch).mockImplementation(async input=>json(String(input).includes('/functions') ? {device_id:'camera',functions:[]} : {device_id:'camera',online:true,source:'cloud',status:{}}));
    render(<CloudControl api={new CloudApi(connection)} device={{id:'camera',name:'Sleep Cam',category:'sp',online:true,has_local_key:false}} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    expect(screen.getByRole('button',{name:'Смотреть видео'})).toBeEnabled();
    await screen.findByText('Последнее известное состояние в облаке. Обновите статус для получения нового снимка.');
    expect(vi.mocked(fetch).mock.calls.every(([,options])=>options?.method!=='POST')).toBe(true);
  });
  it('groups only advertised camera settings and sends edited original mode values automatically',async()=>{
    const functions=[
      {code:'basic_private',type:'Boolean',values:'{}'},
      {code:'basic_nightvision',type:'Enum',values:'{"range":["0","1","2"]}'},
      {code:'motion_switch',type:'Boolean',values:'{}'},
      {code:'record_mode',type:'Enum',values:'{"range":["1","2"]}'},
      {code:'sd_format',type:'Boolean',values:'{}'},
      {code:'vendor_setting',type:'Boolean',values:'{}'},
    ];
    vi.mocked(fetch).mockImplementation(async (input,options)=>{
      if (options?.method==='POST') return json({acknowledged:true,state_confirmed:false});
      if (String(input).includes('/functions')) return json({device_id:'camera',functions,status_range:[{code:'sd_status',type:'Integer',values:'{"min":1,"max":5,"scale":0,"step":1}'}]});
      return json({device_id:'camera',online:true,source:'cloud',status:{basic_private:false,basic_nightvision:'0',motion_switch:true,record_mode:'1',sd_status:1,sd_format:false,vendor_setting:false}});
    });
    render(<CloudControl api={new CloudApi(connection)} device={{id:'camera',name:'Sleep Cam',category:'sp',online:true,has_local_key:false}} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()} />);
    const image=await screen.findByRole('region',{name:'Изображение и звук'});
    expect(within(screen.getByRole('region',{name:'Видео камеры'})).getByRole('button',{name:'Режим приватности'})).toHaveAttribute('aria-pressed','false');
    await waitFor(()=>expect(within(image).getByRole('combobox',{name:'Ночное видение'})).toHaveDisplayValue('Авто'));
    expect(within(screen.getByRole('region',{name:'Обнаружение и оповещения'})).getByRole('switch',{name:'Обнаружение движения'})).toBeChecked();
    const storage=screen.getByRole('region',{name:'Запись и карта памяти'});
    expect(within(storage).getByRole('combobox',{name:'Режим записи'})).toHaveDisplayValue('По событиям');
    expect(screen.getAllByRole('region',{name:'Состояние карты памяти'})).toHaveLength(1);
    expect(within(storage).queryByRole('switch',{name:'Форматирование карты памяти'})).toBeNull();
    expect(screen.queryByRole('switch',{name:'Обнаружение человека'})).toBeNull();
    expect(screen.queryByText('Эффекты и дополнительные параметры')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.every(([,options])=>options?.method!=='POST')).toBe(true);
    const user=userEvent.setup();
    await user.click(screen.getByText('Дополнительные параметры камеры',{exact:true}));
    expect(screen.getByRole('switch',{name:'vendor setting'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'Форматировать…'})).toBeEnabled();
    await user.selectOptions(within(image).getByRole('combobox',{name:'Ночное видение'}),'1');
    await user.selectOptions(within(storage).getByRole('combobox',{name:'Режим записи'}),'1');

    await waitFor(()=>expect(vi.mocked(fetch).mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(2));
    const posts=vi.mocked(fetch).mock.calls.filter(([,options])=>options?.method==='POST');
    expect(posts.every(([path])=>String(path).includes('provider=sharing'))).toBe(true);
    expect(posts.flatMap(([,options])=>JSON.parse(String(options?.body)).commands)).toEqual([{code:'basic_nightvision',value:'1'},{code:'record_mode',value:'2'}]);
  });
});
