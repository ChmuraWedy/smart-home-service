import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HomeApi } from './home-api';
import { CardControls } from './components/CardControls';
import CameraViewer from './components/CameraViewer';
import { renderWithStore } from './test/render-with-store';
import { cameraScope, cameraStatusCache, localCameraOnline, retainCameraClient } from './camera-status-cache';
import { createAppStore } from './store';
import { MSG, t } from './i18n';

const api = () => new HomeApi({ baseUrl:'http://api.test', token:'test-key' });
const row = { id:'lan-camera', device_id:'tracer', name:'TRACER FOCUS 3', host:'192.168.1.20', connected:true, controls_available:true };
const controls = (privateMode = false) => ({ transport:'local' as const, observed_at:Date.now()/1000, confirmed:true,
  state:{basic_private:privateMode,motion_switch:false},functions:{
    basic_private:{dp_id:105,type:'Boolean' as const,values:{}}, motion_switch:{dp_id:134,type:'Boolean' as const,values:{}},
  },
});
const status = () => ({ cameras:[{...row,lan:{online:true,checked_at:Date.now()/1000,controls:controls()}}] });
const json = (value:unknown) => new Response(JSON.stringify(value));

describe('shared authenticated LAN camera status', () => {
  it('uses fresh LAN state and commands when Smart Life reports offline, and opens a frame without a parent sheet', async () => {
    const writes:{path:string;body:unknown}[]=[];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path=new URL(String(input)).pathname;
      if (path.endsWith('/cameras/status')) return json(status());
      if (init?.method === 'POST') { writes.push({path,body:JSON.parse(String(init.body))}); return json(controls(true)); }
      return json([]);
    });
    const onOpen=vi.fn(), onStatus=vi.fn();
    const device={id:'tracer',name:row.name,cloud:{sharing:{id:'tracer',name:row.name,category:'sp',online:false,has_local_key:false,
      controls:{ready:true,definitions:{device_id:'tracer',functions:[{code:'basic_private',type:'Boolean',values:{}}]},
        snapshot:{device_id:'tracer',online:false,source:'cloud',status:{basic_private:true}}},
    }}};
    renderWithStore(<CardControls api={api()} device={device} route="sharing" now={Date.now()} paused={false}
      onAuthError={vi.fn()} onBusy={vi.fn()} onStatus={onStatus} onOpenQuick={onOpen} />);
    const privacy=await screen.findByRole('button',{name:t(MSG.PRIVACY)});
    await waitFor(()=>expect(privacy).toBeEnabled());
    expect(privacy).toHaveAttribute('aria-pressed','false');
    expect(privacy).toHaveAttribute('data-slot','power-button');
    expect(privacy.closest('.camera-quick-actions')).toBe(screen.getByRole('switch',{name:t(MSG.MOTION)}).closest('.camera-quick-actions'));
    expect(Array.from(privacy.closest('.camera-quick-actions')?.querySelectorAll('button.dashboard-power-button') ?? []).map(button=>button.textContent)).toEqual(['','']);
    expect(privacy.closest('.camera-quick-actions')?.querySelectorAll('button.dashboard-power-button')).toHaveLength(2);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({online:true,transport:'local'}));
    const user=userEvent.setup();
    await user.click(screen.getByRole('button',{name:t(MSG.CAMERA_OPEN_FRAME)}));
    expect(onOpen).toHaveBeenCalledOnce();
    await user.click(privacy);
    await waitFor(()=>expect(writes).toEqual([{path:'/api/v1/cameras/lan-camera/controls/commands',body:{code:'basic_private',value:true}}]));
    expect(screen.queryByText(t(MSG.LOCAL_CONTROL))).toBeNull();
  });

  it('does not show connection management in dashboard playback or quick details', async () => {
    vi.mocked(fetch).mockResolvedValue(json(status()));
    renderWithStore(<CameraViewer api={api()} deviceId="tracer" provider="sharing" onAuthError={vi.fn()} extended={false} />);
    await waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByText(t(MSG.LOCAL_CONTROL))).toBeNull();
    expect(screen.queryByRole('button',{name:t(MSG.DEVICE_BLOCK_INTERNET)})).toBeNull();
    expect(screen.queryByLabelText(t(MSG.PRIVACY_MODE))).toBeNull();
  });

  it('shares one five-second batch poll between subscribers and retains a newer command reading', async () => {
    vi.useFakeTimers();
    const client=api(), store=createAppStore(), release=retainCameraClient(client), scope=cameraScope(client);
    const read=vi.spyOn(client,'localCameraStatus').mockImplementation(async()=>status());
    const first=store.dispatch(cameraStatusCache.endpoints.cameras.initiate(scope,{subscriptionOptions:{pollingInterval:5000}}));
    const second=store.dispatch(cameraStatusCache.endpoints.cameras.initiate(scope,{subscriptionOptions:{pollingInterval:5000}}));
    try {
      await first; await second;
      expect(read).toHaveBeenCalledOnce();
      const newer=Date.now()/1000+10;
      store.dispatch(cameraStatusCache.util.updateQueryData('cameras',scope,(value)=>{value.cameras[0].lan={online:true,checked_at:newer,controls:{...controls(true),observed_at:newer}};}));
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(read).toHaveBeenCalledTimes(2);
      expect(cameraStatusCache.endpoints.cameras.select(scope)(store.getState()).data?.cameras[0].lan.controls?.state.basic_private).toBe(true);
    } finally {first.unsubscribe();second.unsubscribe();release();store.dispatch(cameraStatusCache.util.resetApiState());}
  });

  it('does not treat discovery or expired readings as proof of availability', () => {
    expect(localCameraOnline({...row,lan:{},announcement:{observed_ip:row.host,last_seen:new Date().toISOString()}})).toBeUndefined();
    expect(localCameraOnline({...row,lan:{online:true,checked_at:Date.now()/1000-16}})).toBeUndefined();
    expect(localCameraOnline({...row,lan:{online:false,checked_at:Date.now()/1000}})).toBe(false);
  });
});
