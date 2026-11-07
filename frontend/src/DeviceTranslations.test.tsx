import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeApi } from './home-api';
import type { LocalDevice } from './home-api';
import { ControlCenter } from './components/ControlCenter';
import { DeviceAliases } from './components/DeviceAliases';
import DeviceTextModeSelector from './components/DeviceTextModeSelector';
import DeviceTranslationEditor from './components/DeviceTranslationEditor';
import { setDeviceTextMode } from './device-translations';
import { setLocale } from './i18n';
import { renderWithStore } from './test/render-with-store';

const api = new HomeApi({ baseUrl: 'http://api.test', token: 'key' });
const fixture: LocalDevice = {
  id: 7, device_id: 'lamp', name: 'Kitchen Lamp', aliases: ['dinner light'], building_id: null, room_id: null,
  transport: 'wifi', parent_id: null, cid: null, enabled: true, capabilities: {},
  translations: { name: { 'Kitchen Lamp': { pl: 'Lampa kuchenna' } }, alias: { 'dinner light': { pl: 'Światło do kolacji' } } },
};

afterEach(() => setDeviceTextMode('original', false));

it('uses originals or the current-language variants and searches both on the dashboard', async () => {
  setLocale('en', false);
  vi.spyOn(api, 'inventory').mockResolvedValue({ devices: [fixture], buildings: [], rooms: [], groups: [] });
  vi.spyOn(api, 'state').mockResolvedValue({ device_id: 7, name: fixture.name, enabled: true, available: true, values: {} });
  const user = userEvent.setup();
  renderWithStore(
    <>
      <DeviceTextModeSelector />
      <ControlCenter api={api} ready dashboardPanel="search" onAuthError={vi.fn()} />
    </>,
  );
  expect(await screen.findByRole('listitem', { name: 'Kitchen Lamp' })).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Device names and aliases'), 'localized');
  expect(localStorage.getItem('smart-home.ui.device-text.v1')).toBe('localized');
  act(() => setLocale('pl', false));
  const card = await screen.findByRole('listitem', { name: 'Lampa kuchenna' });
  expect(within(card).getByText('Światło do kolacji')).toBeVisible();
  const search = screen.getByRole('searchbox');
  await user.type(search, 'dinner light');
  expect(screen.getByRole('listitem', { name: 'Lampa kuchenna' })).toBeVisible();
  await user.clear(search);
  await user.type(search, 'Światło do kolacji');
  expect(screen.getByRole('listitem', { name: 'Lampa kuchenna' })).toBeVisible();
  act(() => setLocale('be', false));
  expect(screen.getByRole('listitem', { name: 'Kitchen Lamp' })).toBeVisible();
  expect(screen.getByText('dinner light')).toBeVisible();
});

it('persists translations, edits original alias text, and removes old variants with the alias', async () => {
  setLocale('en', false);
  setDeviceTextMode('localized');
  const save = vi.spyOn(api, 'saveLocalDeviceTranslation').mockImplementation(async (_id, edit) => ({ ...edit, shared: true }));
  vi.spyOn(api, 'saveLocalDeviceAliases').mockImplementation(async (_id, aliases) => ({ device_id: 'lamp', aliases }));
  const user = userEvent.setup();
  const props = { api, deviceId: 'lamp', localId: 7, initialAliases: fixture.aliases, onAuthError: vi.fn() };
  renderWithStore(
    <>
      <DeviceAliases {...props} name={fixture.name} disabled={false} onBusy={vi.fn()} />
      <DeviceTranslationEditor {...props} originalName={fixture.name} />
    </>,
  );
  await user.click(screen.getByText('Name and alias translations'));
  const select = screen.getByLabelText('Name or alias to translate');
  await user.selectOptions(select, 'alias:dinner light');
  await user.type(screen.getByLabelText('English'), 'Evening light');
  await user.click(screen.getByRole('button', { name: 'Save translations' }));
  expect(await screen.findByText('Translations saved.')).toBeVisible();
  expect(save).toHaveBeenCalledWith(7, { kind: 'alias', original: 'dinner light', values: { en: 'Evening light' } });
  await user.click(screen.getByRole('button', { name: 'Edit alias Evening light' }));
  expect(screen.getByRole('textbox', { name: 'Edit alias' })).toHaveValue('dinner light');
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.queryByRole('option', { name: 'dinner light' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Add alias' }));
  await user.type(screen.getByLabelText('New alias'), 'dinner light');
  await user.click(within(screen.getByRole('form', { name: 'Edit alias' })).getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('button', { name: 'Edit alias dinner light' })).toBeVisible();
  expect(screen.queryByText('Evening light')).not.toBeInTheDocument();
});
