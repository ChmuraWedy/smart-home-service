import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { App } from './test/App';
import { setLocale } from './i18n';
import { STORAGE_KEY } from './connection';

it('opens the tutorial from the menu and lets keyboard users move between topics', async () => {
  setLocale('en', false);
  window.history.replaceState(null, '', '/settings');
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole('button', { name: 'Menu' }));
  await user.click(screen.getByRole('button', { name: 'App tutorial' }));
  expect(window.location.pathname).toBe('/tutorial');
  expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Find devices by room' })).toHaveFocus();

  await user.tab();
  expect(screen.getByRole('link', { name: 'Next' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(window.location.search).toBe('?topic=controls');
  expect(screen.getByRole('heading', { name: 'Control a device' })).toHaveFocus();

  const topics = screen.getByRole('navigation', { name: 'Tutorial topics' });
  expect(within(topics).getByRole('link', { name: 'Control a device' })).toHaveAttribute('aria-current', 'step');
  await user.click(within(topics).getByRole('link', { name: 'AI chat' }));
  expect(screen.getByText('Step 5 of 5')).toBeInTheDocument();

  window.history.back();
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Control a device' })).toHaveFocus());
});

it('opens a translated topic directly and guides signed-out users to setup at the end', async () => {
  setLocale('pl', false);
  window.history.replaceState(null, '', '/tutorial?topic=local');
  const user = userEvent.setup();
  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Samouczek' })).toBeInTheDocument();
  expect(screen.getByText('Krok 4 z 5')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Połączenia lokalne' })).toHaveFocus();
  expect(screen.queryByRole('link', { name: 'Otwórz połączenia lokalne' })).toBeNull();
  await user.click(screen.getByRole('link', { name: 'Dalej' }));

  const setupLink = screen.getByRole('link', { name: /Połącz.*Tuya/ });
  expect(setupLink).toHaveAttribute('href', '/settings/connections');
  await user.click(setupLink);
  expect(window.location.pathname).toBe('/settings/connections');
});

it('launches the tour over the dashboard, reveals the real menu, and exits with Escape', async () => {
  setLocale('en', false);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: 'http://api.test:8765', token: 'test-key' }));
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    expect(options?.method ?? 'GET').toBe('GET');
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/status')) {
      return Response.json({
        enabled: true, connected: false, developer: { configured: false, connected: false },
      });
    }
    return Response.json([]);
  });
  const user = userEvent.setup();
  render(<App />);

  const menu = await screen.findByRole('button', { name: 'Menu' });
  await waitFor(() => expect(menu).toBeEnabled());
  await user.click(menu);
  await user.click(screen.getByRole('button', { name: 'App tutorial' }));

  const tour = screen.getByRole('dialog', { name: 'Menu' });
  expect(window.location.search).toBe('?tour=1');
  expect(within(tour).getByText('Step 1 of 9')).toBeInTheDocument();
  await user.click(within(tour).getByRole('button', { name: 'Next' }));
  expect(document.getElementById('app-sections')).toBeInTheDocument();
  expect(within(tour).getByRole('heading', { name: 'App navigation' })).toHaveFocus();
  await user.click(within(tour).getByRole('button', { name: 'Next' }));
  expect(document.getElementById('app-sections')).toBeNull();

  tour.dispatchEvent(new Event('cancel', { cancelable: true }));
  await waitFor(() => expect(tour).not.toBeInTheDocument());
  expect(window.location.search).toBe('');
});

it('follows real room and combined-device screens and saves only on the wizard Save action', async () => {
  setLocale('en', false);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: 'http://api.test:8765', token: 'test-key' }));
  const room = { id: 1, name: 'Study Room', building_id: 1, aliases: [] };
  const devices = ['Desk lamp', 'Ceiling lamp'].map((name, index) => ({
    id: index + 1,
    device_id: 'lamp-' + index,
    name,
    aliases: [],
    room_id: room.id,
    building_id: room.building_id,
    transport: 'wifi',
    enabled: true,
    capabilities: {},
  }));
  const saves: unknown[] = [];
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const path = new URL(String(input)).pathname.replace('/api/v1', '');
    if (path === '/combined-devices' && options?.method === 'POST') {
      const saved = JSON.parse(String(options.body));
      saves.push(saved);
      return Response.json({ ...saved, id: 1 });
    }
    if (path === '/cloud/status') return Response.json({
      enabled: true, connected: false, developer: { configured: false, connected: false },
    });
    if (path === '/buildings') return Response.json([{ id: 1, name: 'Home', aliases: [] }]);
    if (path === '/rooms') return Response.json([room]);
    if (path === '/rooms/1/appearance') return Response.json({ card_opacity: 100, background_version: null });
    if (path === '/devices') return Response.json(devices);
    if (path.endsWith('/room-navigation')) return Response.json({ rooms: [] });
    if (path.startsWith('/dashboard-layouts/')) return Response.json({ slots: [] });
    return Response.json([]);
  });

  const user = userEvent.setup();
  render(<App />);
  const menu = await screen.findByRole('button', { name: 'Menu' });
  await waitFor(() => expect(menu).toBeEnabled());
  await user.click(menu);
  await user.click(screen.getByRole('button', { name: 'App tutorial' }));

  const intro = within(screen.getByRole('dialog', { name: 'Menu' }));
  for (let index = 0; index < 7; index += 1) await user.click(intro.getByRole('button', { name: 'Next' }));
  const practice = within(screen.getByRole('complementary', { name: 'Arrange your dashboard' }));
  expect(practice.getByText('Choose a named room using the room menu or the room bar.')).toBeInTheDocument();
  await user.click(within(screen.getByRole('navigation', { name: 'Rooms' })).getByRole('button', { name: 'Study Room' }));
  await user.click(screen.getByRole('button', { name: 'Edit layout' }));
  expect(window.location.pathname).toBe('/rooms/1/layout/edit');
  expect(practice.getByText(/Try moving a card/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(await practice.findByRole('button', { name: 'Next' }));

  await user.click(menu);
  await user.click(screen.getByRole('button', { name: 'Combined devices' }));
  await user.click(await screen.findByRole('button', { name: 'Create combined device' }));
  const combo = within(screen.getByRole('complementary', { name: 'Combined devices' }));
  expect(combo.getByText(/Select at least two devices/)).toBeInTheDocument();

  await user.click(await screen.findByRole('checkbox', { name: 'Desk lamp' }));
  await user.click(screen.getByRole('checkbox', { name: 'Ceiling lamp' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await combo.findByText(/Give the combination a name/)).toBeInTheDocument();
  await user.clear(screen.getByRole('textbox', { name: 'Name' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Study lighting');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(window.location.pathname).toBe('/combined-devices/new/preview');
  expect(combo.getByText(/Review the card/)).toBeInTheDocument();
  expect(saves).toEqual([]);

  await user.click(screen.getByRole('button', { name: 'Save' }));
  await user.click(await combo.findByRole('button', { name: 'Done' }));
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ name: 'Study lighting', room_id: 1 });
  expect(window.location.pathname).toBe('/combined-devices');
  expect(screen.queryByRole('complementary', { name: 'Combined devices' })).not.toBeInTheDocument();
});
