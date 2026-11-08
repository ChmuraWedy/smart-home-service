import { MSG, localizeMessages, t } from "./i18n";
import type { CloudDevice, Provider } from './api';
import { translationFor, useDeviceText } from './device-translations';
import type { TranslationKind } from './device-translations';
import type { LocalDevice } from './home-api';

export type DeviceRoute = Provider | 'local';
export type UnifiedDevice = {
  id: string;
  name: string;
  local?: LocalDevice;
  cloud: Partial<Record<Provider, CloudDevice>>;
};
export const routeLabel: Record<DeviceRoute, string> = localizeMessages({
  local: MSG.ON_YOUR_HOME_NETWORK, sharing: MSG.OVER_THE_INTERNET_SMART_LIFE, developer: MSG.OVER_THE_INTERNET_TUYA_DEVELOPER,
});

// The database's numeric ID addresses a local record; device_id is the same
// physical Tuya identity returned by both cloud providers. Never merge by name.
export function mergeDevices(local: LocalDevice[], cloud: Partial<Record<Provider, CloudDevice[]>>): UnifiedDevice[] {
  const devices = new Map<string, UnifiedDevice>();
  for (const device of local) devices.set(device.device_id, { id: device.device_id, name: device.name, local: device, cloud: {} });
  for (const provider of ['sharing', 'developer'] as const) {
    for (const device of cloud[provider] || []) {
      const entry = devices.get(device.id) || { id: device.id, name: device.name || t(MSG.UNNAMED), cloud: {} };
      entry.cloud[provider] = device;
      devices.set(device.id, entry);
    }
  }
  return [...devices.values()];
}

export function deviceRoutes(device: UnifiedDevice): DeviceRoute[] {
  return [...(['sharing', 'developer'] as const).filter(provider => Boolean(device.cloud[provider])), ...(device.local ? ['local' as const] : [])];
}

export function deviceTextVariants(device: UnifiedDevice, kind: TranslationKind, original: string) {
  return {
    ...translationFor(device.cloud.developer?.translations, kind, original),
    ...translationFor(device.cloud.sharing?.translations, kind, original),
    ...translationFor(device.local?.translations, kind, original),
  };
}

export function useDeviceDisplayName() {
  const localize = useDeviceText();
  return (device: UnifiedDevice | undefined, fallback: string) => (
    device ? localize(device.name, deviceTextVariants(device, 'name', device.name)) : fallback
  );
}

export function matchesDevice(device: UnifiedDevice, search: string): boolean {
  const aliases = deviceAliases(device);
  const names = [device.name, ...Object.values(device.cloud).map((item) => item?.name || '')];
  const localizedNames = names.flatMap((name) => Object.values(deviceTextVariants(device, 'name', name)));
  const localizedAliases = aliases.flatMap((alias) => Object.values(deviceTextVariants(device, 'alias', alias)));
  return [device.id, ...names, ...aliases, ...localizedNames, ...localizedAliases]
    .join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}

export function deviceAliases(device: UnifiedDevice): string[] {
  const names = new Set([device.name, ...Object.values(device.cloud).map(item => item?.name || '')].map(name => name.toLocaleLowerCase()));
  return [...new Set([...(device.local?.aliases || []), ...Object.values(device.cloud).flatMap(item => item?.aliases || [])])]
    .filter(alias => !names.has(alias.toLocaleLowerCase()));
}
