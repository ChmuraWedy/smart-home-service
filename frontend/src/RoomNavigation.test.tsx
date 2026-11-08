import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ensureDashboardBrowserId } from './dashboard-layout';
import type { RoomNavigationLayout } from './dashboard-layout';
import { HomeApi } from './home-api';
import { setLocale } from './i18n';
import RoomNavigation from './components/RoomNavigation';

const api = new HomeApi({ baseUrl: 'http://rooms.test', token: 'fixture-key' });
const rooms = ['Kitchen', 'Study', 'Hallway'].map((name, index) => ({
  id: index + 1,
  name,
  building_id: 1,
  aliases: [],
}));

const buttonNames = (container: HTMLElement) => within(container).getAllByRole('button')
  .filter((button) => button.classList.contains('room-choice'))
  .map((button) => button.textContent);

it('saves room order and visibility using the card layout browser ID for both navigation surfaces', async () => {
  setLocale('en', false);
  const browserId = ensureDashboardBrowserId();
  let stored: RoomNavigationLayout = { rooms: [] };
  const requests: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    requests.push(new URL(String(input)).pathname);
    if (init?.method === 'PUT') stored = JSON.parse(String(init.body));
    return Response.json(stored);
  });
  const user = userEvent.setup();
  const select = vi.fn();
  const nav = <RoomNavigation api={api} allRooms={rooms} rooms={rooms} selected="1" onSelect={select} />;
  const first = render(nav);
  const edit = await screen.findByRole('button', { name: 'Edit room navigation' });
  await user.click(edit);
  const editor = await screen.findByRole('dialog', { name: 'Edit room navigation' });
  await user.click(within(editor).getByRole('button', { name: 'Move Hallway up' }));
  await user.click(within(editor).getByRole('button', { name: 'Show Kitchen in room navigation' }));
  await user.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(stored.rooms).toEqual([{ id: 1, hidden: true }, { id: 3, hidden: false }, { id: 2, hidden: false }]);
  first.unmount();

  render(nav);
  const desktop = screen.getByRole('navigation', { name: 'Rooms' });
  await within(desktop).findByRole('button', { name: 'Hallway' });
  await vi.waitFor(() => expect(buttonNames(desktop)).toEqual(['All rooms', 'Hallway', 'Study', 'No room']));
  const changeRoom = screen.getByRole('button', { name: 'Change room, current room is Kitchen' });
  await user.click(changeRoom);
  const picker = await screen.findByRole('dialog', { name: 'Rooms' });
  expect(buttonNames(picker)).toEqual(['All rooms', 'Hallway', 'Study', 'No room']);
  await user.click(within(picker).getByRole('button', { name: 'Study' }));
  expect(select).toHaveBeenCalledWith('2');

  await user.click(screen.getByRole('button', { name: 'Edit room navigation' }));
  const restore = await screen.findByRole('dialog', { name: 'Edit room navigation' });
  const show = within(restore).getByRole('button', { name: 'Show Kitchen in room navigation' });
  expect(show).toHaveAttribute('aria-pressed', 'false');
  await user.click(show);
  await user.click(within(restore).getByRole('button', { name: 'Cancel' }));
  expect(buttonNames(desktop)).not.toContain('Kitchen');
  await user.click(screen.getByRole('button', { name: 'Edit room navigation' }));
  const confirm = await screen.findByRole('dialog', { name: 'Edit room navigation' });
  await user.click(within(confirm).getByRole('button', { name: 'Show Kitchen in room navigation' }));
  await user.click(within(confirm).getByRole('button', { name: 'Save' }));
  expect(buttonNames(desktop)).toEqual(['All rooms', 'Kitchen', 'Hallway', 'Study', 'No room']);
  expect(new Set(requests)).toEqual(new Set([`/api/v1/dashboard-layouts/${browserId}/room-navigation`]));
});

it('appends new rooms and retains the draft when saving fails', async () => {
  setLocale('en', false);
  ensureDashboardBrowserId();
  vi.mocked(fetch).mockImplementation(async (_input, init) => (
    init?.method === 'PUT' ? Response.json({ detail: 'Unavailable' }, { status: 503 }) : Response.json({
      rooms: [{ id: 99, hidden: true }, { id: 2, hidden: false }],
    })
  ));
  const user = userEvent.setup();
  render(<RoomNavigation api={api} allRooms={rooms} rooms={rooms} selected="" onSelect={vi.fn()} />);
  const edit = screen.getByRole('button', { name: 'Edit room navigation' });
  await vi.waitFor(() => expect(edit).toBeEnabled());
  const desktop = screen.getByRole('navigation', { name: 'Rooms' });
  expect(buttonNames(desktop)).toEqual(['All rooms', 'Study', 'Kitchen', 'Hallway', 'No room']);

  await user.click(edit);
  const editor = await screen.findByRole('dialog', { name: 'Edit room navigation' });
  const hide = within(editor).getByRole('button', { name: 'Show Study in room navigation' });
  await user.click(hide);
  await user.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('Your edits are still here');
  expect(hide).toHaveAttribute('aria-pressed', 'false');
});
