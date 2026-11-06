import { MSG, dateLocale, t, translateText } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { MouseEvent, ReactNode } from 'react';
import { deviceCardId } from '../device-links';
import { selectCommandPending, setCommandPending, setDetailsOpen, useAppDispatch, useAppSelector } from '../store';
import { readLocalDevice } from '../local-device-cache';
import { useLocalDeviceState } from '../use-local-device-state';
import type { DeviceLink } from '../device-links';

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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
  </button>;
}

function DashboardCardHeader({ icon, title, aliases, metadata, actions }: {
  icon: ReactNode; title: ReactNode; aliases?: string[]; metadata: ReactNode; actions: ReactNode;
}) {
  return <header className="dashboard-card-header" data-slot="card-header">
    <span className="device-symbol" aria-hidden="true">{icon}</span>
    <div className="device-card-identity">
      <div className="device-card-title"><h3>{title}</h3>
        {!!aliases?.length && <div className="capability-aliases" role="group" aria-label={t(MSG.DEVICE_ALIASES)}>
          {aliases.map(alias => <span className="alias-tag" title={alias} key={alias}>{alias}</span>)}
        </div>}
      </div>
      <div className="device-card-context">{metadata}</div>
    </div>
    <div className="device-card-actions">{actions}</div>
  </header>;
}

function DashboardCardFooter({ children }: { children: ReactNode }) {
  return <footer className="dashboard-card-footer" data-slot="card-footer">{children}</footer>;
}

function DeviceCard({ api, device, room, now, paused, onAuthError, onOpen, onAdd }: {
  api: HomeApi; device: UnifiedDevice; room: string; now: number; paused: boolean; onAuthError: () => void; onOpen: (route: DeviceRoute) => void; onAdd?: (provider: Provider) => void;
}) {
  const state = useLocalDeviceState(api, device.local?.id);
  const routes = deviceRoutes(device);
  const [chosen, setChosen] = useState<DeviceRoute | null>(null);
  const dispatch = useAppDispatch();
  const quickBusy = useAppSelector(state => selectCommandPending(state, device.id));
  const [quickOpen, setQuickOpen] = useState(false);
  const [lightSheet, setLightSheet] = useState<{route:DeviceRoute;available:boolean}>();
  const sheetTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (paused) setQuickOpen(false); }, [paused]);
  const notifyBusy = useCallback((pending: boolean) => {
    dispatch(setCommandPending({ deviceId: device.id, pending }));
  }, [device.id, dispatch]);
  const route = chosen && routes.includes(chosen) ? chosen : routes[0];
  const [liveStatus,setLiveStatus] = useState<{route:DeviceRoute;status:CardStatus}>();
  const updateStatus = useCallback((status:CardStatus)=>setLiveStatus({route,status}),[route]);
  const live = liveStatus?.route === route ? liveStatus.status : undefined;
  const cloud = route !== 'local' ? device.cloud[route] : undefined;
  const hasSheet = isCamera(cloud?.category) || (lightSheet?.route === route && lightSheet.available);
  const onLightAvailable = useCallback((available:boolean) => setLightSheet({route,available}), [route]);
  const showSheet = () => { if (!paused && !quickBusy && hasSheet) setQuickOpen(true); };
  const local = device.local;
  const initialBattery = cloud?.battery || (local && state ? batteryFromSpecs(Object.entries(local.capabilities).map(([key,cap]) => localSpec(key,cap)),Object.fromEntries(Object.entries(state.values).filter(([,reading]) => reading.known).map(([key,reading]) => [key,reading.value]))) : undefined);
  const battery = live ? live.battery : initialBattery;
  const online = live ? live.online : cloud?.online || (route === 'local' && state?.available);
  const enabled = (route === 'local' ? state?.enabled : undefined) ?? local?.enabled;
  const definitions = cloud?.controls?.definitions;
  const codes = [...Object.keys(local?.capabilities || {}), ...Object.keys(cloud?.controls?.snapshot.status || {}), ...(definitions?.functions || []).map(fn => fn.code), ...(definitions?.status_range || []).map(fn => fn.code)];
  const climate = codes.some(code => /^(temperature|va_temperature|temp_current)$/.test(code))
    && codes.some(code => /^(humidity|va_humidity|humidity_value)$/.test(code))
    && !codes.some(code => /^switch(?:_|$)/.test(code));
  const cardLayout = climate && !isCamera(cloud?.category) ? 'climate' : undefined;
  return <Card id={deviceCardId(device.id)} className="device-card dashboard-device" data-card-layout={cardLayout} data-quick-sheet={hasSheet || undefined} aria-label={device.name} onClick={hasSheet ? event => openCard(event, showSheet) : undefined}>
    <DashboardCardHeader icon={<DeviceIcon category={cloud?.category} codes={codes} />} aliases={deviceAliases(device)}
      title={hasSheet ? <button type="button" className="device-card-sheet-trigger" ref={sheetTrigger}
        aria-haspopup="dialog" aria-expanded={quickOpen} aria-disabled={paused || quickBusy || undefined} onClick={showSheet}>{device.name}</button> : device.name}
      metadata={<><p className="device-location">{room}</p><div className="device-card-status tw:flex tw:max-w-full tw:flex-none tw:flex-wrap tw:items-center tw:gap-1.5 tw:text-[11px]"><span className={'presence ' + (online ? 'online' : '')}>{cloud ? (online ? t(MSG.ONLINE) : t(MSG.OFFLINE)) : local && !enabled ? t(MSG.DISABLED_IN_SETTINGS) : online ? t(MSG.AVAILABLE_LOCALLY) : t(MSG.STATUS_UNKNOWN)}</span><BatteryBadge reading={battery} /></div></>}
      actions={<><CardDetailsButton label={t(MSG.DETAILS)} disabled={quickBusy} onClick={() => onOpen(route)} />
        {!local && <button className="secondary tile-icon-action device-setup-action" aria-label={t(MSG.SET_UP_LOCAL_CONNECTION)} title={t(MSG.SET_UP_LOCAL_CONNECTION)} disabled={!onAdd || quickBusy} onClick={() => route !== 'local' && onAdd?.(route)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 9a15 15 0 0 1 18 0M6 13a10 10 0 0 1 12 0M9 17a5 5 0 0 1 6 0" /><circle cx="12" cy="21" r=".5" /></svg></button>}</>} />
    <DashboardCardFooter>
      <CardControls key={route} api={api} device={device} route={route} now={now} paused={paused} onAuthError={onAuthError} onBusy={notifyBusy} onStatus={updateStatus} sheet={{open:quickOpen, close:() => setQuickOpen(false), trigger:sheetTrigger, onLightAvailable}} />
      {routes.length > 1 && <div className="device-card-footer tw:mt-2">
        <select className="device-route-select" aria-label={t(MSG.CONTROL_METHOD) + device.name} value={route} disabled={quickBusy} onChange={event => { setQuickOpen(false); setChosen(event.target.value as DeviceRoute); }}>{routes.map(value => <option key={value} value={value}>{routeLabel[value]}</option>)}</select>
      </div>}
    </DashboardCardFooter>
  </Card>;

}

export function ControlCenter({ dashboardPanel = null, api, ready, sharingReady = false, developerReady = false, onAuthError, onConnections, deviceLink, onDeviceLinkChange }: {
  dashboardPanel?: 'search' | 'tools' | null; api: HomeApi; ready: boolean; sharingReady?: boolean; developerReady?: boolean;
  onAuthError: () => void; onConnections?: () => void;
  deviceLink?: DeviceLink | null; onDeviceLinkChange?: (target: DeviceLink | null) => void;
}) {
  const mask = `${sharingReady}:${developerReady}`;
  const [record, setRecord] = useState<Loaded | null>(null);
  // Hide records and controls immediately when the server/account selection changes.
  const current = ready && record?.api === api && record.mask === mask ? record : null;
  const inventory = current?.inventory;
  const cloud = current?.cloud || NO_CLOUD;
  const [building, setBuilding] = useState(''), [room, setRoom] = useState(''), [search, setSearch] = useState('');
  const [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const previousPanel = useRef(dashboardPanel);
  useEffect(() => {
    if (dashboardPanel === 'search') searchInput.current?.focus();
    else if (previousPanel.current === 'search') { setSearch(''); setPage(0); }
    previousPanel.current = dashboardPanel;
  }, [dashboardPanel]);
  function selectRoom(value: string) { setRoom(value); setPage(0); }

  const topology = useTopology(api, ready && sharingReady, () => setRevision(value => value + 1), onAuthError);
  const placements = useMemo(() => new Map(topology.data?.placements.map(item => [item.device_id, item])), [topology.data]);
  function location(device: UnifiedDevice) { return device.local || placements.get(device.id); }
  function roomName(device: UnifiedDevice) { return inventory?.rooms.find(item => item.id === location(device)?.room_id)?.name || t(MSG.NO_ROOM); }
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<{ api: HomeApi; mask: string; value: Selection } | null>(null);
  const selected = ready && selection?.api === api && selection.mask === mask ? selection.value : null;
  const activeLink = useRef<string | null>(null);
  const [groupStates, setGroupStates] = useState<Record<number, GroupState>>({});
  const dispatch = useAppDispatch();
  const now = useClock();
  const detailsOpen = selected !== null;
  useEffect(() => {
    if (!detailsOpen) return;
    dispatch(setDetailsOpen(true));
    return () => { dispatch(setDetailsOpen(false)); };
  }, [detailsOpen, dispatch]);
  useEffect(() => { setSelection(null); activeLink.current = null; }, [api, ready, mask]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController(); setBusy(true); setPage(0);
    setRecord(previous => previous?.api === api && previous.mask === mask ? { ...previous, errors: [] } : { api, mask, inventory: null, cloud: {}, errors: [] });
    const handle = async (label: string, read: () => Promise<Inventory | CloudDevice[]>, provider?: Provider) => {
      try {
        const result = await read();
        if (controller.signal.aborted) return;
        if (provider && !Array.isArray(result)) throw new Error(t(MSG.THE_SERVICE_RETURNED_AN_UNEXPECTED_DEVICE_LIST));
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
  }, [api, ready, mask, revision]);
  const devices = useMemo(() => mergeDevices(inventory?.devices || [], cloud), [inventory, cloud]);
  const linked = deviceLink ? devices.find(device => device.id === deviceLink.id) : undefined;
  const linkedRoute = linked ? deviceLink?.route || deviceRoutes(linked)[0] : undefined;
  const linkError = deviceLink && ready && current && !busy ? !linked ? t(MSG.THE_LINKED_DEVICE_WAS_NOT_FOUND_IN_THE) : linkedRoute && !deviceRoutes(linked).includes(linkedRoute) ? t(MSG.THE_CONTROL_METHOD_IN_THIS_LINK_IS_UNAVAILABLE) : '' : '';
  useEffect(() => {
    if (!deviceLink) {
      if (activeLink.current && selected?.kind === 'device') setSelection(null);
      activeLink.current = null; return;
    }
    if (!ready || busy || !current || !linked || !linkedRoute || linkError) return;
    const key = deviceLink.id + ':' + linkedRoute;
    if (activeLink.current === key && selected?.kind === 'device' && selected.device.id === linked.id && selected.route === linkedRoute) return;
    activeLink.current = key;
    if (selected?.kind === 'device' && selected.device.id === linked.id && selected.route === linkedRoute) return;
    setBuilding(''); setRoom(''); setSearch('');
    setPage(Math.floor(((inventory?.groups.length || 0) + devices.indexOf(linked)) / PAGE_SIZE));
    setSelection({ api, mask, value: { kind: 'device', device: linked, route: linkedRoute } });
  }, [deviceLink, ready, busy, current, linked, linkedRoute, linkError, selected, api, mask, devices, inventory]);
  const filteredRooms = inventory?.rooms.filter(item => !building || String(item.building_id) === building) || [];
  const entries = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const inRoom = (id: number | null) => !room || (room === 'none' ? id === null : String(id) === room);
    const filtered = devices.filter(device => (!building || String(location(device)?.building_id) === building) && inRoom(location(device)?.room_id ?? null) && matchesDevice(device, needle));
    const groups = inventory?.groups.filter(group => inRoom(group.room_id) && (!building || String(inventory.rooms.find(item => item.id === group.room_id)?.building_id) === building) && group.name.toLocaleLowerCase().includes(needle)) || [];
    return [...groups.map(group => ({ kind: 'group' as const, group })), ...filtered.map(device => ({ kind: 'device' as const, device }))];
  }, [devices, inventory, building, room, search, placements]);
  const visible = useMemo(() => entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [entries, page]);
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
  function choose(value: Selection) {
    setSelection({ api, mask, value });
    onDeviceLinkChange?.(value.kind === 'device' ? { id: value.device.id, route: value.route } : null);
  }
  function close() { setSelection(null); onDeviceLinkChange?.(null); setRevision(value => value + 1); }
  function updateChannelControls(provider: Provider, controls: NonNullable<CloudDevice['controls']>) {
    setRecord(previous => {
      const providerDevices = previous?.cloud[provider];
      if (previous?.api !== api || previous.mask !== mask || !providerDevices) return previous;
      return { ...previous, cloud: { ...previous.cloud, [provider]: providerDevices.map(device =>
        device.id === controls.definitions.device_id ? {
          ...device, controls: { ...controls, snapshot: device.controls?.snapshot ?? controls.snapshot },
        } : device,
      ) } };
    });
  }
  if (selected?.kind === 'survey' && inventory) return <DeviceSurvey api={api} inventory={inventory} device={selected.device} existing={selected.existing} provider={selected.provider} cloudDevices={selected.provider ? cloud[selected.provider] : undefined} gatewayPlacements={Array.from(placements.values())} placement={selected.device ? placements.get(selected.device.id) : undefined} onClose={() => selected.existing ? choose({ kind: 'device', device: mergeDevices([selected.existing], cloud).find(row => row.id === selected.existing!.device_id)!, route: 'local' }) : close()} onSaved={selected.existing ? saved => { setRevision(value => value + 1); choose({ kind: 'device', device: mergeDevices([saved], cloud).find(row => row.id === saved.device_id)!, route: 'local' }); } : undefined} onAuthError={onAuthError} />;
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
      <div className="control-filters"><label>{t(MSG.BUILDING)}<select value={building} onChange={event => { setBuilding(event.target.value); setRoom(''); setPage(0); }}><option value="">{t(MSG.ALL_BUILDINGS)}</option>{inventory?.buildings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>{t(MSG.ROOM)}<select value={room} onChange={event => selectRoom(event.target.value)}><option value="">{t(MSG.ALL_ROOMS)}</option><option value="none">{t(MSG.NO_ROOM)}</option>{filteredRooms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label id="dashboard-search" className="dashboard-search-field"><span>{t(MSG.SEARCH_BY_NAME_ALIAS_OR_ID)}</span><input ref={searchInput} type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder={t(MSG.FIND_A_DEVICE_OR_GROUP)} /></label></div>
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
      </Card> : <DeviceCard key={'device-' + entry.device.id} api={api} device={entry.device} room={roomName(entry.device)} now={now} paused={Boolean(selected)} onAuthError={onAuthError} onOpen={route => choose({ ...entry, route })} onAdd={inventory && !busy && (!sharingReady || topology.data || topology.error) ? provider => choose({ kind: 'survey', device: entry.device.cloud[provider], provider }) : undefined} />)}</ul>
      {entries.length > PAGE_SIZE && <div className="pagination"><button className="secondary compact" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t(MSG.BACK)}</button><span>{page + 1} / {Math.ceil(entries.length / PAGE_SIZE)}</span><button className="secondary compact" disabled={(page + 1) * PAGE_SIZE >= entries.length} onClick={() => setPage(value => value + 1)}>{t(MSG.NEXT)}</button></div>}
    </>}
    {selected?.kind === 'device' && selected.route === 'local' && selected.device.local && <LocalControl room={roomName(selected.device)} key={selected.device.local.id} api={api} device={selected.device.local} onAuthError={onAuthError} onSetup={inventory ? () => {
      const provider = selected.device.cloud.sharing ? 'sharing' : selected.device.cloud.developer ? 'developer' : undefined;
      choose({ kind: 'survey', existing: selected.device.local, provider, device: provider ? selected.device.cloud[provider] : undefined });
    } : undefined} closeLabel={selected.parent ? t(MSG.BACK_TO_GROUP) : undefined} onClose={() => selected.parent ? choose({ kind: 'group', group: selected.parent }) : close()} />}
    {selected?.kind === 'device' && selected.route !== 'local' && selected.device.cloud[selected.route] && <CloudControl room={roomName(selected.device)} localTransport={selected.device.local?.transport} key={selected.route + selected.device.id} api={api} device={{ ...selected.device.cloud[selected.route]!, name: selected.device.name }} devices={cloud[selected.route]} provider={selected.route} onClose={close} onAuthError={onAuthError} onChannelLabelsSaved={updateChannelControls} />}
    {selected?.kind === 'group' && <GroupControl key={selected.group.id} api={api} group={selected.group} onAuthError={onAuthError} onClose={close} onDevice={device => choose({ kind: 'device', device: mergeDevices([device], cloud)[0], route: 'local', parent: selected.group })} />}
  </section>;
}
