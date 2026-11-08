import { matchPath } from 'react-router';
import { deviceHref, readDeviceLink } from './device-links';

export const appPaths = {
  control: '/',
  settings: '/settings',
  connections: '/settings/connections',
  network: '/network',
  'local-connections': '/local-connections',
} as const;

export const dashboardToolsPath = '/settings/dashboard';
export const roomPattern = '/rooms/:roomId';
export const combinationNewPath = '/combined-devices/new';
export const combinationPattern = '/combined-devices/:combinedId';
export const combinationQuickPattern = `${combinationPattern}/quick`;
export const combinationEditPattern = `${combinationPattern}/edit`;
export const groupPattern = '/groups/:groupId';
export const devicePattern = '/devices/:deviceId';
export const quickPattern = devicePattern + '/quick';

export type DashboardPanel = 'search' | 'tools' | null;

export function withQuery(pathname: string, query: URLSearchParams) {
  const search = query.toString();
  return search ? pathname + '?' + search : pathname;
}

export function dashboardRoom(pathname: string, query: URLSearchParams) {
  return matchPath(roomPattern, pathname)?.params.roomId ?? query.get('room') ?? '';
}

export function dashboardHref(room: string, query: URLSearchParams, panel: DashboardPanel) {
  const params = new URLSearchParams(query);
  params.delete('route');
  params.delete('group');
  params.delete('combined');
  params.delete('room');
  params.delete('panel');
  if (panel === 'search') params.set('panel', 'search');
  if (panel === 'tools') {
    if (room) params.set('room', room);
    return withQuery(dashboardToolsPath, params);
  }
  return withQuery(room ? '/rooms/' + encodeURIComponent(room) : appPaths.control, params);
}

export function legacyHref(hash: string) {
  if (hash === '#network') return appPaths.network;
  if (hash === '#local-connections') return appPaths['local-connections'];
  const device = hash.startsWith('#device/') ? readDeviceLink(hash) : null;
  return device ? deviceHref(device.id, device.route) : null;
}
