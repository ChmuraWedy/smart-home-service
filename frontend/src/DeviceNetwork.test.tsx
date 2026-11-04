import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, CloudApi } from './api';
import type { NetworkWatch } from './api';
import { DeviceNetwork } from './components/DeviceNetwork';

const connection = { baseUrl: 'http://api.test', token: 'key' };
const observation: NetworkWatch = {
  watch_id: 'watch', device_id: 'child', target_id: 'gateway', route: 'gateway',
  configured_ip: '192.168.1.10', observed_ip: null, version: null, last_seen: null,
  packets: 0, listening: true, ports: [6666, 6667, 7000], failed_ports: [],
  remaining_seconds: 899, changes: [],
};
afterEach(() => vi.useRealTimers());

it('starts only on request, shows gateway IP changes and stops on card close without device commands', async () => {
  const api = new CloudApi(connection);
  const start = vi.spyOn(api, 'startNetworkWatch').mockResolvedValue(observation);
  const poll = vi.spyOn(api, 'networkWatch').mockResolvedValue({ ...observation, observed_ip: '192.168.1.30', packets: 2,
    last_seen: '2026-10-09T20:00:00Z', changes: [
      { at: '2026-10-09T19:00:00Z', previous_ip: null, ip: '192.168.1.20' },
      { at: '2026-10-09T20:00:00Z', previous_ip: '192.168.1.20', ip: '192.168.1.30' },
    ] });
  const stop = vi.spyOn(api, 'stopNetworkWatch').mockResolvedValue();
  const command = vi.spyOn(api, 'sendDeviceCommands');
  const view = render(<DeviceNetwork api={api} deviceId="child" provider="sharing" onAuthError={vi.fn()} />);
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Устройство в домашней сети'));
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Наблюдать в сети' })); });
  expect(screen.getByText('Шлюз устройства', { exact: false })).toBeInTheDocument();
  expect(start).toHaveBeenCalledWith('child', 'sharing', expect.any(AbortSignal));
  expect(screen.getByText('Объявлений пока нет')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(poll).toHaveBeenCalledOnce();
  expect(screen.getByText('Обнаруженный IP отличается от сохранённого в настройках.')).toBeInTheDocument();
  expect(screen.getByText(/192.168.1.20 → 192.168.1.30/)).toBeInTheDocument();
  view.unmount();
  expect(stop).toHaveBeenCalledWith('watch');
  expect(command).not.toHaveBeenCalled();
});

it('explains an unknown gateway without inventing an address and handles authentication failures', async () => {
  const api = new CloudApi(connection), onAuthError = vi.fn();
  vi.spyOn(api, 'startNetworkWatch').mockRejectedValueOnce(new ApiError('Gateway unknown', 409)).mockRejectedValueOnce(new ApiError('Access denied', 401));
  render(<DeviceNetwork api={api} deviceId="child" provider="sharing" onAuthError={onAuthError} />);
  fireEvent.click(screen.getByText('Устройство в домашней сети'));
  fireEvent.click(screen.getByRole('button', { name: 'Наблюдать в сети' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Шлюз этого устройства пока неизвестен');
  expect(screen.queryByText('Обнаруженный IP')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Наблюдать в сети' }));
  await waitFor(() => expect(onAuthError).toHaveBeenCalledOnce());
});
