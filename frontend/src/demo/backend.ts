import { withTranslation } from '../device-translations';
import type { TranslationWrite } from '../device-translations';
import type { JsonValue } from '../api';
import type {
  Capability, DeviceState, Group, Inventory, LocalDevice,
} from '../home-api';
import template from './apartment.json';

const power = { type: 'boolean', readable: true, writable: true } satisfies Capability;
const capabilities: Record<string, Record<string, Capability>> = {
  light: {
    switch: power,
    brightness: {
      type: 'integer', readable: true, writable: true, minimum: 1, maximum: 100, step: 1, unit: '%',
    },
  },
  plug: { switch: power },
  climate: {
    temperature: {
      type: 'number', readable: true, writable: false, unit: '°C',
    },
    humidity: {
      type: 'integer', readable: true, writable: false, unit: '%',
    },
  },
  motion: {
    motion: { type: 'boolean', readable: true, writable: false },
    battery_level: {
      type: 'integer', readable: true, writable: false, unit: '%',
    },
  },
};

const inventory: Inventory = {
  buildings: [{ id: 1, name: template.name, aliases: [] }],
  rooms: [],
  devices: [],
  groups: [],
};
const values = new Map<number, Record<string, JsonValue>>();
for (const room of template.rooms) {
  const roomId = inventory.rooms.length + 1;
  inventory.rooms.push({
    id: roomId, building_id: 1, name: room.name, aliases: [],
  });
  const lights: number[] = [];
  for (const device of room.devices) {
    const id = inventory.devices.length + 1;
    inventory.devices.push({
      id,
      device_id: `demo-${id}`,
      name: device.name,
      aliases: [],
      building_id: 1,
      room_id: roomId,
      parent_id: null,
      cid: null,
      transport: 'wifi',
      enabled: true,
      capabilities: capabilities[device.kind],
    });
    values.set(id, Object.fromEntries(Object.entries(device.values).filter(([, value]) => value !== undefined)));
    if (device.kind === 'light') lights.push(id);
  }
  if (room.lightingGroup) {
    inventory.groups.push({
      id: inventory.groups.length + 1, name: room.lightingGroup, room_id: roomId, device_ids: lights,
    });
  }
}

function state(device: LocalDevice): DeviceState {
  const now = new Date().toISOString();
  return {
    device_id: device.id,
    name: device.name,
    enabled: true,
    available: true,
    values: Object.fromEntries(Object.entries(values.get(device.id) ?? {}).map(([name, value]) => [name, {
      value, known: true, stale: false, observed_at: now, received_at: now, source: 'local',
    }])),
  };
}

function groupState(group: Group) {
  const members = group.device_ids.map((id) => state(inventory.devices[id - 1]));
  const on = members.filter((member) => member.values.switch.value === true).length;
  const powerState = on === members.length ? 'on' : 'mixed';
  return { group_id: group.id, state: on === 0 ? 'off' : powerState, members };
}

export default async function demoFetch(url: string, init: RequestInit): Promise<Response> {
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const path = new URL(url).pathname;
  const { method } = init;
  if (method === 'GET') {
    if (path === '/api/v1/cloud/status') return Response.json({ enabled: false, connected: false });
    const list = Object.entries(inventory).find(([key]) => path === `/api/v1/${key}`);
    if (list) return Response.json(list[1]);
  }
  const route = /^\/api\/v1\/(devices|groups)\/(\d+)(\/.*)?$/.exec(path);
  if (route) {
    const [, collection, rawId, action] = route;
    const id = Number(rawId);
    const device = collection === 'devices' ? inventory.devices[id - 1] : undefined;
    const group = collection === 'groups' ? inventory.groups[id - 1] : undefined;
    if (device && method === 'GET' && !action) return Response.json(device);
    if (device && method === 'PUT' && action === '/translations') {
      const { edited, ...edit } = JSON.parse(String(init.body)) as TranslationWrite;
      const matches = edit.kind === 'name' ? device.name === edit.original : device.aliases.includes(edit.original);
      if (!matches) return Response.json({ detail: 'This name or alias has changed. Reload the device and try again.' }, { status: 409 });
      if (edited) {
        const merged = { ...device.translations?.[edit.kind][edit.original] };
        for (const locale of edited) {
          const value = edit.values[locale];
          if (value) merged[locale] = value;
          else delete merged[locale];
        }
        edit.values = merged;
      }
      device.translations = withTranslation(device.translations, edit);
      return Response.json({ ...edit, shared: true });
    }
    if (device && method === 'GET' && action === '/state') return Response.json(state(device));
    if (device && method === 'POST' && action === '/commands/capabilities') {
      const updates = JSON.parse(String(init.body)).values as Record<string, JsonValue>;
      if (Object.keys(updates).some((key) => !device.capabilities[key]?.writable)) {
        return Response.json({ detail: 'This demo reading is read-only.' }, { status: 400 });
      }
      values.set(id, { ...values.get(id), ...updates });
      return Response.json({ acknowledged: true });
    }
    if (group && method === 'GET' && action === '/state') return Response.json(groupState(group));
    if (group && method === 'POST' && (action === '/commands/on' || action === '/commands/off')) {
      const results = group.device_ids.map((deviceId) => {
        values.set(deviceId, { ...values.get(deviceId), switch: action === '/commands/on' });
        return { device_id: deviceId, acknowledged: true };
      });
      return Response.json({ all_acknowledged: true, results });
    }
  }
  return Response.json({ detail: 'This operation is unavailable in the simulation.' }, { status: 404 });
}
