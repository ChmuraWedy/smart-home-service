import {
  fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { STORAGE_KEY } from './connection';
import type { Building, Room, RoomAppearance } from './home-api';
import { setLocale } from './i18n';
import { prepareRoomBackground } from './room-appearance';
import { App } from './test/App';

const building = { id: 1, name: 'Home', aliases: [] };
const kitchen = { id: 1, building_id: 1, name: 'Kitchen', aliases: [] };
const bedroom = { id: 2, building_id: 1, name: 'Bedroom', aliases: [] };

function fixture(initialBuildings: Building[], initialRooms: Room[]) {
  let buildings = initialBuildings;
  let rooms = initialRooms;
  let allowDelete = false;
  const appearances = new Map<number, RoomAppearance>();
  const uploads: RequestInit[] = [];
  const changes: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname.slice('/api/v1'.length);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') changes.push(`${method} ${path}`);
    if (path === '/cloud/status') return json({ enabled: false, connected: false });
    if (path === '/buildings') {
      if (method === 'POST') {
        const { name } = JSON.parse(String(init?.body));
        const result = { ...building, name };
        buildings = [...buildings, result];
        return json(result, 201);
      }
      return json(buildings);
    }
    if (path === '/rooms') {
      if (method === 'POST') {
        const result = { ...kitchen, ...JSON.parse(String(init?.body)) };
        rooms = [...rooms, result];
        return json(result, 201);
      }
      return json(rooms);
    }
    if (path === '/devices' || path === '/groups') return json([]);
    const match = /^\/rooms\/(\d+)(?:\/(appearance|background))?$/.exec(path);
    if (!match) return json({ detail: 'Not found' }, 404);
    const id = Number(match[1]);
    const appearance = appearances.get(id) ?? { card_opacity: 100, background_version: null };
    if (match[2] === 'appearance') {
      if (method === 'PATCH') Object.assign(appearance, JSON.parse(String(init?.body)));
      appearances.set(id, appearance);
      return json(appearance);
    }
    if (match[2] === 'background') {
      if (method === 'GET') return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } });
      if (method === 'PUT') uploads.push(init!);
      appearance.background_version = method === 'PUT' ? 'uploaded' : null;
      appearances.set(id, appearance);
      return json(appearance);
    }
    if (method === 'PATCH') {
      const room = rooms.find((item) => item.id === id)!;
      const changed = { ...room, ...JSON.parse(String(init?.body)) };
      rooms = rooms.map((item) => (item.id === id ? changed : item));
      return json(changed);
    }
    if (method === 'DELETE') {
      if (!allowDelete) return json({ detail: 'Object has dependants; reassign or delete them first' }, 409);
      rooms = rooms.filter((item) => item.id !== id);
      return new Response(null, { status: 204 });
    }
    return json({ detail: 'Not found' }, 404);
  });
  return { uploads, changes, enableDelete: () => { allowDelete = true; } };
}

function openApp(path: string) {
  setLocale('en', false);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: 'http://rooms.test', token: 'fixture' }));
  window.history.replaceState(null, '', path);
  return render(<App />);
}

it('creates a first building and room, renames it, and preserves it after a blocked deletion', async () => {
  const { changes, enableDelete } = fixture([], []);
  const user = userEvent.setup();
  openApp('/settings/rooms');

  const buildingForm = within(await screen.findByRole('form', { name: 'Create building' }));
  await user.type(buildingForm.getByLabelText('Name'), 'Home');
  await user.click(buildingForm.getByRole('button', { name: 'Create building' }));
  const roomForm = within(await screen.findByRole('form', { name: 'Create room' }));
  await user.type(roomForm.getByLabelText('Name'), 'Workshop');
  await user.click(roomForm.getByRole('button', { name: 'Create room' }));
  const rename = within(await screen.findByRole('form', { name: 'Rename room' }));
  await user.clear(rename.getByLabelText('Name'));
  await user.type(rename.getByLabelText('Name'), 'Studio');
  await user.click(rename.getByRole('button', { name: 'Rename room' }));
  expect(await screen.findByRole('option', { name: 'Studio' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Delete room' }));
  expect(screen.getByText('Delete Studio and its dashboard appearance?')).toBeInTheDocument();
  expect(changes).not.toContain('DELETE /rooms/1');
  await user.click(screen.getByRole('button', { name: 'Delete room' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Move its devices');
  expect(screen.getByRole('option', { name: 'Studio' })).toBeInTheDocument();
  enableDelete();
  await user.click(screen.getByRole('button', { name: 'Delete room' }));
  expect(await screen.findByRole('form', { name: 'Create room' })).toBeInTheDocument();
});

it('opens the selected room from its header and saves its background and opacity', async () => {
  const { uploads, changes } = fixture([building], [kitchen, bedroom]);
  const user = userEvent.setup();
  const app = openApp('/rooms/1');
  const editRoom = await screen.findByRole('button', { name: 'Edit room' });
  const heading = editRoom.closest('.dashboard-layout-heading') as HTMLElement;
  expect(within(heading).getByText('Kitchen', { selector: '.room-navigation-heading' })).toBeInTheDocument();
  expect(within(heading).getByRole('button', { name: 'Edit layout' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Manage rooms' })).not.toBeInTheDocument();
  await user.click(editRoom);
  expect(window.location.pathname).toBe('/settings/rooms');
  expect(await screen.findByRole('combobox', { name: 'Room' })).toHaveValue('1');

  const file = new File(['image'], 'kitchen.png', { type: 'image/png' });
  await user.upload(await screen.findByLabelText('Background image'), file);
  await user.click(screen.getByRole('button', { name: 'Upload background' }));
  expect(await screen.findByRole('img', { name: 'Current room background' })).toBeInTheDocument();
  expect(uploads[0]?.body).toBe(file);
  expect(uploads[0]?.headers).toMatchObject({ 'X-API-Key': 'fixture', 'Content-Type': 'image/png' });

  fireEvent.change(screen.getByRole('slider', { name: /Card background opacity/ }), { target: { value: '75' } });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  expect(changes).toContain('PATCH /rooms/1/appearance');

  await user.click(screen.getByRole('link', { name: 'View room dashboard' }));
  await waitFor(() => expect(document.querySelector('.control-center')).toHaveAttribute('data-room-background', 'true'));
  expect(document.querySelector('.control-center')).toHaveStyle('--room-card-opacity: 75%');
  app.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  openApp('/rooms/2');
  await waitFor(() => expect(document.querySelector('.control-center')).toHaveStyle('--room-card-opacity: 100%'));
  expect(document.querySelector('.control-center')).not.toHaveAttribute('data-room-background');
});

it('opens room management from All rooms even before a room exists', async () => {
  fixture([building], []);
  openApp('/');
  const editRooms = await screen.findByRole('button', { name: 'Manage rooms' });
  expect(editRooms).toHaveTextContent(/^$/);
  await userEvent.setup().click(editRooms);
  expect(window.location.pathname + window.location.search).toBe('/settings/rooms');
  expect(await screen.findByRole('form', { name: 'Create room' })).toBeInTheDocument();
});

it('shrinks a large photo before sending it through the existing upload limit', async () => {
  const close = vi.fn();
  const drawImage = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3000, height: 1500, close })));
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const compressed = new Blob(['jpeg'], { type: 'image/jpeg' });
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(compressed));
  try {
    const large = new File([new Uint8Array(1024 * 1024 + 1)], 'photo.png', { type: 'image/png' });
    expect(await prepareRoomBackground(large)).toBe(compressed);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1440, 720);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    context.mockRestore();
    encode.mockRestore();
  }
});
