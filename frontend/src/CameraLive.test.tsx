import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { CameraLive } from './components/CameraLive';
import { CloudControl } from './components/CloudControl';
import { ControlCenter } from './components/ControlCenter';
import { HomeApi } from './home-api';

const hls = vi.hoisted(() => ({ destroy:vi.fn(), load:vi.fn(), attach:vi.fn(), handlers:{} as Record<string, (...args:any[])=>void>, supported:true }));
vi.mock('hls.js', () => ({default:class {
  static Events = {ERROR:'error',MANIFEST_PARSED:'manifest'};
  static isSupported() { return hls.supported; }
  destroy = hls.destroy; loadSource = hls.load; attachMedia = hls.attach;
  on(event:string, handler:(...args:any[])=>void) { hls.handlers[event]=handler; }
}}));
const connection={baseUrl:'http://api.test',token:'private-test-key'};
const url='https://video.example.test/live.m3u8?sign=temporary';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function mount(provider:'sharing'|'developer'='sharing',onAuthError=vi.fn()) {
  return render(<CameraLive api={new CloudApi(connection)} deviceId="camera" provider={provider} onAuthError={onAuthError} />);
}
function mountTiles() {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const path=new URL(String(input)).pathname;
    if (path.endsWith('/stream')) return json({device_id:'camera',type:'hls',url});
    if (path.endsWith('/cloud/topology')) return json({synced_at:null,warnings:0,placements:[],job:{status:'idle',processed:0,total:0,message:null}});
    if (path.endsWith('/cloud/devices')) return json([{id:'camera',name:'Sleep Cam',category:'sp',online:true,has_local_key:false}]);
    if (path.endsWith('/functions')) return json({device_id:'camera',functions:[]});
    if (path.endsWith('/status')) return json({device_id:'camera',online:true,source:'cloud',status:{}});
    return json([]);
  });
  return render(<ControlCenter api={new HomeApi(connection)} ready sharingReady developerReady onAuthError={vi.fn()} onLock={vi.fn()} />);
}
beforeEach(()=>{
  hls.supported=true; hls.handlers={};
  vi.spyOn(HTMLMediaElement.prototype,'canPlayType').mockReturnValue('');
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
  vi.mocked(fetch).mockResolvedValue(json({device_id:'camera',type:'hls',url}));
});

describe('camera live viewing',()=>{
  it('expands a main tile into live video without opening details and destroys the player on collapse',async()=>{
    mountTiles(); const user=userEvent.setup();
    const card=await screen.findByRole('listitem',{name:'Sleep Cam'});
    expect(hls.attach).not.toHaveBeenCalled();
    await user.click(within(card).getByRole('button',{name:'Показать видео камеры'}));
    await waitFor(()=>expect(hls.load).toHaveBeenCalledWith(url));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card.querySelector('.camera-live-compact')).toBeInTheDocument();
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
});
