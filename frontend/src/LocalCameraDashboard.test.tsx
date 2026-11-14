import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HomeApi } from './home-api';
import { ControlCenter } from './components/ControlCenter';
import { renderWithStore } from './test/render-with-store';
import { MSG, t } from './i18n';

vi.mock('./camera-stream',async importOriginal=>({
  ...await importOriginal<typeof import('./camera-stream')>(),
  connectCameraWebRTC:vi.fn(()=>vi.fn()),
}));
const json=(value:unknown)=>new Response(JSON.stringify(value));
const camera={id:'lan-tracer',device_id:'physical-camera',name:'TRACER FOCUS 3',host:'192.168.1.20',connected:true,controls_available:true};
const state={transport:'local',observed_at:Date.now()/1000,confirmed:true,state:{basic_private:false},functions:{
  basic_private:{dp_id:105,type:'Boolean',values:{}},ptz_control:{dp_id:119,type:'Enum',values:{range:['0','2','4','6']}},ptz_stop:{dp_id:116,type:'Boolean',values:{}},
}};
function backend(cloud=false) {
  const requests:{path:string;method:string;body:unknown}[]=[];
  vi.mocked(fetch).mockImplementation(async(input,init)=>{
    const path=new URL(String(input)).pathname;
    requests.push({path,method:init?.method||'GET',body:init?.body?JSON.parse(String(init.body)):null});
    if(path==='/api/v1/cameras')return json([camera]);
    if(path==='/api/v1/cameras/status')return json({cameras:[{...camera,lan:{online:true,checked_at:Date.now()/1000,controls:state}}]});
    if(path.includes('/controls'))return json(state);
    if(path.endsWith('/playback'))return json({device_id:'local-camera:lan-tracer',type:'webrtc',url:'http://media.test/play/native/'+'a'.repeat(43)+'/ws'});
    if(path==='/api/v1/cloud/devices')return json(cloud?[{id:camera.device_id,name:camera.name,category:'sp',online:true,has_local_key:false}]:[]);
    if(path.endsWith('/topology'))return json({placements:[],job:{status:'idle'}});
    if(path.includes('/dashboard-layouts/'))return json({slots:[]});
    return json([]);
  });
  return requests;
}

describe('native cameras on the dashboard',()=>{
  it('shows and opens a local camera with Smart Life disabled and no local-device record',async()=>{
    const requests=backend();
    vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
    vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
    renderWithStore(<ControlCenter api={new HomeApi({baseUrl:'http://api.test',token:'key'})} ready onAuthError={vi.fn()} />);
    const card=await screen.findByRole('listitem',{name:camera.name});
    expect(requests.some(r=>r.path==='/api/v1/cloud/devices')).toBe(false);
    expect(requests.some(r=>r.method==='POST')).toBe(false);
    const user=userEvent.setup();
    await user.click(within(card).getByRole('button',{name:camera.name}));
    const dialog=await screen.findByRole('dialog',{name:camera.name});
    await within(dialog).findByLabelText(t(MSG.LIVE_CAMERA_VIDEO));
    const up=await within(dialog).findByRole('button',{name:t(MSG.CAMERA_MOVE_UP)});
    await user.click(up);
    await waitFor(()=>expect(requests.some(r=>r.path==='/api/v1/cameras/lan-tracer/controls/move')).toBe(true));
    await waitFor(()=>expect(requests.some(r=>r.path==='/api/v1/cameras/lan-tracer/playback')).toBe(true));
    await user.click(within(dialog).getByRole('button',{name:t(MSG.CLOSE)}));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:camera.name})).toBeNull());
  });

  it('finds native cameras through the dashboard search',async()=>{
    backend();
    renderWithStore(<ControlCenter api={new HomeApi({baseUrl:'http://api.test',token:'key'})} ready dashboardPanel="tools" onAuthError={vi.fn()} />);
    await screen.findByRole('listitem',{name:camera.name});
    const user=userEvent.setup();
    const search=screen.getByPlaceholderText(t(MSG.FIND_A_DEVICE_OR_GROUP));
    await user.type(search,'tra');
    expect(screen.getByRole('listitem',{name:camera.name})).toBeInTheDocument();
    await user.clear(search);await user.type(search,'not-a-camera');
    await waitFor(()=>expect(screen.queryByRole('listitem',{name:camera.name})).toBeNull());
  });

  it('does not duplicate the camera already present in Smart Life',async()=>{
    backend(true);
    renderWithStore(<ControlCenter api={new HomeApi({baseUrl:'http://api.test',token:'key'})} ready sharingReady onAuthError={vi.fn()} />);
    await screen.findByRole('listitem',{name:camera.name});
    await waitFor(()=>expect(screen.getAllByRole('listitem',{name:camera.name})).toHaveLength(1));
    expect(document.querySelector('.local-camera-card')).toBeNull();
  });

  it('does not fetch owner camera inventory for a household member',async()=>{
    const requests=backend();
    renderWithStore(<ControlCenter api={new HomeApi({baseUrl:'http://api.test',token:'key'},{id:'member',name:'Member',login:'member',role:'member'})} ready onAuthError={vi.fn()} />);
    await waitFor(()=>expect(requests.some(r=>r.path==='/api/v1/devices')).toBe(true));
    expect(requests.some(r=>r.path==='/api/v1/cameras')).toBe(false);
  });
});
