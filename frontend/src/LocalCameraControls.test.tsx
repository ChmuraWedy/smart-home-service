import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, vi, expect } from 'vitest';
import { CameraServiceApi } from './camera-service-api';
import LocalCameraControls from './components/LocalCameraControls';
import { MSG, t } from './i18n';

const state = { transport:'local', observed_at:1700000000, confirmed:null, state:{basic_private:false, basic_nightvision:'0'}, functions:{
  basic_private:{dp_id:105,type:'Boolean',values:{}}, basic_nightvision:{dp_id:108,type:'Enum',values:{range:['0','1','2']}},
  ptz_control:{dp_id:119,type:'Enum',values:{range:['0','2','4','6']}}, ptz_stop:{dp_id:116,type:'Boolean',values:{}},
} };

describe('local camera controls', () => {
  it('uses LAN endpoints and bounded movement without cloud discovery', async () => {
    const calls:{path:string;body:unknown}[]=[];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      calls.push({path:new URL(String(input)).pathname,body:init?.body ? JSON.parse(String(init.body)) : null});
      return new Response(JSON.stringify(state));
    });
    const user=userEvent.setup();
    render(<LocalCameraControls api={new CameraServiceApi({baseUrl:'http://api.test',token:'test'})} cameraId="camera-id" onAuthError={vi.fn()} />);
    await user.click(screen.getByText(t(MSG.CAMERA_LOCAL_CONTROLS)));
    await user.selectOptions(await screen.findByLabelText(t(MSG.NIGHT_VISION)), '2');
    await waitFor(() => expect(calls[1]).toEqual({path:'/api/v1/cameras/camera-id/controls/commands',body:{code:'basic_nightvision',value:'2'}}));
    await user.click(screen.getByRole('button',{name:t(MSG.CAMERA_MOVE_UP)}));
    await waitFor(() => expect(calls[2]).toEqual({path:'/api/v1/cameras/camera-id/controls/move',body:{direction:'up'}}));
    expect(calls.every(call=>!call.path.includes('/cloud/'))).toBe(true);
  });
});
