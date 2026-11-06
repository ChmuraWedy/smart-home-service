import { screen } from '@testing-library/react';
import { renderWithStore } from './test/render-with-store';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ApiError, CloudApi } from './api';
import { DeviceAliases } from './components/DeviceAliases';
import { deviceAliases, matchesDevice, mergeDevices } from './devices';

const connection = { baseUrl: 'http://api.test', token: 'key' };

it('adds, edits and removes inline tags, keeping the real device name and commands unchanged', async () => {
  const api = new CloudApi(connection), user = userEvent.setup();
  let aliases: string[] = [];
  const save = vi.spyOn(api, 'saveDeviceAliases').mockImplementation(async (_id, _provider, values) => {
    aliases = [...values]; return { device_id: 'lamp', aliases };
  });
  const command = vi.spyOn(api, 'sendDeviceCommands');
  const props = { api, deviceId: 'lamp', name: 'Original lamp', provider: 'sharing' as const,
    disabled: false, onBusy: vi.fn(), onAuthError: vi.fn() };
  const view = renderWithStore(<DeviceAliases {...props} />);
  await user.click(screen.getByRole('button', { name: 'Добавить алиас' }));
  await user.type(screen.getByLabelText('Новый алиас'), 'Свет кухни');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  await screen.findByRole('button', { name: 'Изменить алиас Свет кухни' });
  expect(save).toHaveBeenCalledWith('lamp', 'sharing', ['Свет кухни'], expect.any(AbortSignal));
  expect(screen.getByRole('heading', { name: 'Original lamp' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Алиасы' })).toHaveTextContent('Свет кухни');
  expect(screen.getByText('Алиасы:')).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Изменить алиас Свет кухни' }));
  await user.clear(screen.getByLabelText('Изменить алиас'));
  await user.type(screen.getByLabelText('Изменить алиас'), 'Святло пакоя');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  await screen.findByRole('button', { name: 'Изменить алиас Святло пакоя' });
  expect(aliases).toEqual(['Святло пакоя']);
  view.unmount(); renderWithStore(<DeviceAliases {...props} initialAliases={aliases} />);
  await user.click(screen.getByRole('button', { name: 'Изменить алиас Святло пакоя' }));
  await user.click(screen.getByRole('button', { name: 'Удалить' }));
  await screen.findByRole('button', { name: 'Добавить алиас' });
  expect(aliases).toEqual([]);
  expect(command).not.toHaveBeenCalled();
});

it('reuses inventory aliases, supports Polish and keeps the automatic name out of editable tags', async () => {
  const api = new CloudApi(connection), user = userEvent.setup();
  const save = vi.spyOn(api, 'saveLocalDeviceAliases').mockImplementation(async (_id, aliases) => ({ device_id: 'lamp', aliases: ['Kitchen lamp', ...aliases] }));
  const cloudSave = vi.spyOn(api, 'saveDeviceAliases');
  renderWithStore(<DeviceAliases api={api} deviceId="lamp" name="Kitchen lamp" localId={7} initialAliases={['Kitchen lamp', 'existing_alias']} disabled={false} onBusy={vi.fn()} onAuthError={vi.fn()} />);
  expect(screen.getByRole('group', { name: 'Алиасы' })).toHaveTextContent('existing_alias');
  expect(screen.queryByRole('button', { name: 'Изменить алиас Kitchen lamp' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Добавить алиас' }));
  await user.type(screen.getByLabelText('Новый алиас'), 'Światło pokoju');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  await screen.findByRole('button', { name: 'Изменить алиас Światło pokoju' });
  expect(save).toHaveBeenCalledWith(7, ['existing_alias', 'Światło pokoju'], expect.any(AbortSignal));
  expect(cloudSave).not.toHaveBeenCalled();
});

it('keeps saved tags and the draft on conflict, and cancels inline creation with Escape', async () => {
  const api = new CloudApi(connection), user = userEvent.setup();
  vi.spyOn(api, 'saveDeviceAliases').mockRejectedValue(new ApiError('Conflict', 409));
  renderWithStore(<DeviceAliases api={api} deviceId="lamp" name="Original lamp" initialAliases={['saved_alias']} provider="sharing" disabled={false} onBusy={vi.fn()} onAuthError={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Добавить алиас' }));
  await user.type(screen.getByLabelText('Новый алиас'), 'taken_alias');
  await user.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('уже используется другим устройством');
  expect(screen.getByRole('button', { name: 'Изменить алиас saved_alias' })).toBeInTheDocument();
  expect(screen.getByLabelText('Новый алиас')).toHaveValue('taken_alias');
  await user.click(screen.getByLabelText('Новый алиас')); await user.keyboard('{Escape}');
  expect(screen.queryByLabelText('Новый алиас')).not.toBeInTheDocument();
  const merged = mergeDevices([], { sharing: [{ id: 'lamp', name: 'Original lamp', online: true, has_local_key: false, aliases: ['saved_alias'] }] });
  expect(deviceAliases(merged[0])).toEqual(['saved_alias']);
  expect(matchesDevice(merged[0], 'SAVED_ALIAS')).toBe(true);
});
