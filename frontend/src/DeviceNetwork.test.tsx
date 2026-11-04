import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ApiError, CloudApi } from './api';
import type { NetworkObservation } from './api';
import { DeviceNetwork } from './components/DeviceNetwork';

const observation:NetworkObservation={
  device_id:'child',target_id:'gateway',route:'gateway',configured_ip:'192.168.1.10',observed_ip:'192.168.1.20',version:'3.5',
  last_seen:'2026-11-04T15:00:00Z',packets:1,enabled:true,listening:true,ports:[6666,6667,7000],failed_ports:[],changes:[],
};
function expand(open=true) {
  const details=screen.getByText('Устройство в домашней сети').closest('details')!;
  details.open=open; fireEvent(details,new Event('toggle'));
}

it('reads shared cached announcements without start/stop actions, then stops reads when closed',async()=>{
  const api=new CloudApi({baseUrl:'http://api.test',token:'fixture-key'});
  const read=vi.spyOn(api,'deviceNetworkObservation').mockResolvedValue(observation);
  const start=vi.spyOn(api,'startNetworkWatch'),stop=vi.spyOn(api,'stopNetworkWatch'),command=vi.spyOn(api,'sendDeviceCommands');
  const view=render(<DeviceNetwork api={api} deviceId="child" provider="local" onAuthError={vi.fn()}/>);
  expect(read).not.toHaveBeenCalled();
  vi.useFakeTimers();
  await act(async()=>expand());
  expect(screen.getByText('192.168.1.20')).toBeInTheDocument();
  expect(read).toHaveBeenCalledWith('child','local',expect.any(AbortSignal));
  expect(screen.queryByRole('button')).toBeNull();
  read.mockResolvedValue({...observation,observed_ip:'192.168.1.30',packets:2,changes:[{at:'2026-11-04T15:01:00Z',previous_ip:'192.168.1.20',ip:'192.168.1.30'}]});
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(screen.getByText(/192.168.1.20 → 192.168.1.30/)).toBeInTheDocument();
  expand(false);
  const count=read.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
  expect(read).toHaveBeenCalledTimes(count);
  view.unmount();
  expect(start).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();expect(command).not.toHaveBeenCalled();
});

it('explains unknown gateways and handles authentication failures without creating watches',async()=>{
  const api=new CloudApi({baseUrl:'http://api.test',token:'fixture-key'}),auth=vi.fn();
  const read=vi.spyOn(api,'deviceNetworkObservation').mockRejectedValueOnce(new ApiError('Unknown gateway',409)).mockRejectedValueOnce(new ApiError('Access denied',401));
  render(<DeviceNetwork api={api} deviceId="child" provider="sharing" onAuthError={auth}/>);
  expand();
  expect(await screen.findByRole('alert')).toHaveTextContent('Шлюз этого устройства пока неизвестен');
  expect(screen.queryByText('Обнаруженный IP')).toBeNull();
  expand(false);expand();
  await waitFor(()=>expect(auth).toHaveBeenCalledOnce());
  expect(read).toHaveBeenCalledTimes(2);
});
