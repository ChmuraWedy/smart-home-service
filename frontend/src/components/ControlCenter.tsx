import { MSG, t, translateText } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../api';
import type { CloudDevice, Provider } from '../api';
import { localSpec } from '../controls';
import { deviceAliases, deviceRoutes, matchesDevice, mergeDevices, routeLabel } from '../devices';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import { HomeApi } from '../home-api';
import type { CombinedDevice, Group, GroupState, Inventory, LocalDevice } from '../home-api';
import { CloudControl } from './CloudControl';
import CombinedDeviceCard from './CombinedDeviceCard';
import { CombinedDeviceDetails, CombinedDeviceSettings } from './CombinedDeviceSettings';
import { GroupControl, LocalControl, groupSummary } from './LocalControls';
import { useClock } from './DeviceControls';
import { DeviceSurvey } from './DeviceSurvey';
import { BatteryBadge, batteryFromSpecs, DeviceIcon, isCamera } from './DevicePresentation';
import { useTopology } from '../use-topology';
import { TopologySummary } from './TopologySummary';
import RoomNavigation from './RoomNavigation';
import type { CardStatus } from './CardControls';
import { CardControls } from './CardControls';
import { Card } from './ui/card';
import { Icon } from './ui/icon';
import { CardDetailsButton, DashboardCardHeader } from './DashboardCardHeader';
import DashboardCardFooter from './DashboardCardFooter';
import DashboardGrid from './DashboardGrid';
import type { GridCardPlacement } from './DashboardGrid';
import type { MouseEvent } from 'react';
import { deviceCardId, devicePath, readDeviceLink } from '../device-links';
import {
  combinationEditPattern, combinationNewPath, combinationPattern, combinationQuickPattern, dashboardHref, dashboardRoom, groupPattern, quickPattern, withQuery,
} from '../navigation';
import type { DashboardPanel } from '../navigation';
import { selectCommandPending, setCommandPending, setDetailsOpen, useAppDispatch, useAppSelector } from '../store';
import { readLocalDevice } from '../local-device-cache';
import { cloudAccountScope } from '../cloud-account-scope';
import { cacheDeviceMetadata, cloudMetadataKey, labelsFromCloudDefinitions, localMetadataKey, nextDeviceMetadataRevision } from '../device-metadata';
import { useLocalDeviceState } from '../use-local-device-state';

type Selection = { kind: 'group'; group: Group } | { kind: 'device'; device: UnifiedDevice; route: DeviceRoute; parent?: Group; combinedParent?: CombinedDevice } | { kind: 'survey'; device?: CloudDevice; provider?: Provider; existing?: LocalDevice };
type DashboardEntry = { kind: 'group'; group: Group } | { kind: 'device'; device: UnifiedDevice } | { kind: 'combined'; combined: CombinedDevice };
type Loaded = { api: HomeApi; mask: string; inventory: Inventory | null; combinations?: CombinedDevice[]; cloud: Partial<Record<Provider, CloudDevice[]>>; errors: string[] };
const PAGE_SIZE = 24;
const NO_COMBINATIONS: CombinedDevice[] = [];
const NO_CLOUD: Partial<Record<Provider, CloudDevice[]>> = {};

function openCard(event:MouseEvent<HTMLLIElement>,open:()=>void) {
  if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest('button,a,input,select,textarea,label,summary,video,audio,[role="button"],[role="switch"],[contenteditable="true"],.camera-live') || window.getSelection()?.toString()) return;
  open();
}

function DeviceCard({ api, device, room, now, paused, quickRoute, onAuthError, onOpen, onQuickOpen, onQuickClose, onAdd, placement }: {
  api: HomeApi; device: UnifiedDevice; room: string; now: number; paused: boolean; onAuthError: () => void; onOpen: (route: DeviceRoute) => void; onAdd?: (provider: Provider) => void;
  quickRoute?: DeviceRoute; onQuickOpen: (route: DeviceRoute) => void; onQuickClose: () => void; placement: GridCardPlacement;
}) {
  const state = useLocalDeviceState(api, device.local?.id);
  const aliases = useMemo(() => deviceAliases(device), [device]);
  const routes = deviceRoutes(device);
  const [chosen, setChosen] = useState<DeviceRoute | null>(null);
  const dispatch = useAppDispatch();
  const quickBusy = useAppSelector(state => selectCommandPending(state, device.id));
  const quickOpen = quickRoute !== undefined;
  const [lightFeatures, setLightFeatures] = useState<{ route: DeviceRoute; hasQuickSettings: boolean; hasPresets: boolean }>();
  const sheetTrigger = useRef<HTMLButtonElement>(null);
  const notifyBusy = useCallback((pending: boolean) => {
    dispatch(setCommandPending({ deviceId: device.id, pending }));
  }, [device.id, dispatch]);
  const route = quickRoute ?? (chosen && routes.includes(chosen) ? chosen : routes[0]);
  const [liveStatus,setLiveStatus] = useState<{route:DeviceRoute;status:CardStatus}>();
  const updateStatus = useCallback((status:CardStatus)=>setLiveStatus({route,status}),[route]);
  const live = liveStatus?.route === route ? liveStatus.status : undefined;
  const cloud = route !== 'local' ? device.cloud[route] : undefined;
  const currentLightFeatures = lightFeatures?.route === route ? lightFeatures : undefined;
  const hasSheet = isCamera(cloud?.category) || Boolean(currentLightFeatures?.hasQuickSettings);
  const onLightFeatures = useCallback((hasQuickSettings: boolean, hasPresets: boolean) => {
    setLightFeatures({ route, hasQuickSettings, hasPresets });
  }, [route]);
  const showSheet = () => { if (!paused && !quickBusy && hasSheet && !quickOpen) onQuickOpen(route); };
  const openDetails = () => { if (!paused && !quickBusy) onOpen(route); };
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
  return (
    <Card
      id={deviceCardId(device.id)}
      className="device-card dashboard-device"
      data-card-layout={cardLayout}
      data-unavailable={!online || undefined}
      data-header-details
      data-layout-slot={placement.slot}
      data-layout-nudge={placement.nudge}
      aria-label={device.name}
      onClick={(event) => {
        if (event.target instanceof Element) openCard(event, event.target.closest('.dashboard-card-header') ? openDetails : showSheet);
      }}
      style={placement.style}
      inert={placement.inert}
    >
      <DashboardCardHeader
        icon={<DeviceIcon category={cloud?.category} codes={codes} />} aliases={aliases}
        title={(
          <button type="button" className="device-card-details-trigger" disabled={paused || quickBusy} title={device.name} onClick={openDetails}>
            {device.name}
          </button>
        )}
        metadata={(
          <>
            <p className="device-location">{room}</p>
            <div className="device-card-status tw:flex tw:max-w-full tw:flex-none tw:flex-wrap tw:items-center tw:gap-1.5 tw:text-[11px]">
              <span className={'presence ' + (online ? 'online' : '')}>{cloud ? (online ? t(MSG.ONLINE) : t(MSG.OFFLINE)) : local && !enabled ? t(MSG.DISABLED_IN_SETTINGS) : online ? t(MSG.AVAILABLE_LOCALLY) : t(MSG.STATUS_UNKNOWN)}</span>
              <BatteryBadge reading={battery} />
            </div>
          </>
)}
        actions={(
          <>
            {hasSheet && (
              <button
                type="button"
                className="secondary tile-icon-action"
                ref={sheetTrigger}
                title={t(MSG.QUICK_DEVICE_CONTROLS)}
                aria-label={t(MSG.QUICK_DEVICE_CONTROLS)}
                aria-haspopup="dialog"
                aria-expanded={quickOpen}
                disabled={paused || quickBusy}
                onClick={showSheet}
              >
                <Icon name="sliders" />
              </button>
            )}
            <CardDetailsButton label={t(MSG.DETAILS)} disabled={quickBusy || paused} onClick={openDetails} />
            {!local && (
            <button
              className="secondary tile-icon-action device-setup-action"
              aria-label={t(MSG.SET_UP_LOCAL_CONNECTION)}
              title={t(MSG.SET_UP_LOCAL_CONNECTION)}
              disabled={!onAdd || quickBusy}
              onClick={() => route !== 'local' && onAdd?.(route)}
            >
              <Icon name="wifi" />
            </button>
)}
          </>
)}
        secondary={currentLightFeatures?.hasPresets && (
          <select className="dashboard-light-presets" aria-label={t(MSG.PRESETS)} disabled>
            <option>{t(MSG.PRESETS)}</option>
          </select>
        )}
      />
      <DashboardCardFooter>
        <CardControls
          key={route}
          api={api}
          device={device}
          route={route}
          now={now}
          paused={paused}
          onAuthError={onAuthError}
          onBusy={notifyBusy}
          onStatus={updateStatus}
          sheet={{ open: quickOpen, close: onQuickClose, trigger: sheetTrigger, onLightFeatures }}
        />
        {routes.length > 1 && (
        <div className="device-card-footer tw:mt-2">
          <select className="device-route-select" aria-label={t(MSG.CONTROL_METHOD) + device.name} value={route} disabled={quickBusy} onChange={event => setChosen(event.target.value as DeviceRoute)}>
            {routes.map(value => <option key={value} value={value}>{routeLabel[value]}</option>)}
          </select>
        </div>
)}
      </DashboardCardFooter>
    </Card>
  );

}

export function ControlCenter({ dashboardPanel = null, cardSize = 'large', api, ready, sharingReady = false, developerReady = false, onAuthError, onConnections }: {
  dashboardPanel?: DashboardPanel; cardSize?: 'small' | 'large'; api: HomeApi; ready: boolean; sharingReady?: boolean; developerReady?: boolean;
  onAuthError: () => void; onConnections?: () => void;
}) {
  const mask = `${sharingReady}:${developerReady}`;
  const [record, setRecord] = useState<Loaded | null>(null);
  // Hide records and controls immediately when the server/account selection changes.
  const current = ready && record?.api === api && record.mask === mask ? record : null;
  const inventory = current?.inventory;
  const cloud = current?.cloud || NO_CLOUD;
  const combinations = current?.combinations ?? NO_COMBINATIONS;
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
  const combinedQuick = matchPath(combinationQuickPattern, location.pathname);
  const combinedQuickOpen = Boolean(combinedQuick);
  const combinedEdit = matchPath(combinationEditPattern, location.pathname);
  const combinedDetails = matchPath(combinationPattern, location.pathname);
  const combinedNew = location.pathname === combinationNewPath;
  const combinedId = combinedNew ? undefined : (combinedQuick ?? combinedEdit ?? combinedDetails)?.params.combinedId;
  const [revision, setRevision] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (dashboardPanel === 'search') searchInput.current?.focus(); }, [dashboardPanel]);
  const selectRoom = useCallback((value: string, params = new URLSearchParams(location.search)) => {
    params.delete('page');
    navigate(dashboardHref(value, params, dashboardPanel));
  }, [dashboardPanel, location.search, navigate]);
  function setBuilding(value: string) {
    if (value) query.set('building', value); else query.delete('building');
    selectRoom('', query);
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
    const readCombinations = async () => {
      try {
        const result = await api.combinations(controller.signal);
        if (controller.signal.aborted || !Array.isArray(result)) return;
        setRecord(previous => previous?.api === api && previous.mask === mask ? { ...previous, combinations: result } : previous);
      } catch (failure) {
        if (!controller.signal.aborted && failure instanceof ApiError && failure.status === 401) onAuthError();
      }
    };
    const requests = [handle(t(MSG.HOME_NETWORK), () => api.inventory(controller.signal)), readCombinations()];
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
  const resolvedMembers = useMemo(() => {
    const byId = new Map(devices.map((device) => [device.id, device]));
    return new Map(combinations.map((combined) => [combined.id, combined.members.map((member) => {
      const device = byId.get(member.device_id);
      return { member, device: member.accessible && device && deviceRoutes(device).includes(member.route) ? device : undefined };
    })]));
  }, [combinations, devices]);
  const combined = combinations.find((item) => String(item.id) === combinedId);
  const combinedParent = combinations.find((item) => String(item.id) === query.get('combined')
    && resolvedMembers.get(item.id)?.some(({ member, device }) => device?.id === deviceLink?.id && member.route === deviceLink?.route));
  const linked = deviceLink ? devices.find(device => device.id === deviceLink.id) : undefined;
  const linkedRoute = linked ? deviceLink?.route || deviceRoutes(linked)[0] : undefined;
  const validRoute = linked && linkedRoute && deviceRoutes(linked).includes(linkedRoute) ? linkedRoute : undefined;
  const linkError = deviceLink && ready && current && !busy ? !linked ? t(MSG.THE_LINKED_DEVICE_WAS_NOT_FOUND_IN_THE) : linkedRoute && !deviceRoutes(linked).includes(linkedRoute) ? t(MSG.THE_CONTROL_METHOD_IN_THIS_LINK_IS_UNAVAILABLE) : '' : '';
  const group = inventory?.groups.find(item => String(item.id) === groupId);
  const parent = inventory?.groups.find(item => String(item.id) === query.get('group') && linked?.local && item.device_ids.includes(linked.local.id));
  const activeSurvey = ready && survey?.api === api && survey.mask === mask && survey.key === location.key ? survey.value : null;
  const selected: Selection | null = activeSurvey ?? (!quick && linked && validRoute ? { kind: 'device', device: linked, route: validRoute, parent, combinedParent }
    : group ? { kind: 'group', group } : null);
  const detailDevice = selected?.kind === 'device' ? selected.device : undefined;
  let detailCloseLabel: string | undefined;
  if (selected?.kind === 'device' && selected.combinedParent) detailCloseLabel = t(MSG.BACK_TO_COMBINATION);
  else if (selected?.kind === 'device' && selected.parent) detailCloseLabel = t(MSG.BACK_TO_GROUP);
  const detailProvider = selected?.kind === 'device' && selected.route !== 'local' ? selected.route : undefined;
  const detailCloud = detailProvider && detailDevice?.cloud[detailProvider];
  const knownGatewayId = detailCloud?.gateway_id || detailDevice?.cloud.developer?.gateway_id;
  const detailGateway = inventory?.devices.find((device) => device.id === detailDevice?.local?.parent_id)
    ?? inventory?.devices.find((device) => device.device_id === knownGatewayId);
  const detailsOpen = selected !== null || Boolean(combined || (combinedNew && current?.combinations));
  useEffect(() => {
    if (!detailsOpen) return;
    dispatch(setDetailsOpen(true));
    return () => { dispatch(setDetailsOpen(false)); };
  }, [detailsOpen, dispatch]);
  const filteredRooms = useMemo(
    () => inventory?.rooms.filter((item) => !building || String(item.building_id) === building) ?? [],
    [building, inventory?.rooms],
  );
  const entries = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const inRoom = (id: number | null) => !room || (room === 'none' ? id === null : String(id) === room);
    const roomBuilding = (id: number | null) => inventory?.rooms.find((item) => item.id === id)?.building_id;
    const combinedInRoom = combinations.filter((item) => inRoom(item.room_id) && (!building || String(roomBuilding(item.room_id)) === building));
    const displayed = combinedInRoom.filter((item) => item.name.toLocaleLowerCase().includes(needle)
      || resolvedMembers.get(item.id)?.some(({ device }) => device && matchesDevice(device, needle)));
    const combinedMembers = new Set(displayed.flatMap((item) => (resolvedMembers.get(item.id) ?? []).map(({ device }) => device?.id)));
    const filtered = devices.filter((device) => !combinedMembers.has(device.id)
      && (!building || String(placementOf(device)?.building_id) === building)
      && inRoom(placementOf(device)?.room_id ?? null) && matchesDevice(device, needle));
    const groups = inventory?.groups.filter((item) => inRoom(item.room_id)
      && (!building || String(roomBuilding(item.room_id)) === building) && item.name.toLocaleLowerCase().includes(needle)) ?? [];
    return [
      ...groups.map((item) => ({ kind: 'group' as const, group: item })),
      ...displayed.map((item) => ({ kind: 'combined' as const, combined: item })),
      ...filtered.map((device) => ({ kind: 'device' as const, device })),
    ];
  }, [devices, inventory, building, room, search, placements, combinations, resolvedMembers]);
  const linkedIndex = entries.findIndex((entry) => {
    if (entry.kind === 'device') return entry.device === linked;
    if (entry.kind === 'combined') return entry.combined === (combined ?? combinedParent);
    return entry.group === group;
  });
  const page = linkedIndex >= 0 ? Math.floor(linkedIndex / PAGE_SIZE)
    : Number.isSafeInteger(requestedPage) ? Math.min(Math.max(requestedPage - 1, 0), Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1)) : 0;
  const visible = useMemo(() => {
    const pageEntries = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    // A copied quick link can outlive the device's room assignment or alias.
    if (linkedIndex < 0 && combinedQuickOpen && combined) return [{ kind: 'combined' as const, combined }, ...pageEntries];
    if (quick && linked && validRoute && !pageEntries.some((entry) => entry.kind === 'device' && entry.device === linked)) {
      return [{ kind: 'device' as const, device: linked }, ...pageEntries];
    }
    return pageEntries;
  }, [entries, page, quick, linked, validRoute, linkedIndex, combined, combinedQuickOpen]);
  useEffect(() => {
    const controller = new AbortController();
    setGroupStates({});
    // Initial list reads use SQLite only. Visible card controls separately
    // renew background watches; list loading never requests per-device cloud details.
    visible.forEach((entry) => {
      let request;
      if (entry.kind === 'group') request = api.groupState(entry.group.id, controller.signal);
      else if (entry.kind === 'device' && entry.device.local) request = dispatch(readLocalDevice(api, entry.device.local.id, false, controller.signal));
      if (!request) return;
      void request.then(value => {
        if (controller.signal.aborted) return;
        if ('group_id' in value) setGroupStates(current => ({ ...current, [value.group_id]: value }));
      }).catch(failure => { if (!controller.signal.aborted && failure instanceof ApiError && failure.status === 401) onAuthError(); });
    });
    return () => controller.abort();
  }, [api, dispatch, visible]);
  function setPage(value: number) {
    if (value > 0) query.set('page', String(value + 1)); else query.delete('page');
    void navigate(dashboardHref(room, query, dashboardPanel));
  }
  function overlayHref(path: string, route?: DeviceRoute, group?: Group, combination?: CombinedDevice) {
    const params = new URLSearchParams(query);
    if (room) params.set('room', room);
    if (dashboardPanel) params.set('panel', dashboardPanel);
    if (route) params.set('route', route); else params.delete('route');
    if (group) params.set('group', String(group.id)); else params.delete('group');
    if (combination) params.set('combined', String(combination.id)); else params.delete('combined');
    return withQuery(path, params);
  }
  function openOverlay(href: string) {
    if (href !== location.pathname + location.search) void navigate(href, { state: { dashboardOverlay: true } });
  }
  function choose(value: Selection) {
    if (value.kind === 'survey') { setSurvey({ api, mask, key: location.key, value }); return; }
    setSurvey(null);
    if (value.kind === 'device') openOverlay(overlayHref(devicePath(value.device.id), value.route, value.parent, value.combinedParent));
    else openOverlay(overlayHref('/groups/' + value.group.id));
  }
  function closeOverlay() {
    if (location.state?.dashboardOverlay) { void navigate(-1); return; }
    if (parent) { void navigate(overlayHref('/groups/' + parent.id), { replace: true }); return; }
    if (combinedParent) { navigate(overlayHref(`/combined-devices/${combinedParent.id}`), { replace: true }); return; }
    if (page > 0) query.set('page', String(page + 1));
    void navigate(dashboardHref(room, query, dashboardPanel), { replace: true });
  }
  function close() {
    if (activeSurvey) setSurvey(null); else closeOverlay();
    setRevision(value => value + 1);
  }
  function setupDetailDevice() {
    if (!detailDevice?.local) return;
    const provider = detailDevice.cloud.sharing ? 'sharing' : detailDevice.cloud.developer ? 'developer' : undefined;
    choose({ kind: 'survey', existing: detailDevice.local, provider, device: provider ? detailDevice.cloud[provider] : undefined });
  }
  function saveCombination(saved?: CombinedDevice) {
    setRecord((previous) => {
      if (!previous || previous.api !== api || previous.mask !== mask) return previous;
      const list = previous.combinations ?? [];
      if (!saved) return { ...previous, combinations: list.filter((item) => item.id !== combined?.id) };
      const found = list.some((item) => item.id === saved.id);
      return { ...previous, combinations: found ? list.map((item) => (item.id === saved.id ? saved : item)) : [...list, saved] };
    });
    if (!saved) navigate(dashboardHref(room, query, dashboardPanel), { replace: true });
    else closeOverlay();
  }
  function renderCard(entry: DashboardEntry, placement: GridCardPlacement) {
    if (entry.kind === 'combined') {
      const item = entry.combined;
      const href = `/combined-devices/${item.id}`;
      const name = inventory?.rooms.find((itemRoom) => itemRoom.id === item.room_id)?.name ?? t(MSG.NO_ROOM);
      const quickOpen = combinedQuickOpen && item === combined;
      return (
        <CombinedDeviceCard
          key={`combined-${item.id}`}
          api={api}
          combined={item}
          members={resolvedMembers.get(item.id) ?? []}
          room={name}
          now={now}
          placement={placement}
          paused={Boolean((detailsOpen && !quickOpen) || placement.inert)}
          quickOpen={quickOpen}
          onQuickOpen={() => openOverlay(overlayHref(`${href}/quick`))}
          onQuickClose={() => closeOverlay()}
          onDetails={() => openOverlay(overlayHref(href))}
          onAuthError={onAuthError}
        />
      );
    }

    if (entry.kind === 'group') {
      const { group: cardGroup } = entry;
      const state = groupStates[cardGroup.id];
      return (
        <Card
          className="device-card dashboard-device"
          key={`group-${cardGroup.id}`}
          aria-label={cardGroup.name}
          data-layout-slot={placement.slot}
          data-layout-nudge={placement.nudge}
          onClick={(event) => openCard(event, () => choose(entry))}
          style={placement.style}
          inert={placement.inert}
        >
          <DashboardCardHeader
            title={cardGroup.name}
            icon={<DeviceIcon group />}
            metadata={(
              <>
                <span className="device-location">{t(MSG.GROUP)} {cardGroup.device_ids.length} {t(MSG.DEVICES)}</span>
                <span className="device-location">{t(MSG.ON_YOUR_HOME_NETWORK)}</span>
              </>
            )}
            actions={<CardDetailsButton label={t(MSG.OPEN_GROUP)} onClick={() => choose(entry)} />}
          />
          <DashboardCardFooter>
            <p className="dashboard-group-reading">{state ? groupSummary(state.members, now) : t(MSG.STATUS_UNKNOWN)}</p>
          </DashboardCardFooter>
        </Card>
      );
    }

    const { device } = entry;
    const canAdd = inventory && !busy && (!sharingReady || topology.data || topology.error);
    return (
      <DeviceCard
        key={`device-${device.id}`}
        api={api}
        device={device}
        room={roomName(device)}
        now={now}
        paused={Boolean((detailsOpen && !combinedQuickOpen) || placement.inert)}
        quickRoute={quick && device === linked ? validRoute : undefined}
        onAuthError={onAuthError}
        onOpen={(route) => choose({ ...entry, route })}
        onQuickOpen={(route) => openOverlay(overlayHref(devicePath(device.id, true), route))}
        onQuickClose={() => closeOverlay()}
        onAdd={canAdd ? (provider) => choose({ kind: 'survey', device: device.cloud[provider], provider }) : undefined}
        placement={placement}
      />
    );
  }

  const canUseLayout = !search.trim() && !(quick && linkedIndex < 0) && !(combinedQuickOpen && linkedIndex < 0);
  const gridItems = visible.map((entry) => {
    if (entry.kind === 'group') return { id: `group-${entry.group.id}`, cardName: entry.group.name, entry };
    if (entry.kind === 'combined') return { id: `combined-${entry.combined.id}`, cardName: entry.combined.name, entry };
    return { id: `device-${entry.device.id}`, cardName: entry.device.name, entry };
  });

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

    return (
      <DeviceSurvey
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
      />
    );
  }
  return (
    <section className="card control-center" aria-labelledby="control-center-heading">
      <div className="card-heading">
        <div>
          <p className="eyebrow">{t(MSG.YOUR_HOME)}</p>
          <h2 id="control-center-heading">{t(MSG.DEVICES_AND_GROUPS)}
            {current && <span className="count">{devices.length + (inventory?.groups.length || 0)}</span>}
          </h2>
        </div>
        <div className="survey-toolbar dashboard-actions">
          <button className="secondary compact" disabled={!inventory || busy} aria-label={t(MSG.SET_UP_LOCAL_DEVICE)} title={t(MSG.SET_UP_LOCAL_DEVICE)} onClick={() => choose({ kind: 'survey' })}>
            <Icon name="add" className="dashboard-action-icon" />
            <span>{t(MSG.SET_UP_LOCAL_DEVICE)}</span>
          </button>
          {current?.combinations && (
            <button
              type="button"
              className="secondary compact"
              disabled={busy || devices.length < 2}
              onClick={() => openOverlay(overlayHref(combinationNewPath))}
            >
              <Icon name="add" className="dashboard-action-icon" />
              <span>{t(MSG.COMBINE_DEVICES)}</span>
            </button>
          )}
          <button className="secondary compact" disabled={!ready || busy} aria-label={t(MSG.REFRESH_LIST)} title={t(MSG.REFRESH_LIST)} onClick={() => setRevision(value => value + 1)}>
            <Icon name="refresh-list" className="dashboard-action-icon" />
            <span>{t(MSG.REFRESH_LIST)}</span>
          </button>
        </div>
      </div>
      {!ready ? <p className="saved-summary">{t(MSG.SAVE_SERVICE_ACCESS_IN_CONNECTION_SETTINGS_FIRST)}</p> : (
        <>
          {linkError && <p className="field-error" role="alert">{linkError}</p>}
          {!busy && current && combinedId && !combined && <p className="field-error" role="alert">{t(MSG.COMBINATION_UNAVAILABLE)}</p>}
          <RoomNavigation rooms={filteredRooms} selected={room} onSelect={selectRoom} />
          <p className="help dashboard-intro">{t(MSG.MAIN_CONTROLS_ARE_AVAILABLE_HERE)}</p>
          {sharingReady && (
          <TopologySummary
            data={topology.data}
            error={topology.error}
            busy={topology.busy}
            onSync={() => void topology.sync()}
          />
)}
          <div className="control-filters">
            <label>{t(MSG.BUILDING)}
              <select value={building} onChange={event => setBuilding(event.target.value)}>
                <option value="">{t(MSG.ALL_BUILDINGS)}</option>
                {inventory?.buildings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label>{t(MSG.ROOM)}
              <select value={room} onChange={event => selectRoom(event.target.value)}>
                <option value="">{t(MSG.ALL_ROOMS)}</option>
                <option value="none">{t(MSG.NO_ROOM)}</option>
                {filteredRooms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label id="dashboard-search" className="dashboard-search-field">
              <span>{t(MSG.SEARCH_BY_NAME_ALIAS_OR_ID)}</span>
              <input ref={searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t(MSG.FIND_A_DEVICE_OR_GROUP)} />
            </label>
          </div>
          {busy && <p role="status" className="help">{t(MSG.LOADING_LIST)}</p>}
          {current?.errors.map(error => <p key={translateText(error)} role="alert" className="field-error">{translateText(error)}</p>)}
          {!busy && current && !entries.length && (
          <div className="empty-state">
            <h3>{devices.length || inventory?.groups.length ? t(MSG.NOTHING_FOUND) : t(MSG.NO_DEVICES_YET)}</h3>
            <p>{devices.length || inventory?.groups.length ? t(MSG.CHANGE_YOUR_FILTERS_OR_SEARCH_QUERY) : sharingReady || developerReady ? t(MSG.ADD_DEVICES_IN_SMART_LIFE_AND_REFRESH_THE) : t(MSG.CONNECT_A_TUYA_ACCOUNT_TO_SEE_YOUR_DEVICES)}</p>
            {!devices.length && !sharingReady && !developerReady && onConnections && <button className="secondary compact" onClick={onConnections}>{t(MSG.SET_UP_CONNECTION)}</button>}
          </div>
)}
          <DashboardGrid<DashboardEntry>
            api={api}
            density={cardSize}
            items={gridItems}
            view={canUseLayout ? { building, room, page: page + 1 } : undefined}
            editable={Boolean(current && !busy && !detailsOpen && !quick)}
            renderCard={(entry, placement) => renderCard(entry, placement)}
          />
          {entries.length > PAGE_SIZE && (
          <div className="pagination">
            <button className="secondary compact" disabled={page === 0} onClick={() => setPage(page - 1)}>{t(MSG.BACK)}</button>
            <span>{page + 1} / {Math.ceil(entries.length / PAGE_SIZE)}</span>
            <button className="secondary compact" disabled={(page + 1) * PAGE_SIZE >= entries.length} onClick={() => setPage(page + 1)}>{t(MSG.NEXT)}</button>
          </div>
)}
        </>
  )}
      {combined && combinedDetails && (
        <CombinedDeviceDetails
          combined={combined}
          members={resolvedMembers.get(combined.id) ?? []}
          onChoose={(device, route) => choose({ kind: 'device', device, route, combinedParent: combined })}
          onEdit={() => openOverlay(overlayHref(`/combined-devices/${combined.id}/edit`))}
          onClose={() => closeOverlay()}
        />
      )}
      {((combined && combinedEdit) || (combinedNew && current?.combinations)) && (
        <CombinedDeviceSettings
          api={api}
          key={combined?.id ?? 'new'}
          existing={combined}
          devices={devices}
          rooms={inventory?.rooms ?? []}
          initialRoom={Number(room) || null}
          deviceRoom={(device) => placementOf(device)?.room_id ?? null}
          onClose={() => closeOverlay()}
          onSaved={(saved) => saveCombination(saved)}
          onAuthError={onAuthError}
        />
      )}
      {selected?.kind === 'device' && selected.route === 'local' && detailDevice?.local && (
        <LocalControl
          key={detailDevice.local.id}
          api={api}
          room={roomName(detailDevice)}
          device={detailDevice.local}
          gateway={detailGateway}
          cloudDevice={detailDevice.cloud.sharing ?? detailDevice.cloud.developer}
          routes={deviceRoutes(detailDevice)}
          onAuthError={onAuthError}
          onSetup={inventory ? () => setupDetailDevice() : undefined}
          closeLabel={detailCloseLabel}
          onClose={close}
        />
      )}
      {detailDevice && detailProvider && detailCloud && (
        <CloudControl
          key={detailProvider + detailDevice.id}
          api={api}
          room={roomName(detailDevice)}
          displayName={detailDevice.name}
          closeLabel={detailCloseLabel}
          device={detailCloud}
          localDevice={detailDevice.local}
          gateway={detailGateway}
          routes={deviceRoutes(detailDevice)}
          devices={cloud[detailProvider]}
          provider={detailProvider}
          onClose={close}
          onAuthError={onAuthError}
        />
      )}
      {selected?.kind === 'group' && <GroupControl key={selected.group.id} api={api} group={selected.group} onAuthError={onAuthError} onClose={close} onDevice={device => choose({ kind: 'device', device: mergeDevices([device], cloud)[0], route: 'local', parent: selected.group })} />}
    </section>
  );
}
