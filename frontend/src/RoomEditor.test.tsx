import {
  act, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { STORAGE_KEY } from './connection';
import { setDeviceTextMode } from './device-translations';
import type { Building, LocalDevice, Room, RoomAppearance } from './home-api';
import { setLocale } from './i18n';
import { prepareRoomBackground } from './room-appearance';
import { App } from './test/App';

const building = { id: 1, name: 'Home', aliases: [] };
const kitchen = { id: 1, building_id: 1, name: 'Kitchen', aliases: [] };
const bedroom = { id: 2, building_id: 1, name: 'Bedroom', aliases: [] };

function fixture(initialBuildings: Building[], initialRooms: Room[], devices: LocalDevice[] = []) {
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
        const result = { ...kitchen, id: Math.max(0, ...rooms.map(item => item.id)) + 1, ...JSON.parse(String(init?.body)) };
        rooms = [...rooms, result];
        return json(result, 201);
      }
      return json(rooms);
    }
    if (path === '/devices') return json(devices);
    if (path === '/groups' || path === '/combined-devices') return json([]);
    if (path.endsWith('/room-navigation')) return json({ rooms: [] });
    if (path.startsWith('/dashboard-layouts/')) return json({ slots: [] });
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
  await user.click(await screen.findByRole('button', { name: 'Create room' }));
  const roomForm = within(await screen.findByRole('form', { name: 'Create room' }));
  await user.type(roomForm.getByLabelText('Name'), 'Workshop');
  await user.click(roomForm.getByRole('button', { name: 'Create room' }));
  await user.click(await screen.findByRole('button', { name: 'Rename room' }));
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
  expect(await screen.findByRole('button', { name: 'Create room' })).toBeInTheDocument();
});

it('creates, renames, and confirms deletion from the room picker and keeps No room available', async () => {
  const { changes, enableDelete } = fixture([building], [kitchen, bedroom]);
  const user = userEvent.setup();
  openApp('/rooms/2');
  await user.click(await screen.findByRole('button', { name: 'Change room, current room is Bedroom' }));
  const picker = within(await screen.findByRole('dialog', { name: 'Rooms' }));
  const edit = picker.getByRole('button', { name: 'Edit rooms' });
  await waitFor(() => expect(edit).toBeEnabled());
  await user.click(edit);
  const dialog = await screen.findByRole('dialog', { name: 'Edit rooms' });
  const editor = within(dialog);
  expect(editor.queryByRole('button', { name: 'Delete No room' })).not.toBeInTheDocument();
  await user.click(editor.getByRole('button', { name: 'New room' }));
  const create = within(await screen.findByRole('dialog', { name: 'Create room' }));
  const translations = create.getByText('Room name translations (optional)').closest('details');
  expect(translations).not.toHaveAttribute('open');
  await user.click(create.getByText('Room name translations (optional)'));
  fireEvent.change(create.getByLabelText('English'), { target: { value: 'Craft room' } });
  fireEvent.change(create.getByLabelText('Name'), { target: { value: 'Workshop' } });
  await user.click(create.getByRole('button', { name: 'Create room' }));
  await user.click(await editor.findByRole('button', { name: 'Rename Workshop' }));
  const rename = within(await screen.findByRole('dialog', { name: 'Rename room' }));
  await user.click(rename.getByText('Room name translations (optional)'));
  expect(rename.getByLabelText('English')).toHaveValue('Craft room');
  fireEvent.change(rename.getByLabelText('English'), { target: { value: 'Art studio' } });
  await user.click(rename.getByRole('button', { name: 'Rename room' }));
  expect(await editor.findByRole('button', { name: 'Delete Workshop' })).toBeEnabled();

  await user.click(editor.getByRole('button', { name: 'Delete Bedroom' }));
  const confirm = within(editor.getByRole('group', { name: 'Delete Bedroom' }));
  expect(confirm.getByText(/Devices assigned to this room in Smart Life will appear under No room/)).toBeInTheDocument();
  expect(changes).not.toContain('DELETE /rooms/2');
  enableDelete();
  await user.click(confirm.getByRole('button', { name: 'Delete room' }));
  await waitFor(() => expect(window.location.pathname).toBe('/'));
  await user.click(editor.getByRole('button', { name: 'Cancel' }));
  const updated = within(await screen.findByRole('dialog', { name: 'Rooms' }));
  expect(updated.getByRole('button', { name: 'Workshop' })).toBeInTheDocument();
  expect(updated.queryByRole('button', { name: 'Bedroom' })).not.toBeInTheDocument();
  expect(updated.getByRole('button', { name: 'No room' })).toBeInTheDocument();
  try {
    act(() => setDeviceTextMode('localized', false));
    expect(updated.getByRole('button', { name: 'Art studio' })).toBeInTheDocument();
    expect(updated.getByRole('button', { name: 'Kitchen' })).toBeInTheDocument();
  } finally {
    act(() => setDeviceTextMode('original', false));
  }
  expect(changes).toEqual(['POST /rooms', 'PATCH /rooms/3', 'DELETE /rooms/2']);
});

it('edits the name and appearance without clearing a grid draft', async () => {
  const device: LocalDevice = {
    id: 1, device_id: 'kitchen-lamp', name: 'Kitchen lamp', aliases: [], building_id: 1, room_id: 1,
    transport: 'wifi', parent_id: null, cid: null, enabled: false, capabilities: {},
  };
  const { uploads, changes } = fixture([building], [kitchen, bedroom], [device]);
  const user = userEvent.setup();
  const app = openApp('/rooms/1');
  const editLayout = await screen.findByRole('button', { name: 'Edit layout' });
  const heading = editLayout.closest('.dashboard-layout-heading') as HTMLElement;
  expect(within(heading).getByText('Kitchen', { selector: '.room-navigation-heading' })).toBeInTheDocument();
  expect(editLayout.querySelector('[data-icon="edit"]')).toBeInTheDocument();
  expect(screen.queryByText('Room appearance and name editor')).not.toBeInTheDocument();
  await user.click(editLayout);
  expect(window.location.pathname).toBe('/rooms/1/layout/edit');
  fireEvent.click(screen.getByRole('button', { name: 'Move Kitchen lamp (Row 1, column 1)' }));
  await user.click(screen.getByRole('button', { name: 'Move here (Row 3, column 1)' }));

  await user.click(screen.getByText('Room appearance and name editor'));
  await user.click(screen.getByRole('button', { name: 'Rename room' }));
  const name = within(screen.getByRole('form', { name: 'Rename room' }));
  await user.clear(name.getByLabelText('Name'));
  await user.type(name.getByLabelText('Name'), 'New kitchen');
  await user.click(name.getByRole('button', { name: 'Rename room' }));
  expect(await within(heading).findByText('New kitchen', { selector: '.room-navigation-heading' })).toBeInTheDocument();

  const appearance = within(screen.getByRole('region', { name: 'Room appearance' }));
  const file = new File(['image'], 'kitchen.png', { type: 'image/png' });
  await user.upload(await appearance.findByLabelText('Background image'), file);
  await user.click(appearance.getByRole('button', { name: 'Upload background' }));
  expect(await appearance.findByRole('img', { name: 'Current room background' })).toBeInTheDocument();
  expect(uploads[0]?.body).toBe(file);
  expect(uploads[0]?.headers).toMatchObject({ 'X-API-Key': 'fixture', 'Content-Type': 'image/png' });

  fireEvent.change(appearance.getByRole('slider', { name: /Card background opacity/ }), { target: { value: '75' } });
  await user.click(appearance.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(appearance.getByRole('button', { name: 'Save' })).toBeDisabled());
  expect(changes).toContain('PATCH /rooms/1/appearance');
  await waitFor(() => expect(document.querySelector('.control-center')).toHaveAttribute('data-room-background', 'true'));
  expect(document.querySelector('.control-center')).toHaveStyle('--room-card-opacity: 75%');
  expect(screen.getByRole('button', { name: 'Move Kitchen lamp (Row 3, column 1)' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/rooms/1/layout/edit');

  app.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  openApp('/rooms/2');
  await waitFor(() => expect(document.querySelector('.control-center')).toHaveStyle('--room-card-opacity: 100%'));
  expect(document.querySelector('.control-center')).not.toHaveAttribute('data-room-background');
});

it('opens room management from All rooms even before a room exists', async () => {
  fixture([building], []);
  openApp('/');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Edit layout' }));
  expect(window.location.pathname).toBe('/layout/edit');
  await user.click(screen.getByRole('button', { name: 'Manage rooms' }));
  expect(window.location.pathname + window.location.search).toBe('/settings/rooms');
  await user.click(await screen.findByRole('button', { name: 'Create room' }));
  expect(await screen.findByRole('dialog', { name: 'Create room' })).toBeInTheDocument();
});

it('restores the room layout editor from a direct URL and returns to that room after saving', async () => {
  const { changes } = fixture([building], [kitchen, bedroom]);
  const user = userEvent.setup();
  openApp('/rooms/2/layout/edit?building=1');
  const heading = await screen.findByText('Bedroom', { selector: '.room-navigation-heading' });
  const toolbar = heading.closest('.dashboard-layout-toolbar');
  expect(toolbar).toHaveAttribute('data-editing', 'true');
  await user.click(await within(toolbar as HTMLElement).findByRole('button', { name: 'Save' }));
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/rooms/2?building=1'));
  expect(changes.some((change) => change.startsWith('PUT /dashboard-layouts/'))).toBe(true);
  expect(screen.queryByText('Room appearance and name editor')).not.toBeInTheDocument();
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

it('draws and moves a crop region and saves the selected pixels as the room background', async () => {
  const { uploads } = fixture([building], [kitchen]);
  const bitmap = { width: 1200, height: 800, close: vi.fn() };
  const decode = vi.fn(async () => bitmap);
  vi.stubGlobal('createImageBitmap', decode);
  const drawImage = vi.fn();
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const cropped = new Blob(['jpeg'], { type: 'image/jpeg' });
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(cropped));
  try {
    const user = userEvent.setup();
    openApp('/rooms/1/layout/edit');
    await user.click(await screen.findByText('Room appearance and name editor'));
    const appearance = within(screen.getByRole('region', { name: 'Room appearance' }));
    await user.upload(await appearance.findByLabelText('Background image'), new File(['image'], 'photo.png', { type: 'image/png' }));
    await user.click(appearance.getByRole('button', { name: 'Crop image' }));
    const dialog = within(await screen.findByRole('dialog', { name: /Crop image/ }));
    const selection = await dialog.findByRole('button', { name: 'Crop region' });
    const stage = selection.parentElement!;
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 400));
    fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 450, clientY: 300 });
    expect(selection).toHaveStyle({ left: '25%', top: '25%', width: '50%', height: '50%' });
    fireEvent.pointerDown(selection, { pointerId: 2, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 375, clientY: 250 });
    expect(selection).toHaveStyle({ left: '37.5%', top: '37.5%', width: '50%', height: '50%' });
    expect(uploads).toHaveLength(0);

    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await appearance.findByRole('img', { name: 'Current room background' })).toBeInTheDocument();
    expect(uploads[0]?.body).toBe(cropped);
    expect(drawImage).toHaveBeenLastCalledWith(bitmap, 450, 300, 600, 400, 0, 0, 600, 400);
    expect(bitmap.close).toHaveBeenCalledOnce();

    await user.click(appearance.getByRole('button', { name: 'Crop image' }));
    const savedCrop = within(await screen.findByRole('dialog', { name: /Crop image/ }));
    await savedCrop.findByRole('button', { name: 'Crop region' });
    expect(decode).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'image/jpeg' }));
    await user.click(savedCrop.getByRole('button', { name: 'Cancel' }));
    expect(uploads).toHaveLength(1);
  } finally {
    context.mockRestore();
    encode.mockRestore();
  }
});
