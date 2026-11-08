import { withTranslation } from '../device-translations';
import type { TranslationWrite } from '../device-translations';
import type { JsonValue } from '../api';
import type {
  Capability, CombinedDevice, CombinedPowerResult, DeviceState, Group, Inventory, LocalDevice,
} from '../home-api';
import template from './apartment.json';

const power = { type: 'boolean', readable: true, writable: true } satisfies Capability;
const brightness = {
  type: 'integer', readable: true, writable: true, minimum: 1, maximum: 100, step: 1, unit: '%',
} satisfies Capability;
const capabilities: Record<string, Record<string, Capability>> = {
  light: { switch: power, brightness },
  tunable_light: {
    switch: power,
    brightness,
    color_temperature: {
      type: 'integer', readable: true, writable: true, minimum: 0, maximum: 100, step: 1, unit: '%',
    },
  },
  relay: { switch_1: power, switch_2: power },
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
const combinations: CombinedDevice[] = [];
const devicesByIdentifier = new Map<string, LocalDevice>();
const powerSources = new Map<number, { id: number; channel: string }>();

type DemoCombination = {
  'name': string;
  members: { device: string; powerSource?: { device: string; channel: string } }[];
};

function addCombination(roomId: number, combination: DemoCombination, roomDevices: Map<string, LocalDevice>) {
  function deviceFor(key: string) {
    const device = roomDevices.get(key);
    if (!device) throw new Error(`Unknown device "${key}" in demo combination "${combination.name}".`);
    return device;
  }

  const members = combination.members.map(({ device, powerSource }) => {
    const item = deviceFor(device);
    const member = { device_id: item.device_id, route: 'local' as const, accessible: true };
    if (!powerSource) return member;
    const relay = deviceFor(powerSource.device);
    powerSources.set(item.id, { id: relay.id, channel: powerSource.channel });
    return { ...member, power_source: { device_id: relay.device_id, channel: powerSource.channel } };
  });
  combinations.push({
    id: combinations.length + 1,
    name: combination.name,
    room_id: roomId,
    members,
    show_all_power: true,
    show_member_cards: false,
  });
}

for (const room of template.rooms) {
  const roomId = inventory.rooms.length + 1;
  inventory.rooms.push({
    id: roomId, building_id: 1, name: room.name, aliases: [],
  });
  const lights: number[] = [];
  const roomDevices = new Map<string, LocalDevice>();
  for (const device of room.devices) {
    const id = inventory.devices.length + 1;
    const item: LocalDevice = {
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
    };
    inventory.devices.push(item);
    devicesByIdentifier.set(item.device_id, item);
    if ('key' in device) roomDevices.set(device.key, item);
    values.set(id, Object.fromEntries(Object.entries(device.values).filter(([, value]) => value !== undefined)));
    if (device.kind === 'light' || device.kind === 'tunable_light') lights.push(id);
  }
  if (room.combination) addCombination(roomId, room.combination, roomDevices);
  if (room.lightingGroup) {
    inventory.groups.push({
      id: inventory.groups.length + 1, name: room.lightingGroup, room_id: roomId, device_ids: lights,
    });
  }
}

function isAvailable(id: number) {
  const supply = powerSources.get(id);
  return !supply || values.get(supply.id)?.[supply.channel] === true;
}

function state(device: LocalDevice): DeviceState {
  const now = new Date().toISOString();
  return {
    device_id: device.id,
    name: device.name,
    enabled: true,
    available: isAvailable(device.id),
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

function setCombinedPower(combination: CombinedDevice, enabled: boolean): CombinedPowerResult {
  return {
    results: combination.members.map(({ device_id: identifier }) => {
      const device = devicesByIdentifier.get(identifier);
      if (!device) return { device_id: identifier, outcome: 'unavailable' };
      const updates = Object.fromEntries(
        Object.entries(device.capabilities)
          .filter(([key, spec]) => /^switch(?:_[1-9][0-9]*)?$/.test(key) && spec.type === 'boolean' && spec.writable)
          .map(([key]) => [key, enabled]),
      );
      if (!Object.keys(updates).length) return { device_id: identifier, outcome: 'unsupported' };
      values.set(device.id, { ...values.get(device.id), ...updates });
      return { device_id: identifier, outcome: 'accepted' };
    }),
  };
}

export default async function demoFetch(url: string, init: RequestInit): Promise<Response> {
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const path = new URL(url).pathname;
  const { method } = init;
  if (method === 'GET') {
    if (path === '/api/v1/combined-devices') return Response.json(combinations);
    if (path === '/api/v1/cloud/status') return Response.json({ enabled: false, connected: false });
    const list = Object.entries(inventory).find(([key]) => path === `/api/v1/${key}`);
    if (list) return Response.json(list[1]);
  }
  const combinedPower = /^\/api\/v1\/combined-devices\/(\d+)\/power\/(on|off)$/.exec(path);
  if (method === 'POST' && combinedPower) {
    const combination = combinations[Number(combinedPower[1]) - 1];
    if (combination) return Response.json(setCombinedPower(combination, combinedPower[2] === 'on'));
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
      if (!isAvailable(device.id)) return Response.json({ detail: 'The demo relay is off.' }, { status: 503 });
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
