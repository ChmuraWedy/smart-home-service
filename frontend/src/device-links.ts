import type { DeviceRoute } from './devices';

export type DeviceLink = { id: string; route?: DeviceRoute };
export const deviceCardId = (id: string) => 'device-' + encodeURIComponent(id);
export const devicePath = (id: string, quick = false) => '/devices/' + encodeURIComponent(id) + (quick ? '/quick' : '');
export const deviceHref = (id: string, route?: DeviceRoute) => devicePath(id) + (route ? '?route=' + route : '');

export function readDeviceLink(href: string): DeviceLink | null {
  const [path, query = ''] = href.split('?');
  const match = /^(?:#device|\/devices)\/([^/]+)(?:\/quick)?\/?$/i.exec(path);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]), route = new URLSearchParams(query).get('route');
    if (!id || id.length > 128 || (route && !['local', 'sharing', 'developer'].includes(route))) return null;
    return { id, ...(route ? { route: route as DeviceRoute } : {}) };
  } catch { return null; }
}
