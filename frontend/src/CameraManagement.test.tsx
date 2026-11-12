import { render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe,it,vi,expect } from 'vitest';
import { CameraServiceApi } from './camera-service-api';
import CameraManagement from './components/CameraManagement';
import { MSG,t } from './i18n';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});

describe('camera module management',()=>{
  it('discovers and connects a camera to the selected dashboard device without persisting its password',async()=>{
    let connected=false;
    const requests:{path:string;body:any}[]=[];
    vi.mocked(fetch).mockImplementation(async(input,init)=>{
      const path=new URL(String(input)).pathname;
      requests.push({path,body:init?.body ? JSON.parse(String(init.body)) : undefined});
      if(path.endsWith('/cameras/service')) return json({configured:true});
      if(path.endsWith('/cloud/devices')) return json([{id:'tracer',name:'TRACER FOCUS 3',category:'sp'}]);
      if(path.endsWith('/connection')) {connected=true;return json({connected:true});}
      return json([{id:'camera-id',name:'ONVIF camera',host:'192.168.1.20',connected}]);
    });
    render(<CameraManagement api={new CameraServiceApi({baseUrl:'http://api.test',token:'test-key'})} onAuthError={vi.fn()} />);
    const user=userEvent.setup();
    await user.click(screen.getByText(t(MSG.LOCAL_CAMERAS)));
    await user.click(await screen.findByRole('button',{name:t(MSG.DISCOVER_CAMERAS)}));
    await waitFor(()=>expect(requests.some(r=>r.path.endsWith('/discovery'))).toBe(true));
    await user.click(screen.getByRole('button',{name:t(MSG.CAMERA_CONNECT)}));
    await user.selectOptions(screen.getByLabelText(t(MSG.CAMERA_DASHBOARD_DEVICE)),'tracer');
    await user.type(screen.getByLabelText(t(MSG.CAMERA_USERNAME)),'camera-user');
    await user.type(screen.getByLabelText(t(MSG.CAMERA_PASSWORD)),'private-camera-password');
    const form=screen.getByLabelText(t(MSG.CAMERA_PASSWORD)).closest('form')!;
    await user.click(form.querySelector('button[type=submit]')!);
    await waitFor(()=>expect(requests.find(r=>r.path.endsWith('/connection'))?.body).toEqual({
      device_id:'tracer',username:'camera-user',password:'private-camera-password',transcode:true,
    }));
    await waitFor(()=>expect(screen.queryByLabelText(t(MSG.CAMERA_PASSWORD))).toBeNull());
    expect(document.body.innerHTML).not.toContain('private-camera-password');
  });

  it('shows an unconfigured module without attempting discovery',async()=>{
    vi.mocked(fetch).mockResolvedValue(json({configured:false}));
    render(<CameraManagement api={new CameraServiceApi({baseUrl:'http://api.test',token:'test-key'})} onAuthError={vi.fn()} />);
    await userEvent.setup().click(screen.getByText(t(MSG.LOCAL_CAMERAS)));
    expect(await screen.findByText(t(MSG.CAMERA_SERVICE_NOT_CONFIGURED))).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
