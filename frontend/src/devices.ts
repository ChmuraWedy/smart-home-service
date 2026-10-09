import type { CloudDevice, Provider } from './api';
import type { LocalDevice } from './home-api';

export type DeviceRoute = Provider | 'local';
export type UnifiedDevice = {
  id: string;
  name: string;
  local?: LocalDevice;
  cloud: Partial<Record<Provider, CloudDevice>>;
};
export const routeLabel: Record<DeviceRoute, string> = {
  local: 'В домашней сети', sharing: 'Через интернет · Smart Life', developer: 'Через интернет · Tuya Developer',
};

// The database's numeric ID addresses a local record; device_id is the same
// physical Tuya identity returned by both cloud providers. Never merge by name.
export function mergeDevices(local: LocalDevice[], cloud: Partial<Record<Provider, CloudDevice[]>>): UnifiedDevice[] {
  const devices = new Map<string, UnifiedDevice>();
  for (const device of local) devices.set(device.device_id, { id: device.device_id, name: device.name, local: device, cloud: {} });
  for (const provider of ['sharing', 'developer'] as const) {
    for (const device of cloud[provider] || []) {
      const entry = devices.get(device.id) || { id: device.id, name: device.name || 'Без названия', cloud: {} };
      entry.cloud[provider] = device;
      devices.set(device.id, entry);
    }
  }
  return [...devices.values()];
}

export function deviceRoutes(device: UnifiedDevice): DeviceRoute[] {
  return [...(['sharing', 'developer'] as const).filter(provider => Boolean(device.cloud[provider])), ...(device.local ? ['local' as const] : [])];
}

export function matchesDevice(device: UnifiedDevice, search: string): boolean {
  return [device.id, device.name, ...deviceAliases(device), ...Object.values(device.cloud).map(item => item?.name || '')]
    .join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}

export function deviceAliases(device: UnifiedDevice): string[] {
  const names = new Set([device.name, ...Object.values(device.cloud).map(item => item?.name || '')].map(name => name.toLocaleLowerCase()));
  return [...new Set([...(device.local?.aliases || []), ...Object.values(device.cloud).flatMap(item => item?.aliases || [])])]
    .filter(alias => !names.has(alias.toLocaleLowerCase()));
}
