import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { HomeApi, type LocalDevice } from './home-api';
import { LocalControl } from './components/LocalControls';
import { ControlDialog } from './components/DeviceControls';

const device:LocalDevice={id:7,device_id:'local-lamp',name:'Lamp',aliases:[],building_id:null,room_id:null,parent_id:null,cid:null,transport:'wifi',enabled:true,capabilities:{
  switch:{type:'boolean',readable:true,writable:true},
  color:{type:'object',encoding:'tuya_hsv',readable:true,writable:true},
}};
const json=(value:unknown)=>new Response(JSON.stringify(value));
function setup() {
  let on=false;
  const requests:{url:URL;method:string;body:unknown}[]=[];
  vi.mocked(fetch).mockImplementation(async(input,init)=>{
    const url=new URL(String(input));
    requests.push({url,method:init?.method || 'GET',body:init?.body ? JSON.parse(String(init.body)) : undefined});
    if(init?.method==='POST')return json({acknowledged:true});
    if(url.pathname.endsWith('/state'))return json({device_id:7,enabled:true,available:true,values:{switch:{known:true,stale:false,value:on},color:{known:true,stale:false,value:{h:120,s:1000,v:1000}}}});
    return json(device);
  });
  const view=render(<LocalControl api={new HomeApi({baseUrl:'http://api.test',token:'fixture-key'})} device={device} onClose={vi.fn()} onAuthError={vi.fn()}/>);
  return {view,requests,setOn:(value:boolean)=>{on=value;}};
}

it('reads the local cache once per second and renews the background watch; hidden/closed views stop reading',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  const {view,requests,setOn}=setup();
  try {
    const power=await screen.findByRole('switch');
    await waitFor(()=>expect(power).toBeEnabled());
    const states=()=>requests.filter(request=>request.url.pathname.endsWith('/state'));
    expect(states()).toHaveLength(1);
    await act(async()=>{vi.advanceTimersByTime(999);});
    expect(states()).toHaveLength(1);
    setOn(true);
    await act(async()=>{vi.advanceTimersByTime(1);});
    expect(states()).toHaveLength(2);
    expect(power).toBeChecked();
    expect(states().every(request=>request.url.searchParams.get('refresh')==='false' && request.url.searchParams.get('watch')==='true')).toBe(true);
    expect(requests.every(request=>request.method==='GET')).toBe(true);
    visibility.mockReturnValue('hidden');
    await act(async()=>{vi.advanceTimersByTime(5000);});
    expect(states()).toHaveLength(2);
    visibility.mockReturnValue('visible');
    await act(async()=>{vi.advanceTimersByTime(1000);});
    expect(states()).toHaveLength(3);
    view.unmount();
    await act(async()=>{vi.advanceTimersByTime(5000);});
    expect(states()).toHaveLength(3);
  } finally {view.unmount();visibility.mockRestore();}
});

it('edits an encoded local color and sends HSV automatically without Apply',async()=>{
  const {requests}=setup();
  const picker=await screen.findByLabelText('Выбор цвета');
  await waitFor(()=>expect(picker).toBeEnabled());
  await waitFor(()=>expect(picker).toHaveValue('#00ff00'));
  fireEvent.change(picker,{target:{value:'#0000ff'}});
  await waitFor(()=>expect(requests.filter(request=>request.method==='POST').map(request=>request.body)).toEqual([{values:{color:{h:240,s:1000,v:1000}}}]));
  expect(screen.queryByRole('button',{name:'Применить'})).toBeNull();
  expect(picker).toHaveValue('#0000ff');
});

it('isolates dialog clicks and restores page scrolling after nested details unmount',()=>{
  document.body.style.overflow='auto';
  const underlying=vi.fn();
  const view=render(<div onClick={underlying}><ControlDialog title="Outer" busy={false} onClose={vi.fn()}><ControlDialog title="Inner" busy={false} onClose={vi.fn()}><button>Inside</button></ControlDialog></ControlDialog></div>);
  fireEvent.click(screen.getByRole('heading',{name:'Inner'}));
  fireEvent.click(screen.getByRole('button',{name:'Inside'}));
  expect(underlying).not.toHaveBeenCalled();
  expect(document.body.style.overflow).toBe('hidden');
  view.unmount();
  expect(document.body.style.overflow).toBe('auto');
  document.body.style.overflow='';
});
