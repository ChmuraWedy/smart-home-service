import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ApiError, CloudApi } from './api';
import { DeviceAliases } from './components/DeviceAliases';
import { deviceAliases, matchesDevice, mergeDevices } from './devices';

const connection = { baseUrl: 'http://api.test', token: 'key' };

it('creates, restores and removes cloud alias tags without renaming or sending commands', async () => {
  const api = new CloudApi(connection), user = userEvent.setup();
  let aliases: string[] = [];
  vi.spyOn(api, 'deviceAliases').mockImplementation(async () => ({ device_id: 'lamp', aliases }));
  const save = vi.spyOn(api, 'saveDeviceAliases').mockImplementation(async (_id, _provider, values) => {
    aliases = [...values]; return { device_id: 'lamp', aliases };
  });
  const command = vi.spyOn(api, 'sendDeviceCommands');
  const props = { api, deviceId: 'lamp', name: 'Original lamp', provider: 'sharing' as const,
    disabled: false, onBusy: vi.fn(), onAuthError: vi.fn() };
  const view = render(<><h2>Original lamp</h2><DeviceAliases {...props} /></>);
  await user.click(screen.getByText('Алиасы устройства'));
  await waitFor(() => expect(screen.queryByText('Загружаем алиасы…')).not.toBeInTheDocument());
  await user.type(screen.getByLabelText('Новый алиас'), ' Desk_Light ');
  await user.click(screen.getByRole('button', { name: 'Добавить алиас' }));
  await screen.findByText('Алиас добавлен.');
  expect(save).toHaveBeenCalledWith('lamp', 'sharing', ['desk_light'], expect.any(AbortSignal));
  expect(screen.getByRole('heading', { name: 'Original lamp' })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Алиасы устройства' })).toHaveTextContent('Алиас: desk_light');
  view.unmount(); render(<DeviceAliases {...props} />);
  await user.click(screen.getByText('Алиасы устройства'));
  await screen.findByRole('button', { name: 'Удалить алиас desk_light' });
  expect(screen.getByRole('list', { name: 'Алиасы устройства' })).toHaveTextContent('desk_light');
  await user.click(screen.getByRole('button', { name: 'Удалить алиас desk_light' }));
  await screen.findByText('Алиас удалён.');
  expect(aliases).toEqual([]);
  expect(screen.queryByRole('list', { name: 'Алиасы устройства' })).not.toBeInTheDocument();
  expect(command).not.toHaveBeenCalled();
});

it('reuses inventory aliases and preserves the automatic name', async () => {
  const api = new CloudApi(connection), user = userEvent.setup();
  const save = vi.spyOn(api, 'saveLocalDeviceAliases').mockImplementation(async (_id, aliases) => ({ device_id: 'lamp', aliases: ['Kitchen lamp', ...aliases] }));
  const cloudSave = vi.spyOn(api, 'saveDeviceAliases');
  render(<DeviceAliases api={api} deviceId="lamp" name="Kitchen lamp" localId={7} initialAliases={['Kitchen lamp', 'existing_alias']} disabled={false} onBusy={vi.fn()} onAuthError={vi.fn()} />);
  expect(screen.getByRole('list', { name: 'Алиасы устройства' })).toHaveTextContent('existing_alias');
  expect(screen.queryByRole('button', { name: 'Удалить алиас Kitchen lamp' })).not.toBeInTheDocument();
  await user.click(screen.getByText('Алиасы устройства'));
  await user.type(screen.getByLabelText('Новый алиас'), 'new_alias');
  await user.click(screen.getByRole('button', { name: 'Добавить алиас' }));
  await screen.findByText('Алиас добавлен.');
  expect(save).toHaveBeenCalledWith(7, ['existing_alias', 'new_alias'], expect.any(AbortSignal));
  expect(cloudSave).not.toHaveBeenCalled();
});

it('keeps saved tags on a conflict and makes cloud aliases searchable', async () => {
  const api = new CloudApi(connection), user = userEvent.setup();
  vi.spyOn(api, 'deviceAliases').mockResolvedValue({ device_id: 'lamp', aliases: ['saved_alias'] });
  vi.spyOn(api, 'saveDeviceAliases').mockRejectedValue(new ApiError('Conflict', 409));
  render(<DeviceAliases api={api} deviceId="lamp" name="Original lamp" provider="sharing" disabled={false} onBusy={vi.fn()} onAuthError={vi.fn()} />);
  await user.click(screen.getByText('Алиасы устройства'));
  await screen.findByRole('button', { name: 'Удалить алиас saved_alias' });
  await user.type(screen.getByLabelText('Новый алиас'), 'taken_alias');
  await user.click(screen.getByRole('button', { name: 'Добавить алиас' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('уже используется другим устройством');
  expect(screen.getByRole('list', { name: 'Алиасы устройства' })).toHaveTextContent('saved_alias');
  expect(screen.getByRole('list', { name: 'Алиасы устройства' })).not.toHaveTextContent('taken_alias');
  const merged = mergeDevices([], { sharing: [{ id: 'lamp', name: 'Original lamp', online: true, has_local_key: false, aliases: ['saved_alias'] }] });
  expect(deviceAliases(merged[0])).toEqual(['saved_alias']);
  expect(matchesDevice(merged[0], 'SAVED_ALIAS')).toBe(true);
});
