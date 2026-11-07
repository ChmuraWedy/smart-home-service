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

it.each([false, true])('saves room order and visibility for both navigation surfaces (member=%s)', async (member) => {
  setLocale('en', false);
  const browserId = ensureDashboardBrowserId();
  const connection = member
    ? new HomeApi({ baseUrl: 'http://rooms.test', token: 'member-key' }, { id: 'alex', name: 'Alex', role: 'member' })
    : api;
  let stored: RoomNavigationLayout = { rooms: [] };
  const requests: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    requests.push(new URL(String(input)).pathname);
    if (init?.method === 'PUT') stored = JSON.parse(String(init.body));
    return Response.json(stored);
  });
  const user = userEvent.setup();
  const select = vi.fn();
  const nav = <RoomNavigation api={connection} allRooms={rooms} rooms={rooms} selected="1" onSelect={select} />;
  const first = render(nav);
  const openPicker = async () => {
    await user.click(screen.getByRole('button', { name: 'Change room, current room is Kitchen' }));
    return screen.findByRole('dialog', { name: 'Rooms' });
  };
  const editInPicker = (picker: HTMLElement) => within(picker).getByRole('button', { name: 'Edit rooms' });
  expect(screen.queryByRole('button', { name: 'Edit rooms' })).not.toBeInTheDocument();
  const firstPicker = await openPicker();
  const edit = editInPicker(firstPicker);
  expect(edit.nextElementSibling).toBe(within(firstPicker).getByRole('button', { name: 'Close' }));
  expect(edit.closest('header')).toBeInTheDocument();
  await vi.waitFor(() => expect(edit).toBeEnabled());
  await user.click(edit);
  const editor = await screen.findByRole('dialog', { name: 'Edit rooms' });
  expect(screen.queryByRole('dialog', { name: 'Rooms' })).not.toBeInTheDocument();
  await user.click(within(editor).getByRole('button', { name: 'Move Hallway up' }));
  await user.click(within(editor).getByRole('button', { name: 'Show Kitchen in room navigation' }));
  await user.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(stored.rooms).toEqual([{ id: 1, hidden: true }, { id: 3, hidden: false }, { id: 2, hidden: false }]);
  first.unmount();
  if (member) localStorage.clear();

  render(nav);
  const desktop = screen.getByRole('navigation', { name: 'Rooms' });
  await within(desktop).findByRole('button', { name: 'Hallway' });
  await vi.waitFor(() => expect(buttonNames(desktop)).toEqual(['All rooms', 'Hallway', 'Study', 'No room']));
  const picker = await openPicker();
  expect(buttonNames(picker)).toEqual(['All rooms', 'Hallway', 'Study', 'No room']);
  await user.click(within(picker).getByRole('button', { name: 'Study' }));
  expect(select).toHaveBeenCalledWith('2');

  await user.click(editInPicker(await openPicker()));
  const restore = await screen.findByRole('dialog', { name: 'Edit rooms' });
  const show = within(restore).getByRole('button', { name: 'Show Kitchen in room navigation' });
  expect(show).toHaveAttribute('aria-pressed', 'false');
  await user.click(show);
  await user.click(within(restore).getByRole('button', { name: 'Cancel' }));
  const reopened = await screen.findByRole('dialog', { name: 'Rooms' });
  expect(buttonNames(reopened)).not.toContain('Kitchen');
  await user.click(editInPicker(reopened));
  const confirm = await screen.findByRole('dialog', { name: 'Edit rooms' });
  await user.click(within(confirm).getByRole('button', { name: 'Show Kitchen in room navigation' }));
  await user.click(within(confirm).getByRole('button', { name: 'Save' }));
  expect(buttonNames(await screen.findByRole('dialog', { name: 'Rooms' }))).toEqual(['All rooms', 'Kitchen', 'Hallway', 'Study', 'No room']);
  expect(new Set(requests)).toEqual(new Set([`/api/v1/dashboard-layouts/${member ? 'me' : browserId}/room-navigation`]));
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
  const desktop = screen.getByRole('navigation', { name: 'Rooms' });
  await within(desktop).findByRole('button', { name: 'Study' });
  expect(buttonNames(desktop)).toEqual(['All rooms', 'Study', 'Kitchen', 'Hallway', 'No room']);

  await user.click(screen.getByRole('button', { name: 'Change room, current room is All rooms' }));
  const picker = await screen.findByRole('dialog', { name: 'Rooms' });
  await user.click(within(picker).getByRole('button', { name: 'Edit rooms' }));
  const editor = await screen.findByRole('dialog', { name: 'Edit rooms' });
  const hide = within(editor).getByRole('button', { name: 'Show Study in room navigation' });
  await user.click(hide);
  await user.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('Your edits are still here');
  expect(hide).toHaveAttribute('aria-pressed', 'false');
});
