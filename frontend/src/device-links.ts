import type { DeviceRoute } from './devices';

export type DeviceLink = { id: string; route?: DeviceRoute };
export const deviceCardId = (id: string) => 'device-' + encodeURIComponent(id);
export const deviceHref = (id: string, route?: DeviceRoute) => '#device/' + encodeURIComponent(id) + (route ? '?route=' + route : '');

export function readDeviceLink(hash: string): DeviceLink | null {
  if (!hash.startsWith('#device/')) return null;
  const [encoded, query = ''] = hash.slice(8).split('?');
  try {
    const id = decodeURIComponent(encoded), route = new URLSearchParams(query).get('route');
    if (!id || id.length > 128 || (route && !['local', 'sharing', 'developer'].includes(route))) return null;
    return { id, ...(route ? { route: route as DeviceRoute } : {}) };
  } catch { return null; }
}
