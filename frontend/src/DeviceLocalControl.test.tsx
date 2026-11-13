import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import DeviceLocalControl from './components/DeviceLocalControl';
import { MSG, t } from './i18n';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const status={host:'192.168.40.50',control:'remote',local_available:true,internet:{available:true,blocked:false,verified:true}};

describe('shared local control section',()=>{
  it('switches through the supplied local device route and blocks/restores a non-camera device',async()=>{
    const writes:unknown[]=[];
    vi.mocked(fetch).mockImplementation(async(input,init)=>{
      expect(String(input)).toContain('/device-access/sharing/lamp');
      if(init?.method==='PUT'){
        const body=JSON.parse(String(init.body));writes.push(body);
        return json({...status.internet,blocked:body.blocked});
      }
      return json(status);
    });
    const activate=vi.fn(async()=>{});
    render(<DeviceLocalControl api={new CloudApi({baseUrl:'http://api.test',token:'key'})} deviceId="lamp" route="sharing" onAuthError={vi.fn()} onUseLocal={activate} />);
    const user=userEvent.setup();
    const local=screen.getByRole('button',{name:t(MSG.DEVICE_USE_LOCAL)});
    await waitFor(()=>expect(local).toBeEnabled());
    await user.click(local);expect(activate).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button',{name:t(MSG.DEVICE_BLOCK_INTERNET)}));
    expect(await screen.findByText(t(MSG.DEVICE_INTERNET_BLOCKED))).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:t(MSG.DEVICE_RESTORE_INTERNET)}));
    expect(await screen.findByText(t(MSG.DEVICE_INTERNET_ALLOWED))).toBeInTheDocument();
    expect(writes).toEqual([{blocked:true},{blocked:false}]);
  });

  it('does not change the displayed policy after a failed firewall operation',async()=>{
    vi.mocked(fetch).mockImplementation(async(_input,init)=>init?.method==='PUT'?json({detail:'Policy unavailable'},503):json(status));
    render(<DeviceLocalControl api={new CloudApi({baseUrl:'http://api.test',token:'key'})} deviceId="lamp" route="local" onAuthError={vi.fn()} />);
    const block=screen.getByRole('button',{name:t(MSG.DEVICE_BLOCK_INTERNET)});
    await waitFor(()=>expect(block).toBeEnabled());
    await userEvent.setup().click(block);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByText(t(MSG.DEVICE_INTERNET_ALLOWED))).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:t(MSG.DEVICE_RESTORE_INTERNET)})).toBeNull();
  });

  it('keeps unknown gateway policy distinct from allowed and disallows unsupported local switching',async()=>{
    vi.mocked(fetch).mockResolvedValue(json({...status,local_available:false,internet:{available:false,blocked:null,verified:false}}));
    render(<DeviceLocalControl api={new CloudApi({baseUrl:'http://api.test',token:'key'})} deviceId="child" route="sharing" onAuthError={vi.fn()} />);
    expect(await screen.findByText(t(MSG.DEVICE_INTERNET_UNKNOWN))).toBeInTheDocument();
    expect(screen.getByRole('button',{name:t(MSG.DEVICE_USE_LOCAL)})).toBeDisabled();
    expect(screen.getByRole('button',{name:t(MSG.DEVICE_BLOCK_INTERNET)})).toBeDisabled();
  });
});
