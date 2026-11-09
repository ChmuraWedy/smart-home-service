import { matchPath } from 'react-router';
import { deviceHref, readDeviceLink } from './device-links';

export const appPaths = {
  control: '/',
  'combined-devices': '/combined-devices',
  settings: '/settings',
  rooms: '/settings/rooms',
  connections: '/settings/connections',
  network: '/network',
  'local-connections': '/local-connections',
} as const;

export const dashboardToolsPath = '/settings/dashboard';
export const roomPattern = '/rooms/:roomId';
export const dashboardLayoutPath = '/layout/edit';
export const roomLayoutPattern = roomPattern + dashboardLayoutPath;
export const combinationNewPath = `${appPaths['combined-devices']}/new`;
export const combinationNewPreviewPath = `${combinationNewPath}/preview`;
export const combinationPattern = `${appPaths['combined-devices']}/:combinedId`;
export const combinationQuickPattern = `${combinationPattern}/quick`;
export const combinationEditPattern = `${combinationPattern}/edit`;
export const combinationEditPreviewPattern = `${combinationEditPattern}/preview`;
export const groupPattern = '/groups/:groupId';
export const devicePattern = '/devices/:deviceId';
export const quickPattern = devicePattern + '/quick';

export type DashboardPanel = 'search' | 'tools' | null;

export function withQuery(pathname: string, query: URLSearchParams) {
  const search = query.toString();
  return search ? pathname + '?' + search : pathname;
}

export function dashboardRoom(pathname: string, query: URLSearchParams) {
  const match = matchPath(roomPattern, pathname) ?? matchPath(roomLayoutPattern, pathname);
  return match?.params.roomId ?? query.get('room') ?? '';
}

export function isDashboardLayoutPath(pathname: string) {
  return Boolean(matchPath(dashboardLayoutPath, pathname) || matchPath(roomLayoutPattern, pathname));
}

export function dashboardHref(room: string, query: URLSearchParams, panel: DashboardPanel, editingLayout = false) {
  const params = new URLSearchParams(query);
  params.delete('route');
  params.delete('group');
  params.delete('combined');
  params.delete('room');
  params.delete('panel');
  if (editingLayout) {
    params.delete('q');
    if (panel) params.set('panel', panel);
    const roomPath = room ? `/rooms/${encodeURIComponent(room)}` : '';
    return withQuery(roomPath + dashboardLayoutPath, params);
  }
  if (panel === 'search') params.set('panel', 'search');
  if (panel === 'tools') {
    if (room) params.set('room', room);
    return withQuery(dashboardToolsPath, params);
  }
  return withQuery(room ? '/rooms/' + encodeURIComponent(room) : appPaths.control, params);
}

export function dashboardSearchHref(pathname: string, search: string, panel: DashboardPanel, value: string) {
  const params = new URLSearchParams(search);
  if (value) params.set('q', value);
  else params.delete('q');
  params.delete('page');
  return dashboardHref(dashboardRoom(pathname, params), params, panel);
}

export function legacyHref(hash: string) {
  if (hash === '#network') return appPaths.network;
  if (hash === '#local-connections') return appPaths['local-connections'];
  const device = hash.startsWith('#device/') ? readDeviceLink(hash) : null;
  return device ? deviceHref(device.id, device.route) : null;
}
