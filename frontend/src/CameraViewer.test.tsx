import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import CameraViewer from './components/CameraViewer';
import { connectCameraWebRTC } from './camera-stream';
import { MSG, t } from './i18n';

vi.mock('./camera-stream', async importOriginal => ({
  ...await importOriginal<typeof import('./camera-stream')>(),
  connectCameraWebRTC:vi.fn(()=>vi.fn()),
}));

const row={id:'lan-camera',name:'TRACER FOCUS 3',host:'192.168.1.20',device_id:'tracer',connected:true,controls_available:true};
const state={transport:'local',observed_at:1700000000,confirmed:true,state:{basic_private:false},functions:{
  basic_private:{dp_id:105,type:'Boolean',values:{}},
  ptz_control:{dp_id:119,type:'Enum',values:{range:['0','2','4','6']}},
  ptz_stop:{dp_id:116,type:'Boolean',values:{}},
}};
const json=(value:unknown)=>new Response(JSON.stringify(value));

beforeEach(()=>{
  vi.mocked(connectCameraWebRTC).mockClear();
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
});

describe('camera details with local controls',()=>{
  it('matches by device ID and moves without reconnecting or replacing the video',async()=>{
    const calls:{path:string;method:string;body:unknown}[]=[];
    vi.mocked(fetch).mockImplementation(async(input,init)=>{
      const path=new URL(String(input)).pathname;
      calls.push({path,method:init?.method||'GET',body:init?.body?JSON.parse(String(init.body)):null});
      if(path.endsWith('/cameras'))return json([{...row,id:'wrong',device_id:'other'},row]);
      if(path.endsWith('/stream/relay'))return json({device_id:'tracer',type:'webrtc',url:'http://media.test/play/native/'+'a'.repeat(43)+'/ws'});
      return json(state);
    });
    render(<CameraViewer api={new CloudApi({baseUrl:'http://api.test',token:'key'})} deviceId="tracer" provider="sharing" onAuthError={vi.fn()} autoStart compact />);
    const up=await screen.findByRole('button',{name:t(MSG.CAMERA_MOVE_UP)});
    await waitFor(()=>expect(connectCameraWebRTC).toHaveBeenCalledOnce());
    const video=screen.getByLabelText(t(MSG.LIVE_CAMERA_VIDEO));
    await userEvent.setup().click(up);
    await waitFor(()=>expect(calls.some(c=>c.path==='/api/v1/cameras/lan-camera/controls/move'&&JSON.stringify(c.body)==='{"direction":"up"}')).toBe(true));
    expect(screen.getByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBe(video);
    expect(connectCameraWebRTC).toHaveBeenCalledOnce();
    expect(calls.filter(c=>c.path.endsWith('/stream/relay'))).toHaveLength(1);
    expect(calls.every(c=>!c.path.includes('/wrong/'))).toBe(true);
  });

  it('waits for LAN privacy and removes the player when local privacy is enabled',async()=>{
    let privateMode=true;
    const requests:string[]=[];
    vi.mocked(fetch).mockImplementation(async(input,init)=>{
      const path=new URL(String(input)).pathname;requests.push(path);
      if(path.endsWith('/commands'))privateMode=JSON.parse(String(init?.body)).value;
      if(path.endsWith('/stream/relay'))return json({device_id:'tracer',type:'webrtc',url:'http://media.test/play/native/'+'a'.repeat(43)+'/ws'});
      return json({...state,state:{basic_private:privateMode}});
    });
    render(<CameraViewer api={new CloudApi({baseUrl:'http://api.test',token:'key'})} localCamera={row} deviceId="tracer" provider="sharing" onAuthError={vi.fn()} autoStart compact />);
    const privacy=await screen.findByLabelText(t(MSG.PRIVACY_MODE));
    expect(screen.queryByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBeNull();
    expect(requests.some(p=>p.endsWith('/stream/relay'))).toBe(false);
    const user=userEvent.setup();
    await user.click(privacy);
    await waitFor(()=>expect(screen.getByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBeInTheDocument());
    await user.click(privacy);
    await waitFor(()=>expect(screen.queryByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBeNull());
  });

  it('does not request the owner camera registry for household members',async()=>{
    render(<CameraViewer api={new CloudApi({baseUrl:'http://api.test',token:'key'},{id:'member',name:'Member',login:'member',role:'member'})} deviceId="tracer" provider="sharing" onAuthError={vi.fn()} />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(t(MSG.CAMERA_LOCAL_CONTROLS))).toBeNull();
  });
});

it('keeps existing playback and privacy behavior when no LAN binding exists',async()=>{
  vi.mocked(fetch).mockResolvedValue(json([]));
  render(<CameraViewer api={new CloudApi({baseUrl:'http://api.test',token:'key'})} deviceId="unbound" provider="sharing" onAuthError={vi.fn()} viewingBlocked={t(MSG.PRIVACY_MODE_IS_ON)} />);
  await waitFor(()=>expect(fetch).toHaveBeenCalledOnce());
  expect(screen.queryByText(t(MSG.CAMERA_LOCAL_CONTROLS))).toBeNull();
  await waitFor(()=>expect(screen.getByRole('button',{name:t(MSG.WATCH_VIDEO)})).toHaveAttribute('title',t(MSG.PRIVACY_MODE_IS_ON)));
  expect(screen.getByRole('button',{name:t(MSG.WATCH_VIDEO)})).toBeDisabled();
});
