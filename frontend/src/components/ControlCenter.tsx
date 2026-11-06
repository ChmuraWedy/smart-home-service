import { MSG, dateLocale, t, translateText } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../api';
import type { CloudDevice, Provider } from '../api';
import { localSpec } from '../controls';
import { deviceAliases, deviceRoutes, matchesDevice, mergeDevices, routeLabel } from '../devices';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import { HomeApi } from '../home-api';
import type { Group, GroupState, Inventory, LocalDevice } from '../home-api';
import { CloudControl } from './CloudControl';
import { GroupControl, LocalControl, groupSummary } from './LocalControls';
import { useClock } from './DeviceControls';
import { DeviceSurvey } from './DeviceSurvey';
import { BatteryBadge, batteryFromSpecs, DeviceIcon, isCamera } from './DevicePresentation';
import { useTopology } from '../use-topology';
import type { CardStatus } from './CardControls';
import { CardControls } from './CardControls';
import { Card } from './ui/card';
import { DashboardAliases } from './DashboardAliases';
import type { MouseEvent, ReactNode } from 'react';
import { deviceCardId, devicePath, readDeviceLink } from '../device-links';
import { dashboardHref, dashboardRoom, groupPattern, quickPattern, withQuery } from '../navigation';
import type { DashboardPanel } from '../navigation';
import { selectCommandPending, setCommandPending, setDetailsOpen, useAppDispatch, useAppSelector } from '../store';
import { readLocalDevice } from '../local-device-cache';
import { cloudAccountScope } from '../cloud-account-scope';
import { cacheDeviceMetadata, cloudMetadataKey, labelsFromCloudDefinitions, localMetadataKey, nextDeviceMetadataRevision } from '../device-metadata';
import { useLocalDeviceState } from '../use-local-device-state';

type Selection = { kind: 'group'; group: Group } | { kind: 'device'; device: UnifiedDevice; route: DeviceRoute; parent?: Group } | { kind: 'survey'; device?: CloudDevice; provider?: Provider; existing?: LocalDevice };
type Loaded = { api: HomeApi; mask: string; inventory: Inventory | null; cloud: Partial<Record<Provider, CloudDevice[]>>; errors: string[] };
const PAGE_SIZE = 24;
const NO_CLOUD: Partial<Record<Provider, CloudDevice[]>> = {};

function openCard(event:MouseEvent<HTMLLIElement>,open:()=>void) {
  if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest('button,a,input,select,textarea,label,summary,video,audio,[role="button"],[role="switch"],[contenteditable="true"],.camera-live') || window.getSelection()?.toString()) return;
  open();
}

function CardDetailsButton({ label, disabled, onClick }: { label:string; disabled?:boolean; onClick:() => void }) {
  return <button type="button" className="secondary tile-icon-action" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3h4l.6 2.7 1.9 1.1 2.6-.9 2 3.5-2 1.8v2.2l2 1.8-2 3.5-2.6-.9-1.9 1.1L14 21h-4l-.6-2.7-1.9-1.1-2.6.9-2-3.5 2-1.8v-2.2l-2-1.8 2-3.5 2.6.9 1.9-1.1L10 3Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  </button>;
}

function DashboardCardHeader({ icon, title, aliases, metadata, actions }: {
  icon: ReactNode; title: ReactNode; aliases?: string[]; metadata: ReactNode; actions: ReactNode;
}) {
  return <header className="dashboard-card-header" data-slot="card-header">
    <span className="device-symbol" aria-hidden="true">{icon}</span>
    <div className="device-card-identity">
      <div className="device-card-title"><h3>{title}</h3>
        {!!aliases?.length && <DashboardAliases aliases={aliases} />}
      </div>
      <div className="device-card-context">{metadata}</div>
    </div>
    <div className="device-card-actions">{actions}</div>
  </header>;
}

function DashboardCardFooter({ children }: { children: ReactNode }) {
  return <footer className="dashboard-card-footer" data-slot="card-footer">{children}</footer>;
}

function DeviceCard({ api, device, room, now, paused, quickRoute, onAuthError, onOpen, onQuickOpen, onQuickClose, onAdd }: {
  api: HomeApi; device: UnifiedDevice; room: string; now: number; paused: boolean; onAuthError: () => void; onOpen: (route: DeviceRoute) => void; onAdd?: (provider: Provider) => void;
  quickRoute?: DeviceRoute; onQuickOpen: (route: DeviceRoute) => void; onQuickClose: () => void;
}) {
  const state = useLocalDeviceState(api, device.local?.id);
  const aliases = useMemo(() => deviceAliases(device), [device]);
  const routes = deviceRoutes(device);
  const [chosen, setChosen] = useState<DeviceRoute | null>(null);
  const dispatch = useAppDispatch();
  const quickBusy = useAppSelector(state => selectCommandPending(state, device.id));
  const quickOpen = quickRoute !== undefined;
  const [lightSheet, setLightSheet] = useState<{route:DeviceRoute;available:boolean}>();
  const sheetTrigger = useRef<HTMLButtonElement>(null);
  const notifyBusy = useCallback((pending: boolean) => {
    dispatch(setCommandPending({ deviceId: device.id, pending }));
  }, [device.id, dispatch]);
  const route = quickRoute ?? (chosen && routes.includes(chosen) ? chosen : routes[0]);
  const [liveStatus,setLiveStatus] = useState<{route:DeviceRoute;status:CardStatus}>();
  const updateStatus = useCallback((status:CardStatus)=>setLiveStatus({route,status}),[route]);
  const live = liveStatus?.route === route ? liveStatus.status : undefined;
  const cloud = route !== 'local' ? device.cloud[route] : undefined;
  const hasSheet = isCamera(cloud?.category) || (lightSheet?.route === route && lightSheet.available);
  const onLightAvailable = useCallback((available:boolean) => setLightSheet({route,available}), [route]);
  const showSheet = () => { if (!paused && !quickBusy && hasSheet && !quickOpen) onQuickOpen(route); };
  const local = device.local;
  const initialBattery = cloud?.battery || (local && state ? batteryFromSpecs(Object.entries(local.capabilities).map(([key,cap]) => localSpec(key,cap)),Object.fromEntries(Object.entries(state.values).filter(([,reading]) => reading.known).map(([key,reading]) => [key,reading.value]))) : undefined);
  const battery = live ? live.battery : initialBattery;
  const enabled = (route === 'local' ? state?.enabled : undefined) ?? local?.enabled;
  const online = route === 'local' ? enabled && state?.available : live?.online ?? cloud?.online;
  const definitions = cloud?.controls?.definitions;
  const codes = [...Object.keys(local?.capabilities || {}), ...Object.keys(cloud?.controls?.snapshot.status || {}), ...(definitions?.functions || []).map(fn => fn.code), ...(definitions?.status_range || []).map(fn => fn.code)];
  const climate = codes.some(code => /^(temperature|va_temperature|temp_current)$/.test(code))
    && codes.some(code => /^(humidity|va_humidity|humidity_value)$/.test(code))
    && !codes.some(code => /^switch(?:_|$)/.test(code));
  const cardLayout = climate && !isCamera(cloud?.category) ? 'climate' : undefined;
  return <Card id={deviceCardId(device.id)} className="device-card dashboard-device" data-card-layout={cardLayout} data-unavailable={!online || undefined} data-quick-sheet={hasSheet || undefined} aria-label={device.name} onClick={hasSheet ? event => openCard(event, showSheet) : undefined}>
    <DashboardCardHeader icon={<DeviceIcon category={cloud?.category} codes={codes} />} aliases={aliases}
      title={hasSheet ? <button type="button" className="device-card-sheet-trigger" ref={sheetTrigger}
        aria-haspopup="dialog" aria-expanded={quickOpen} aria-disabled={paused || quickBusy || undefined} onClick={showSheet}>{device.name}</button> : device.name}
      metadata={<><p className="device-location">{room}</p><div className="device-card-status tw:flex tw:max-w-full tw:flex-none tw:flex-wrap tw:items-center tw:gap-1.5 tw:text-[11px]"><span className={'presence ' + (online ? 'online' : '')}>{cloud ? (online ? t(MSG.ONLINE) : t(MSG.OFFLINE)) : local && !enabled ? t(MSG.DISABLED_IN_SETTINGS) : online ? t(MSG.AVAILABLE_LOCALLY) : t(MSG.STATUS_UNKNOWN)}</span><BatteryBadge reading={battery} /></div></>}
      actions={<><CardDetailsButton label={t(MSG.DETAILS)} disabled={quickBusy} onClick={() => onOpen(route)} />
        {!local && <button className="secondary tile-icon-action device-setup-action" aria-label={t(MSG.SET_UP_LOCAL_CONNECTION)} title={t(MSG.SET_UP_LOCAL_CONNECTION)} disabled={!onAdd || quickBusy} onClick={() => route !== 'local' && onAdd?.(route)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 9a15 15 0 0 1 18 0M6 13a10 10 0 0 1 12 0M9 17a5 5 0 0 1 6 0" /><circle cx="12" cy="21" r=".5" /></svg></button>}</>} />
    <DashboardCardFooter>
      <CardControls key={route} api={api} device={device} route={route} now={now} paused={paused} onAuthError={onAuthError} onBusy={notifyBusy} onStatus={updateStatus} sheet={{open:quickOpen, close:onQuickClose, trigger:sheetTrigger, onLightAvailable}} />
      {routes.length > 1 && <div className="device-card-footer tw:mt-2">
        <select className="device-route-select" aria-label={t(MSG.CONTROL_METHOD) + device.name} value={route} disabled={quickBusy} onChange={event => setChosen(event.target.value as DeviceRoute)}>{routes.map(value => <option key={value} value={value}>{routeLabel[value]}</option>)}</select>
      </div>}
    </DashboardCardFooter>
  </Card>;

}

export function ControlCenter({ dashboardPanel = null, api, ready, sharingReady = false, developerReady = false, onAuthError, onConnections }: {
  dashboardPanel?: DashboardPanel; api: HomeApi; ready: boolean; sharingReady?: boolean; developerReady?: boolean;
  onAuthError: () => void; onConnections?: () => void;
}) {
  const mask = `${sharingReady}:${developerReady}`;
  const [record, setRecord] = useState<Loaded | null>(null);
  // Hide records and controls immediately when the server/account selection changes.
  const current = ready && record?.api === api && record.mask === mask ? record : null;
  const inventory = current?.inventory;
  const cloud = current?.cloud || NO_CLOUD;
  const location = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const building = query.get('building') ?? '';
  const room = dashboardRoom(location.pathname, query);
  const search = query.get('q') ?? '';
  const requestedPage = Number(query.get('page') ?? 1);
  const deviceLink = readDeviceLink(location.pathname + location.search);
  const quick = Boolean(matchPath(quickPattern, location.pathname));
  const groupId = matchPath(groupPattern, location.pathname)?.params.groupId;
  const [revision, setRevision] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (dashboardPanel === 'search') searchInput.current?.focus(); }, [dashboardPanel]);
  function selectRoom(value: string) { query.delete('page'); void navigate(dashboardHref(value, query, dashboardPanel)); }
  function setBuilding(value: string) {
    if (value) query.set('building', value); else query.delete('building');
    selectRoom('');
  }
  function setSearch(value: string) {
    if (value) query.set('q', value); else query.delete('q');
    query.delete('page');
    void navigate(dashboardHref(room, query, dashboardPanel), { replace: true });
  }

  const topology = useTopology(api, ready && sharingReady, () => setRevision(value => value + 1), onAuthError);
  const placements = useMemo(() => new Map(topology.data?.placements.map(item => [item.device_id, item])), [topology.data]);
  function placementOf(device: UnifiedDevice) { return device.local || placements.get(device.id); }
  function roomName(device: UnifiedDevice) { return inventory?.rooms.find(item => item.id === placementOf(device)?.room_id)?.name || t(MSG.NO_ROOM); }
  const [busy, setBusy] = useState(false);
  const [survey, setSurvey] = useState<{ api: HomeApi; mask: string; key: string; value: Extract<Selection, { kind: 'survey' }> } | null>(null);
  const [groupStates, setGroupStates] = useState<Record<number, GroupState>>({});
  const dispatch = useAppDispatch();
  const identity = useAppSelector(state => state.deviceMetadata.devices);
  const now = useClock();
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController(); setBusy(true);
    setRecord(previous => previous?.api === api && previous.mask === mask ? { ...previous, errors: [] } : { api, mask, inventory: null, cloud: {}, errors: [] });
    const handle = async (label: string, read: () => Promise<Inventory | CloudDevice[]>, provider?: Provider) => {
      const scope = provider ? cloudAccountScope(api, provider) : undefined;
      const metadataRevision = nextDeviceMetadataRevision();
      try {
        const result = await read();
        if (controller.signal.aborted) return;
        if (provider && !Array.isArray(result)) throw new Error(t(MSG.THE_SERVICE_RETURNED_AN_UNEXPECTED_DEVICE_LIST));
        if (provider && scope !== undefined && Array.isArray(result)) {
          if (scope !== cloudAccountScope(api, provider)) return;
          const updates = result.map(device => {
            const definitions = device.controls?.definitions;
            const channelLabels = device.controls?.ready && definitions?.device_id === device.id && Array.isArray(definitions.functions)
              ? labelsFromCloudDefinitions(definitions) : undefined;
            return { key: cloudMetadataKey(scope, device.id), revision: metadataRevision, name: device.name ?? '', aliases: device.aliases, channelLabels };
          });
          if (updates.length) dispatch(cacheDeviceMetadata(updates));
        } else if (!Array.isArray(result) && result.devices.length) {
          dispatch(cacheDeviceMetadata(result.devices.map(device => ({
            key: localMetadataKey(api, device.id), revision: metadataRevision, name: device.name, aliases: device.aliases,
          }))));
        }
        setRecord(previous => previous?.api === api && previous.mask === mask ? {
          ...previous, ...(provider ? { cloud: { ...previous.cloud, [provider]: result as CloudDevice[] } } : { inventory: result as Inventory }),
        } : previous);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setRecord(previous => previous?.api === api && previous.mask === mask ? { ...previous, errors: [...previous.errors, label + ': ' + (failure instanceof Error ? failure.message : t(MSG.COULD_NOT_LOAD_DEVICES))] } : previous);
        if (failure instanceof ApiError && failure.status === 401) onAuthError();
      }
    };
    const requests = [handle(t(MSG.HOME_NETWORK), () => api.inventory(controller.signal))];
    if (sharingReady) requests.push(handle('Smart Life', () => api.devices('sharing', controller.signal), 'sharing'));
    if (developerReady) requests.push(handle('Tuya Developer', () => api.devices('developer', controller.signal), 'developer'));
    void Promise.all(requests).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, ready, mask, revision, dispatch]);
  const devices = useMemo(() => {
    function applyIdentity<T extends { name: string; aliases?: string[] }>(device: T, key: string): T {
      const stored = identity[key];
      return stored ? { ...device, name: stored.name?.value ?? device.name, aliases: stored.aliases?.value ?? device.aliases } : device;
    }
    const localDevices = (inventory?.devices ?? []).map(device => applyIdentity(device, localMetadataKey(api, device.id)));
    const cloudDevices: typeof cloud = {};
    for (const provider of ['sharing', 'developer'] as const) {
      const scope = cloudAccountScope(api, provider);
      cloudDevices[provider] = cloud[provider]?.map(device => applyIdentity(device, cloudMetadataKey(scope, device.id)));
    }
    return mergeDevices(localDevices, cloudDevices);
  }, [api, inventory, cloud, identity]);
  const linked = deviceLink ? devices.find(device => device.id === deviceLink.id) : undefined;
  const linkedRoute = linked ? deviceLink?.route || deviceRoutes(linked)[0] : undefined;
  const validRoute = linked && linkedRoute && deviceRoutes(linked).includes(linkedRoute) ? linkedRoute : undefined;
  const linkError = deviceLink && ready && current && !busy ? !linked ? t(MSG.THE_LINKED_DEVICE_WAS_NOT_FOUND_IN_THE) : linkedRoute && !deviceRoutes(linked).includes(linkedRoute) ? t(MSG.THE_CONTROL_METHOD_IN_THIS_LINK_IS_UNAVAILABLE) : '' : '';
  const group = inventory?.groups.find(item => String(item.id) === groupId);
  const parent = inventory?.groups.find(item => String(item.id) === query.get('group') && linked?.local && item.device_ids.includes(linked.local.id));
  const activeSurvey = ready && survey?.api === api && survey.mask === mask && survey.key === location.key ? survey.value : null;
  const selected: Selection | null = activeSurvey ?? (!quick && linked && validRoute ? { kind: 'device', device: linked, route: validRoute, parent }
    : group ? { kind: 'group', group } : null);
  const detailDevice = selected?.kind === 'device' ? selected.device : undefined;
  const detailsOpen = selected !== null;
  useEffect(() => {
    if (!detailsOpen) return;
    dispatch(setDetailsOpen(true));
    return () => { dispatch(setDetailsOpen(false)); };
  }, [detailsOpen, dispatch]);
  const filteredRooms = inventory?.rooms.filter(item => !building || String(item.building_id) === building) || [];
  const entries = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const inRoom = (id: number | null) => !room || (room === 'none' ? id === null : String(id) === room);
    const filtered = devices.filter(device => (!building || String(placementOf(device)?.building_id) === building) && inRoom(placementOf(device)?.room_id ?? null) && matchesDevice(device, needle));
    const groups = inventory?.groups.filter(group => inRoom(group.room_id) && (!building || String(inventory.rooms.find(item => item.id === group.room_id)?.building_id) === building) && group.name.toLocaleLowerCase().includes(needle)) || [];
    return [...groups.map(group => ({ kind: 'group' as const, group })), ...filtered.map(device => ({ kind: 'device' as const, device }))];
  }, [devices, inventory, building, room, search, placements]);
  const linkedIndex = entries.findIndex(entry => entry.kind === 'device' ? entry.device === linked : entry.group === group);
  const page = linkedIndex >= 0 ? Math.floor(linkedIndex / PAGE_SIZE)
    : Number.isSafeInteger(requestedPage) ? Math.min(Math.max(requestedPage - 1, 0), Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1)) : 0;
  const visible = useMemo(() => {
    const pageEntries = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    // A copied quick link can outlive the device's room assignment or alias.
    return quick && linked && validRoute && linkedIndex < 0 ? [{ kind: 'device' as const, device: linked }, ...pageEntries] : pageEntries;
  }, [entries, page, quick, linked, validRoute, linkedIndex]);
  useEffect(() => {
    const controller = new AbortController();
    setGroupStates({});
    // Initial list reads use SQLite only. Visible card controls separately
    // renew background watches; list loading never requests per-device cloud details.
    for (const entry of visible) {
      const local = entry.kind === 'device' ? entry.device.local : undefined;
      if (entry.kind === 'device' && !local) continue;
      const request = entry.kind === 'group' ? api.groupState(entry.group.id, controller.signal)
        : dispatch(readLocalDevice(api, local!.id, false, controller.signal));
      void request.then(value => {
        if (controller.signal.aborted) return;
        if ('group_id' in value) setGroupStates(current => ({ ...current, [value.group_id]: value }));
      }).catch(failure => { if (!controller.signal.aborted && failure instanceof ApiError && failure.status === 401) onAuthError(); });
    }
    return () => controller.abort();
  }, [api, dispatch, visible]);
  function setPage(value: number) {
    if (value > 0) query.set('page', String(value + 1)); else query.delete('page');
    void navigate(dashboardHref(room, query, dashboardPanel));
  }
  function overlayHref(path: string, route?: DeviceRoute, group?: Group) {
    const params = new URLSearchParams(query);
    if (room) params.set('room', room);
    if (dashboardPanel) params.set('panel', dashboardPanel);
    if (route) params.set('route', route); else params.delete('route');
    if (group) params.set('group', String(group.id)); else params.delete('group');
    return withQuery(path, params);
  }
  function openOverlay(href: string) {
    if (href !== location.pathname + location.search) void navigate(href, { state: { dashboardOverlay: true } });
  }
  function choose(value: Selection) {
    if (value.kind === 'survey') { setSurvey({ api, mask, key: location.key, value }); return; }
    setSurvey(null);
    if (value.kind === 'device') openOverlay(overlayHref(devicePath(value.device.id), value.route, value.parent));
    else openOverlay(overlayHref('/groups/' + value.group.id));
  }
  function closeOverlay() {
    if (location.state?.dashboardOverlay) { void navigate(-1); return; }
    if (parent) { void navigate(overlayHref('/groups/' + parent.id), { replace: true }); return; }
    if (page > 0) query.set('page', String(page + 1));
    void navigate(dashboardHref(room, query, dashboardPanel), { replace: true });
  }
  function close() {
    if (activeSurvey) setSurvey(null); else closeOverlay();
    setRevision(value => value + 1);
  }
  if (activeSurvey && inventory) {
    const { device, existing, provider } = activeSurvey;

    function reopenLocalDevice(local: LocalDevice) {
      const [mergedDevice] = mergeDevices([local], cloud);
      choose({ kind: 'device', device: mergedDevice, route: 'local' });
    }

    function closeSurvey() {
      if (existing) reopenLocalDevice(existing);
      else close();
    }

    function saveSurvey(saved: LocalDevice) {
      setRevision(value => value + 1);
      reopenLocalDevice(saved);
    }

    return <DeviceSurvey
      api={api}
      inventory={inventory}
      device={device}
      existing={existing}
      provider={provider}
      cloudDevices={provider ? cloud[provider] : undefined}
      gatewayPlacements={Array.from(placements.values())}
      placement={device ? placements.get(device.id) : undefined}
      onClose={closeSurvey}
      onSaved={existing ? saveSurvey : undefined}
      onAuthError={onAuthError}
    />;
  }
  return <section className="card control-center" aria-labelledby="control-center-heading">
    <div className="card-heading">
      <div><p className="eyebrow">{t(MSG.YOUR_HOME)}</p><h2 id="control-center-heading">{t(MSG.DEVICES_AND_GROUPS)}{current && <span className="count">{devices.length + (inventory?.groups.length || 0)}</span>}</h2></div>
      <div className="survey-toolbar dashboard-actions">
        <button className="secondary compact" disabled={!inventory || busy} aria-label={t(MSG.SET_UP_LOCAL_DEVICE)} title={t(MSG.SET_UP_LOCAL_DEVICE)} onClick={() => choose({ kind: 'survey' })}>
          <svg className="dashboard-action-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          <span>{t(MSG.SET_UP_LOCAL_DEVICE)}</span>
        </button>
        <button className="secondary compact" disabled={!ready || busy} aria-label={t(MSG.REFRESH_LIST)} title={t(MSG.REFRESH_LIST)} onClick={() => setRevision(value => value + 1)}>
          <svg className="dashboard-action-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 4v5h-5M20 9a8 8 0 1 0 0 6" /></svg>
          <span>{t(MSG.REFRESH_LIST)}</span>
        </button>
      </div>
    </div>
    {!ready ? <p className="saved-summary">{t(MSG.SAVE_SERVICE_ACCESS_IN_CONNECTION_SETTINGS_FIRST)}</p> : <>
      {linkError && <p className="field-error" role="alert">{linkError}</p>}
      <div className="dashboard-room-chips" role="group" aria-label={t(MSG.ALL_ROOMS)}>
        <button type="button" className="secondary" aria-pressed={!room} onClick={() => selectRoom('')}>{t(MSG.ALL)}</button>
        {filteredRooms.map(item => <button type="button" key={item.id} className="secondary" aria-pressed={room === String(item.id)} onClick={() => selectRoom(String(item.id))}>{item.name}</button>)}
        <button type="button" className="secondary" aria-pressed={room === 'none'} onClick={() => selectRoom('none')}>{t(MSG.NO_ROOM)}</button>
      </div>
      <p className="help dashboard-intro">{t(MSG.MAIN_CONTROLS_ARE_AVAILABLE_HERE)}</p>
      {sharingReady && <div className="topology-summary">
        <div><h3>{t(MSG.ROOMS_FROM_SMART_LIFE)}</h3><p className={topology.busy ? 'help' : 'help topology-note'}>{topology.busy ? t(MSG.LOADING_HOME_STRUCTURE, [topology.data?.job.processed || 0, topology.data?.job.total || '…']) : topology.data?.synced_at ? t(MSG.SYNCED) + new Date(topology.data.synced_at).toLocaleString(dateLocale()) : t(MSG.BUILDINGS_AND_ROOMS_WILL_BE_USED_IN_DEVICE)}</p></div>
        <button className="secondary compact" disabled={topology.busy} onClick={() => void topology.sync()}>{t(MSG.SYNC_SMART_LIFE)}</button>
        {topology.busy && <p role="status" className="help">{t(MSG.SYNCHRONIZATION_RUNS_IN_THE_BACKGROUND)}</p>}
        {(topology.error || topology.data?.job.message) && <p role="alert" className="field-error">{topology.error || topology.data?.job.message}</p>}
        {Boolean(topology.data?.warnings) && <p className="help">{t(MSG.MANUAL_SETTINGS_WERE_PRESERVED_OR_PLACEMENT_LIMITATIONS_WERE) + " "}{topology.data?.warnings}{t(MSG.CHECK_THE_RELEVANT_DEVICES_ROOMS)}</p>}
        <p className="help topology-note">{t(MSG.SMART_LIFE_DOES_NOT_RETURN_EMPTY_ROOMS_IN)}</p>
      </div>}
      <div className="control-filters"><label>{t(MSG.BUILDING)}<select value={building} onChange={event => setBuilding(event.target.value)}><option value="">{t(MSG.ALL_BUILDINGS)}</option>{inventory?.buildings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>{t(MSG.ROOM)}<select value={room} onChange={event => selectRoom(event.target.value)}><option value="">{t(MSG.ALL_ROOMS)}</option><option value="none">{t(MSG.NO_ROOM)}</option>{filteredRooms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label id="dashboard-search" className="dashboard-search-field"><span>{t(MSG.SEARCH_BY_NAME_ALIAS_OR_ID)}</span><input ref={searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t(MSG.FIND_A_DEVICE_OR_GROUP)} /></label></div>
      {busy && <p role="status" className="help">{t(MSG.LOADING_LIST)}</p>}{current?.errors.map(error => <p key={translateText(error)} role="alert" className="field-error">{translateText(error)}</p>)}
      {!busy && current && !entries.length && <div className="empty-state"><h3>{devices.length || inventory?.groups.length ? t(MSG.NOTHING_FOUND) : t(MSG.NO_DEVICES_YET)}</h3><p>{devices.length || inventory?.groups.length ? t(MSG.CHANGE_YOUR_FILTERS_OR_SEARCH_QUERY) : sharingReady || developerReady ? t(MSG.ADD_DEVICES_IN_SMART_LIFE_AND_REFRESH_THE) : t(MSG.CONNECT_A_TUYA_ACCOUNT_TO_SEE_YOUR_DEVICES)}</p>{!devices.length && !sharingReady && !developerReady && onConnections && <button className="secondary compact" onClick={onConnections}>{t(MSG.SET_UP_CONNECTION)}</button>}</div>}
      <ul className="dashboard-device-grid tw:m-0 tw:grid tw:list-none tw:grid-cols-[repeat(auto-fill,minmax(min(100%,264px),1fr))] tw:items-start tw:gap-3 tw:p-0 tw:max-[600px]:gap-2">{visible.map(entry => entry.kind === 'group' ? <Card className="device-card dashboard-device" key={'group-' + entry.group.id} aria-label={entry.group.name} onClick={event=>openCard(event,()=>choose(entry))}>
        <DashboardCardHeader title={entry.group.name}
          icon={<svg className="device-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>}
          metadata={<><span className="device-location">{t(MSG.GROUP)} {entry.group.device_ids.length} {t(MSG.DEVICES)}</span>
            <span className="device-location">{t(MSG.ON_YOUR_HOME_NETWORK)}</span></>}
          actions={<CardDetailsButton label={t(MSG.OPEN_GROUP)} onClick={() => choose(entry)} />} />
        <DashboardCardFooter>
          <p className="dashboard-group-reading">{groupStates[entry.group.id] ? groupSummary(groupStates[entry.group.id].members, now) : t(MSG.STATUS_UNKNOWN)}</p>
        </DashboardCardFooter>
      </Card> : <DeviceCard key={'device-' + entry.device.id} api={api} device={entry.device} room={roomName(entry.device)} now={now} paused={Boolean(selected)}
        quickRoute={quick && entry.device === linked ? validRoute : undefined} onAuthError={onAuthError} onOpen={route => choose({ ...entry, route })}
        onQuickOpen={route => openOverlay(overlayHref(devicePath(entry.device.id, true), route))} onQuickClose={closeOverlay}
        onAdd={inventory && !busy && (!sharingReady || topology.data || topology.error) ? provider => choose({ kind: 'survey', device: entry.device.cloud[provider], provider }) : undefined} />)}</ul>
      {entries.length > PAGE_SIZE && <div className="pagination"><button className="secondary compact" disabled={page === 0} onClick={() => setPage(page - 1)}>{t(MSG.BACK)}</button><span>{page + 1} / {Math.ceil(entries.length / PAGE_SIZE)}</span><button className="secondary compact" disabled={(page + 1) * PAGE_SIZE >= entries.length} onClick={() => setPage(page + 1)}>{t(MSG.NEXT)}</button></div>}
    </>}
    {selected?.kind === 'device' && selected.route === 'local' && detailDevice?.local && <LocalControl room={roomName(detailDevice)} key={detailDevice.local.id} api={api} device={detailDevice.local} onAuthError={onAuthError} onSetup={inventory ? () => {
      const provider = detailDevice.cloud.sharing ? 'sharing' : detailDevice.cloud.developer ? 'developer' : undefined;
      choose({ kind: 'survey', existing: detailDevice.local, provider, device: provider ? detailDevice.cloud[provider] : undefined });
    } : undefined} closeLabel={selected.parent ? t(MSG.BACK_TO_GROUP) : undefined} onClose={close} />}
    {selected?.kind === 'device' && selected.route !== 'local' && detailDevice?.cloud[selected.route] && <CloudControl room={roomName(detailDevice)} localTransport={detailDevice.local?.transport} localDeviceId={detailDevice.local?.id} key={selected.route + detailDevice.id} api={api} device={{ ...detailDevice.cloud[selected.route]!, name: detailDevice.name }} devices={cloud[selected.route]} provider={selected.route} onClose={close} onAuthError={onAuthError} />}
    {selected?.kind === 'group' && <GroupControl key={selected.group.id} api={api} group={selected.group} onAuthError={onAuthError} onClose={close} onDevice={device => choose({ kind: 'device', device: mergeDevices([device], cloud)[0], route: 'local', parent: selected.group })} />}
  </section>;
}
