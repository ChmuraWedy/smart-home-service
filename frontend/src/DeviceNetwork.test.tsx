import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ApiError, CloudApi } from './api';
import type { NetworkObservation } from './api';
import { DeviceNetwork } from './components/DeviceNetwork';
import DeviceInformation from './components/DeviceInformation';
import type { LocalDevice } from './home-api';
import { setLocale } from './i18n';

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

it('combines device identity, routes, and saved and observed gateway addresses', async () => {
  setLocale('en', false);
  const api = new CloudApi({ baseUrl: 'http://api.test', token: 'fixture-key' });
  const read = vi.spyOn(api, 'deviceNetworkObservation').mockResolvedValue(observation);
  const local: LocalDevice = { id: 2, device_id: 'child', name: 'Hall light', aliases: [],
    building_id: null, room_id: null, transport: 'zigbee', parent_id: 1, cid: 'node-17', enabled: true, capabilities: {} };
  const gateway: LocalDevice = { ...local, id: 1, device_id: 'gateway', name: 'Hall bridge', transport: 'wifi',
    parent_id: null, cid: null, ip: '192.168.1.10', mac: '00:11:22:33:44:55', version: '3.5' };
  const cloud = { id: 'child', name: 'Cloud light', online: true, sub: true, has_local_key: true, product_id: 'product-1' };
  render(<DeviceInformation api={api} deviceId="child" displayName={local.name} route="sharing"
    routes={['sharing', 'local']} local={local} cloud={cloud} gateway={gateway} onAuthError={vi.fn()} />);
  const details = screen.getByText('Device properties').closest('details')!;
  expect(read).not.toHaveBeenCalled();
  details.open = true;
  fireEvent(details, new Event('toggle'));
  const facts = within(details);
  const entry = (label: string) => facts.getByText(label, { selector: 'dt' }).nextElementSibling;
  expect(entry('Name')).toHaveTextContent('Hall light');
  expect(entry('Tuya name')).toHaveTextContent('Cloud light');
  expect(entry('Device ID')).toHaveTextContent('child');
  expect(entry('Gateway')).toHaveTextContent('Hall bridge');
  expect(entry('Gateway device ID')).toHaveTextContent('gateway');
  expect(entry('Configured gateway IP')).toHaveTextContent('192.168.1.10');
  expect(entry('Gateway MAC address')).toHaveTextContent('00:11:22:33:44:55');
  expect(entry('MAC address')).toHaveTextContent('Not set');
  expect(entry('Available control routes')).toHaveTextContent('Smart Life');
  expect(entry('Available control routes')).toHaveTextContent('home network');
  await facts.findByText('192.168.1.20');
  expect(entry('Observed gateway IP')).toHaveTextContent('192.168.1.20');
});
