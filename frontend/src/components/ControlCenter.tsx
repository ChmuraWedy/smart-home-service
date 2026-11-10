import { MSG, t, translateText } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  generatePath, matchPath, useLocation, useNavigate,
} from 'react-router';
import { ApiError } from '../api';
import type { CloudDevice, Provider } from '../api';
import { localSpec } from '../controls';
import { resolveCombinedMember } from '../combined-power';
import { deviceAliases, deviceRoutes, deviceTextVariants, matchesDevice, mergeDevices, routeLabel } from '../devices';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import { HomeApi } from '../home-api';
import type { CombinedDevice, Group, GroupState, Inventory, LocalDevice, Room } from '../home-api';
import { CloudControl } from './CloudControl';
import CombinedDeviceCard from './CombinedDeviceCard';
import { CombinedDeviceDetails, CombinedDeviceList, CombinedDeviceSettings } from './CombinedDeviceSettings';
import { GroupControl, LocalControl, groupSummary } from './LocalControls';
import { useClock } from './DeviceControls';
import { DeviceSurvey } from './DeviceSurvey';
import { BatteryBadge, batteryFromSpecs, DeviceIcon, isCamera } from './DevicePresentation';
import { useTopology } from '../use-topology';
import RoomNavigation from './RoomNavigation';
import useRoomName from '../room-names';
import { RoomLayoutSettings } from './RoomEditor';
import DeviceRoomEditor from './DeviceRoomEditor';
import CameraRoomCard, { cameraRoomCardId } from './CameraRoomCard';
import { cameraRoomPreviewKey, setCameraRoomPreview, useCameraRoomPreviews } from '../camera-room-previews';
import type { CardStatus } from './CardControls';
import { CardControls } from './CardControls';
import { Card } from './ui/card';
import { Icon } from './ui/icon';
import { CardDetailsButton, DashboardCardHeader } from './DashboardCardHeader';
import DashboardCardFooter from './DashboardCardFooter';
import DashboardGrid from './DashboardGrid';
import type { GridCardPlacement } from './DashboardGrid';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { deviceCardId, devicePath, readDeviceLink } from '../device-links';
import {
  appPaths, combinationEditPattern, combinationEditPreviewPattern, combinationNewPath, combinationNewPreviewPath,
  combinationPattern, combinationQuickPattern, dashboardHref, dashboardRoom, groupPattern, isDashboardLayoutPath, quickPattern, withQuery,
  dashboardSearchHref,
} from '../navigation';
import type { DashboardPanel } from '../navigation';
import { selectCommandPending, setCommandPending, setDetailsOpen, useAppDispatch, useAppSelector } from '../store';
import { readLocalDevice } from '../local-device-cache';
import { cloudAccountScope } from '../cloud-account-scope';
import { cacheDeviceMetadata, cloudMetadataKey, labelsFromCloudDefinitions, localMetadataKey, nextDeviceMetadataRevision } from '../device-metadata';
import { useLocalDeviceState } from '../use-local-device-state';
import { useDeviceText } from '../device-translations';
import type { DeviceTranslations } from '../device-translations';
import { useRoomAppearance } from '../room-appearance';

type Selection = { kind: 'group'; group: Group } | { kind: 'device'; device: UnifiedDevice; route: DeviceRoute; parent?: Group; combinedParent?: CombinedDevice } | { kind: 'survey'; device?: CloudDevice; provider?: Provider; existing: LocalDevice };
type DashboardEntry = { kind: 'group'; group: Group } | { kind: 'device'; device: UnifiedDevice }
  | { kind: 'combined'; combined: CombinedDevice } | { kind: 'camera-video'; device: UnifiedDevice; provider: Provider };
type Loaded = { api: HomeApi; mask: string; inventory: Inventory | null; combinations?: CombinedDevice[]; cloud: Partial<Record<Provider, CloudDevice[]>>; errors: string[] };
const PAGE_SIZE = 24;
const NO_COMBINATIONS: CombinedDevice[] = [];
const NO_CLOUD: Partial<Record<Provider, CloudDevice[]>> = {};

function openCard(event:MouseEvent<HTMLLIElement>,open:()=>void) {
  if (event.defaultPrevented || !(event.target instanceof Element) || event.target.closest('button,a,input,select,textarea,label,summary,video,audio,[role="button"],[role="switch"],[contenteditable="true"],.camera-live') || window.getSelection()?.toString()) return;
  open();
}

function cardPresenceMessage({
  hasCloud, hasLocal, enabled, online,
}: {
  hasCloud: boolean;
  hasLocal: boolean;
  enabled?: boolean;
  online?: boolean;
}) {
  if (hasCloud) return online ? MSG.ONLINE : MSG.OFFLINE;
  if (hasLocal && !enabled) return MSG.DISABLED_IN_SETTINGS;
  return online ? MSG.AVAILABLE_LOCALLY : MSG.STATUS_UNKNOWN;
}

function DeviceCard({ api, device, room, now, paused, quickRoute, onAuthError, onOpen, onQuickOpen, onQuickClose, placement }: {
  api: HomeApi; device: UnifiedDevice; room: string; now: number; paused: boolean; onAuthError: () => void; onOpen: (route: DeviceRoute) => void;
  quickRoute?: DeviceRoute; onQuickOpen: (route: DeviceRoute) => void; onQuickClose: () => void; placement: GridCardPlacement;
}) {
  const state = useLocalDeviceState(api, device.local?.id);
  const localize = useDeviceText();
  const name = localize(device.name, deviceTextVariants(device, 'name', device.name));
  const aliases = [...new Set(deviceAliases(device).map((alias) => localize(alias, deviceTextVariants(device, 'alias', alias))))];
  const routes = deviceRoutes(device);
  const [chosen, setChosen] = useState<DeviceRoute | null>(null);
  const dispatch = useAppDispatch();
  const quickBusy = useAppSelector(state => selectCommandPending(state, device.id));
  const quickOpen = quickRoute !== undefined;
  const [lightFeatures, setLightFeatures] = useState<{ route: DeviceRoute; hasQuickSettings: boolean; hasPresets: boolean }>();
  const sheetTrigger = useRef<HTMLButtonElement>(null);
  const [presetSlot, setPresetSlot] = useState<HTMLDivElement | null>(null);
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
  const presenceMessage = cardPresenceMessage({
    hasCloud: Boolean(cloud), hasLocal: Boolean(local), enabled, online,
  });
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
      aria-label={name}
      onClick={(event) => {
        if (event.target instanceof Element) openCard(event, event.target.closest('.dashboard-card-header') ? openDetails : showSheet);
      }}
      style={placement.style}
      inert={placement.inert}
    >
      <DashboardCardHeader
        icon={<DeviceIcon category={cloud?.category} codes={codes} />} aliases={aliases}
        title={(
          <button type="button" className="device-card-details-trigger" disabled={paused || quickBusy} title={name} onClick={openDetails}>
            {name}
          </button>
        )}
        metadata={(
          <>
            <p className="device-location">{room}</p>
            <div className="device-card-status tw:flex tw:max-w-full tw:flex-none tw:flex-wrap tw:items-center tw:gap-1.5 tw:text-[11px]">
              <span className={'presence ' + (online ? 'online' : '')}>{t(presenceMessage)}</span>
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

          </>
)}
        secondary={currentLightFeatures?.hasPresets && <div ref={setPresetSlot} />}
      />
      <DashboardCardFooter>
        <CardControls
          key={route}
          api={api}
          device={device}
          displayName={name}
          route={route}
          now={now}
          paused={paused}
          onAuthError={onAuthError}
          onBusy={notifyBusy}
          onStatus={updateStatus}
          sheet={{ open: quickOpen, close: onQuickClose, trigger: sheetTrigger, presetSlot, onLightFeatures }}
        />
        {routes.length > 1 && (
        <div className="device-card-footer tw:mt-2">
          <select className="device-route-select" aria-label={t(MSG.CONTROL_METHOD) + name} value={route} disabled={quickBusy} onChange={(event) => setChosen(event.target.value as DeviceRoute)}>
            {routes.map(value => <option key={value} value={value}>{routeLabel[value]}</option>)}
          </select>
        </div>
)}
      </DashboardCardFooter>
    </Card>
  );

}

export function ControlCenter({
  dashboardPanel = null, cardSize = 'large', api, ready, sharingReady = false, developerReady = false,
  localMappingsReady = false, onAuthError, onConnections,
}: {
  dashboardPanel?: DashboardPanel; cardSize?: 'small' | 'large'; api: HomeApi; ready: boolean; sharingReady?: boolean; developerReady?: boolean;
  localMappingsReady?: boolean; onAuthError: () => void; onConnections?: () => void;
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
  const editingLayout = isDashboardLayoutPath(location.pathname);
  const [showRemote, setShowRemote] = useState(true);
  const localOnly = !showRemote && !editingLayout;
  const activeRoom = inventory?.rooms.find(({ id }) => String(id) === room);
  const roomLabel = useRoomName();
  const [appearanceRevision, setAppearanceRevision] = useState(0);
  const roomAppearance = useRoomAppearance(api, activeRoom?.id, appearanceRevision)?.value;
  const refreshRoomAppearance = useCallback(() => setAppearanceRevision((value) => value + 1), []);
  const updateRoom = useCallback((updated: Room) => {
    setRecord((value) => {
      if (value?.api !== api || value.mask !== mask || !value.inventory) return value;
      const existing = value.inventory.rooms;
      const rooms = existing.some((item) => item.id === updated.id)
        ? existing.map((item) => (item.id === updated.id ? updated : item))
        : [...existing, updated];
      return { ...value, inventory: { ...value.inventory, rooms } };
    });
  }, [api, mask]);
  const search = editingLayout ? '' : query.get('q') ?? '';
  const requestedPage = Number(query.get('page') ?? 1);
  const deviceLink = readDeviceLink(location.pathname + location.search);
  const quick = Boolean(matchPath(quickPattern, location.pathname));
  const groupId = matchPath(groupPattern, location.pathname)?.params.groupId;
  const combinedQuick = matchPath(combinationQuickPattern, location.pathname);
  const combinedQuickOpen = Boolean(combinedQuick);
  const combinedEditPreview = matchPath(combinationEditPreviewPattern, location.pathname);
  const combinedEdit = combinedEditPreview ?? matchPath(combinationEditPattern, location.pathname);
  const combinedDetails = matchPath(combinationPattern, location.pathname);
  const combinedNewPreview = Boolean(matchPath(combinationNewPreviewPath, location.pathname));
  const combinedNew = combinedNewPreview || Boolean(matchPath(combinationNewPath, location.pathname));
  const combinedPreview = combinedNewPreview || Boolean(combinedEditPreview);
  const combinationList = Boolean(matchPath(appPaths['combined-devices'], location.pathname));
  const managingCombinations = combinationList || combinedNew || Boolean(combinedEdit);
  const combinedId = combinedNew ? undefined : (combinedQuick ?? combinedEdit ?? combinedDetails)?.params.combinedId;
  const editorPath = combinedNew ? combinationNewPath : combinedId && generatePath(combinationEditPattern, { combinedId });
  const [revision, setRevision] = useState(0);
  const selectRoom = useCallback((value: string, params = new URLSearchParams(location.search)) => {
    params.delete('page');
    navigate(dashboardHref(value, params, dashboardPanel));
  }, [dashboardPanel, location.search, navigate]);
  function setBuilding(value: string) {
    if (value) query.set('building', value); else query.delete('building');
    selectRoom('', query);
  }
  const fromDashboardLayout = Boolean(location.state?.fromDashboardLayout);
  const setEditingLayout = useCallback((editing: boolean) => {
    const params = new URLSearchParams(location.search);
    if (editing) {
      navigate(dashboardHref(room, params, dashboardPanel, true), { state: { fromDashboardLayout: true } });
    } else if (fromDashboardLayout) {
      navigate(-1);
    } else {
      navigate(dashboardHref(room, params, dashboardPanel), { replace: true });
    }
  }, [dashboardPanel, fromDashboardLayout, location.search, navigate, room]);

  function openRoomEditor() {
    navigate(appPaths.rooms);
  }
  function setSearch(value: string) {
    void navigate(dashboardSearchHref(location.pathname, location.search, dashboardPanel, value), { replace: true });
  }

  const topology = useTopology(api, ready && sharingReady, () => setRevision(value => value + 1), onAuthError);
  function roomDeleted(id: number) {
    setRecord((value) => {
      if (value?.api !== api || value.mask !== mask || !value.inventory) return value;
      const rooms = value.inventory.rooms.filter((item) => item.id !== id);
      return { ...value, inventory: { ...value.inventory, rooms } };
    });
    topology.reload();
    setRevision((value) => value + 1);
  }
  const placements = useMemo(() => new Map(topology.data?.placements.map(item => [item.device_id, item])), [topology.data]);
  const placementOf = useCallback((device: UnifiedDevice) => {
    if (device.local) return device.local;
    const listed = device.cloud.sharing?.synced_room;
    const synced = placements.get(device.id) ?? (listed && { ...listed, device_id: device.id });
    const override = device.cloud.sharing?.app_room ?? device.cloud.developer?.app_room;
    return override ? { ...override, device_id: device.id, building_id: override.building_id ?? synced?.building_id ?? null } : synced;
  }, [placements]);
  const deviceRoom = useCallback((device: UnifiedDevice) => placementOf(device)?.room_id ?? null, [placementOf]);
  function roomName(device: UnifiedDevice) {
    const locationRoom = inventory?.rooms.find((item) => item.id === placementOf(device)?.room_id);
    return locationRoom ? roomLabel(locationRoom) : t(MSG.NO_ROOM);
  }
  const [busy, setBusy] = useState(false);
  const combinationRevision = useRef(0);
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
            return {
              key: cloudMetadataKey(scope, device.id),
              revision: metadataRevision,
              name: device.name ?? '',
              aliases: device.aliases,
              translations: device.translations,
              channelLabels,
            };
          });
          if (updates.length) dispatch(cacheDeviceMetadata(updates));
        } else if (!Array.isArray(result) && result.devices.length) {
          dispatch(cacheDeviceMetadata(result.devices.map(device => ({
            key: localMetadataKey(api, device.id), revision: metadataRevision, name: device.name, aliases: device.aliases, translations: device.translations,
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
      const startedAt = combinationRevision.current;
      try {
        const result = await api.combinations(controller.signal);
        if (controller.signal.aborted || startedAt !== combinationRevision.current || !Array.isArray(result)) return;
        setRecord(previous => previous?.api === api && previous.mask === mask ? { ...previous, combinations: result } : previous);
      } catch (failure) {
        if (!controller.signal.aborted && failure instanceof ApiError && failure.status === 401) onAuthError();
      }
    };
    const requests = [handle(t(MSG.HOME_NETWORK), () => api.inventory(controller.signal))];
    if (!api.isMember) requests.push(readCombinations());
    if (sharingReady) requests.push(handle('Smart Life', () => api.devices('sharing', controller.signal), 'sharing'));
    if (developerReady) requests.push(handle('Tuya Developer', () => api.devices('developer', controller.signal), 'developer'));
    void Promise.all(requests).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, ready, mask, revision, dispatch]);
  const devices = useMemo(() => {
    function applyIdentity<T extends { name: string; aliases?: string[]; translations?: DeviceTranslations }>(device: T, key: string): T {
      const stored = identity[key];
      if (!stored) return device;
      return {
        ...device,
        name: stored.name?.value ?? device.name,
        aliases: stored.aliases?.value ?? device.aliases,
        translations: stored.translations?.value ?? device.translations,
      };
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
    return new Map(combinations.map(({ id, members }) => [
      id, members.map((member) => resolveCombinedMember(member, byId.get(member.device_id))),
    ]));
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
  const saveDeviceRoom = useCallback(async (roomId: number | null) => {
    if (!detailDevice) return;
    const { id, local } = detailDevice;
    if (local) {
      const saved = await api.setLocalDeviceRoom(local.id, roomId);
      setRecord((previous) => {
        if (previous?.api !== api || previous.mask !== mask || !previous.inventory) return previous;
        const items = previous.inventory.devices.map((item) => (item.id === local.id ? { ...item, room_id: saved.room_id, building_id: saved.building_id } : item));
        return { ...previous, inventory: { ...previous.inventory, devices: items } };
      });
      return;
    }
    const provider = detailDevice.cloud.sharing ? 'sharing' : 'developer';
    const scope = cloudAccountScope(api, provider);
    const saved = await api.setCloudDeviceRoom(id, provider, roomId);
    setRecord((previous) => {
      if (previous?.api !== api || previous.mask !== mask || cloudAccountScope(api, provider) !== scope) return previous;
      const items = previous.cloud[provider]?.map((item) => (item.id === id ? { ...item, app_room: saved } : item));
      return { ...previous, cloud: { ...previous.cloud, [provider]: items } };
    });
  }, [api, detailDevice, mask]);
  const detailRoomEditor = !api.isMember && detailDevice && inventory && (
    <DeviceRoomEditor
      key={detailDevice.id}
      rooms={inventory.rooms}
      roomId={deviceRoom(detailDevice)}
      onSave={saveDeviceRoom}
      onAuthError={onAuthError}
    />
  );
  let detailCloseLabel: string | undefined;
  if (selected?.kind === 'device' && selected.combinedParent) detailCloseLabel = t(MSG.BACK_TO_COMBINATION);
  else if (selected?.kind === 'device' && selected.parent) detailCloseLabel = t(MSG.BACK_TO_GROUP);
  const detailProvider = selected?.kind === 'device' && selected.route !== 'local' ? selected.route : undefined;
  const detailCloud = detailProvider && detailDevice?.cloud[detailProvider];
  const cameraPreviews = useCameraRoomPreviews();
  const previewKey = detailDevice && cameraRoomPreviewKey(api.baseUrl, detailDevice.id);
  const toggleRoomPreview = useCallback((enabled: boolean) => {
    if (previewKey && detailProvider) setCameraRoomPreview(previewKey, enabled ? detailProvider : undefined);
  }, [detailProvider, previewKey]);
  const knownGatewayId = detailCloud?.gateway_id || detailDevice?.cloud.developer?.gateway_id;
  const detailGateway = inventory?.devices.find((device) => device.id === detailDevice?.local?.parent_id)
    ?? inventory?.devices.find((device) => device.device_id === knownGatewayId);
  const detailsOpen = selected !== null || Boolean(combined && !combinedEdit);
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
    const needle = search.trim().normalize('NFC').toLocaleLowerCase();
    const inRoom = (id: number | null) => !room || (room === 'none' ? id === null : String(id) === room);
    const roomBuilding = (id: number | null) => inventory?.rooms.find((item) => item.id === id)?.building_id;
    const combinedInRoom = combinations.filter((item) => inRoom(item.room_id)
      && (!building || String(roomBuilding(item.room_id)) === building)
      && (!localOnly || resolvedMembers.get(item.id)?.some(({ member }) => member.route === 'local')));
    const displayed = combinedInRoom.filter((item) => item.name.normalize('NFC').toLocaleLowerCase().includes(needle)
      || item.aliases?.some((alias) => alias.toLocaleLowerCase().includes(needle))
      || resolvedMembers.get(item.id)?.some(({ device }) => device && matchesDevice(device, needle)));
    const shownMembers = new Set<string>();
    const hiddenMembers = new Set<string>();
    for (const item of displayed) {
      const members = item.show_member_cards ? shownMembers : hiddenMembers;
      for (const { device } of resolvedMembers.get(item.id) ?? []) {
        if (device) members.add(device.id);
      }
    }
    const filtered = devices.filter((device) => {
      const placement = placementOf(device);
      const inView = shownMembers.has(device.id) || (!hiddenMembers.has(device.id)
        && (!building || String(placement?.building_id) === building) && inRoom(placement?.room_id ?? null));
      return inView && (!localOnly || Boolean(device.local)) && matchesDevice(device, needle);
    });
    const groups = inventory?.groups.filter((item) => inRoom(item.room_id)
      && (!building || String(roomBuilding(item.room_id)) === building) && item.name.toLocaleLowerCase().includes(needle)) ?? [];
    const videos = localOnly ? [] : devices.flatMap((device) => {
      const provider = cameraPreviews[cameraRoomPreviewKey(api.baseUrl, device.id)];
      if (provider !== 'sharing' && provider !== 'developer') return [];
      const camera = device.cloud[provider];
      const placement = placementOf(device);
      const inActiveRoom = Boolean(room && room !== 'none' && String(placement?.room_id) === room && (!building || String(placement?.building_id) === building));
      return camera && isCamera(camera.category) && inActiveRoom && matchesDevice(device, needle)
        ? [{ kind: 'camera-video' as const, device, provider }] : [];
    });
    return [
      ...groups.map((item) => ({ kind: 'group' as const, group: item })),
      ...displayed.map((item) => ({ kind: 'combined' as const, combined: item })),
      ...filtered.map((device) => ({ kind: 'device' as const, device })),
      ...videos,
    ];
  }, [api.baseUrl, devices, inventory, building, room, search, placementOf, combinations, resolvedMembers, cameraPreviews, localOnly]);
  const linkedIndex = entries.findIndex((entry) => {
    if (entry.kind === 'device') return entry.device === linked;
    if (entry.kind === 'combined') return entry.combined === (combined ?? combinedParent);
    return entry.kind === 'group' && entry.group === group;
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
    if (managingCombinations) return undefined;
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
  }, [api, dispatch, managingCombinations, visible]);
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
    params.delete('member');
    return withQuery(path, params);
  }
  const openOverlay = useCallback((href: string) => {
    if (href !== location.pathname + location.search) void navigate(href, { state: { dashboardOverlay: true } });
  }, [location.pathname, location.search, navigate]);
  const createCombination = useCallback(() => openOverlay(combinationNewPath), [openOverlay]);
  const editCombination = useCallback((id: number) => openOverlay(generatePath(combinationEditPattern, { combinedId: String(id) })), [openOverlay]);
  const showCombinationPreview = useCallback(() => {
    if (!editorPath) return;
    navigate(`${editorPath}/preview${location.search}`, { state: { ...location.state, fromCombinationEditor: true } });
  }, [editorPath, location.search, location.state, navigate]);
  const returnToCombinationEditor = useCallback(() => {
    if (location.state?.fromCombinationEditor) navigate(-1);
    else if (editorPath) navigate(editorPath + location.search, { replace: true });
  }, [editorPath, location.search, location.state, navigate]);
  const closeManagement = useCallback(() => {
    if (location.state?.dashboardOverlay) navigate(location.state.fromCombinationEditor ? -2 : -1);
    else navigate(appPaths['combined-devices'], { replace: true });
  }, [location.state, navigate]);
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
    query.delete('member');
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
  const saveCombinationAliases = useCallback((id: number, aliases: string[]) => {
    combinationRevision.current += 1;
    setRecord((previous) => {
      if (!previous || previous.api !== api || previous.mask !== mask) return previous;
      return {
        ...previous,
        combinations: previous.combinations?.map((item) => (item.id === id ? { ...item, aliases } : item)),
      };
    });
  }, [api, mask]);
  const saveCombination = useCallback((saved?: CombinedDevice) => {
    combinationRevision.current += 1;
    setRecord((previous) => {
      if (!previous || previous.api !== api || previous.mask !== mask) return previous;
      const list = previous.combinations ?? [];
      if (!saved) return { ...previous, combinations: list.filter((item) => item.id !== combined?.id) };
      const found = list.some((item) => item.id === saved.id);
      return { ...previous, combinations: found ? list.map((item) => (item.id === saved.id ? saved : item)) : [...list, saved] };
    });
    if (!saved) navigate(appPaths['combined-devices'], { replace: true });
    else closeManagement();
  }, [api, closeManagement, combined?.id, mask, navigate]);
  function renderCard(entry: DashboardEntry, placement: GridCardPlacement) {
    if (entry.kind === 'camera-video') {
      const { device, provider } = entry;
      return (
        <CameraRoomCard
          key={cameraRoomCardId(device.id)}
          api={api}
          device={device}
          provider={provider}
          now={now}
          placement={placement}
          paused={Boolean(detailsOpen || quick || combinedQuickOpen || editingLayout || placement.inert)}
          onOpen={() => choose({ kind: 'device', device, route: provider })}
          onAuthError={onAuthError}
        />
      );
    }
    if (entry.kind === 'combined') {
      const item = entry.combined;
      const href = `/combined-devices/${item.id}`;
      const locationRoom = inventory?.rooms.find((itemRoom) => itemRoom.id === item.room_id);
      const name = locationRoom ? roomLabel(locationRoom) : t(MSG.NO_ROOM);
      const quickOpen = combinedQuickOpen && item === combined;
      const quickHref = overlayHref(`${href}/quick`);
      const openMember = (deviceId: string) => {
        const params = new URLSearchParams(quickHref.split('?')[1]);
        params.set('member', deviceId);
        openOverlay(withQuery(`${href}/quick`, params));
      };
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
          quickMemberId={quickOpen ? query.get('member') ?? undefined : undefined}
          onMemberQuickOpen={openMember}
          onQuickOpen={() => openOverlay(quickHref)}
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
        placement={placement}
      />
    );
  }

  const canUseLayout = !search.trim() && !(quick && linkedIndex < 0) && !(combinedQuickOpen && linkedIndex < 0);
  const gridItems = visible.map((entry) => {
    if (entry.kind === 'group') return { id: `group-${entry.group.id}`, cardName: entry.group.name, entry };
    if (entry.kind === 'combined') return { id: `combined-${entry.combined.id}`, cardName: entry.combined.name, entry };
    if (entry.kind === 'camera-video') return { id: cameraRoomCardId(entry.device.id), cardName: `${entry.device.name} · ${t(MSG.CAMERA_VIDEO)}`, entry };
    return {
      id: `device-${entry.device.id}`,
      cardName: entry.device.name,
      entry,
      hideable: true,
      forceVisible: quick && entry.device === linked,
    };
  });

  if (managingCombinations) {
    const rooms = inventory?.rooms ?? [];
    let content: ReactNode;
    if (!ready || !current || busy) {
      content = <p role="status">{t(MSG.LOADING_LIST)}</p>;
    } else if (!current.combinations) {
      content = (
        <>
          <p role="alert">{t(MSG.COULD_NOT_LOAD_DEVICES)}</p>
          <button type="button" className="secondary" onClick={() => setRevision((value) => value + 1)}>{t(MSG.REFRESH_LIST)}</button>
        </>
      );
    } else if (combinationList) {
      content = (
        <CombinedDeviceList
          combinations={combinations}
          rooms={rooms}
          canCreate={devices.filter((device) => deviceRoutes(device).length > 0).length >= 2}
          onCreate={createCombination}
          onEdit={editCombination}
        />
      );
    } else if (combinedNew || combined) {
      content = (
        <CombinedDeviceSettings
          api={api}
          key={combined?.id ?? 'new'}
          existing={combined}
          devices={devices}
          rooms={rooms}
          initialRoom={Number(room) || null}
          deviceRoom={deviceRoom}
          now={now}
          cardSize={cardSize}
          previewing={combinedPreview}
          onPreview={showCombinationPreview}
          onPreviewBack={returnToCombinationEditor}
          onClose={closeManagement}
          onSaved={saveCombination}
          onAuthError={onAuthError}
        />
      );
    } else {
      content = (
        <>
          <p role="alert">{t(MSG.COMBINATION_UNAVAILABLE)}</p>
          <button type="button" className="secondary" onClick={closeManagement}>{t(MSG.BACK)}</button>
        </>
      );
    }
    return <section className="card combined-device-management">{content}</section>;
  }

  if (activeSurvey && inventory) {
    const { device, existing, provider } = activeSurvey;
    const surveyedDevice = device && devices.find(({ id }) => id === device.id);

    function reopenLocalDevice(local: LocalDevice) {
      const [mergedDevice] = mergeDevices([local], cloud);
      choose({ kind: 'device', device: mergedDevice, route: 'local' });
    }

    function closeSurvey() {
      reopenLocalDevice(existing);
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
        placement={surveyedDevice ? placementOf(surveyedDevice) : undefined}
        onClose={closeSurvey}
        onSaved={existing ? saveSurvey : undefined}
        onAuthError={onAuthError}
      />
    );
  }
  let roomAction: ReactNode;
  if (!api.isMember && import.meta.env.MODE !== 'demo') {
    if (activeRoom) {
      roomAction = (
        <RoomLayoutSettings
          key={activeRoom.id}
          api={api}
          room={activeRoom}
          onAuthError={onAuthError}
          onRenamed={updateRoom}
          onAppearanceSaved={refreshRoomAppearance}
        />
      );
    } else if (inventory && room === '') {
      roomAction = (
        <button type="button" className="secondary compact" onClick={openRoomEditor}>
          {t(MSG.ROOM_EDITOR_TITLE)}
        </button>
      );
    }
  }

  const hasDevices = Boolean(devices.length || inventory?.groups.length);
  const setupMessage = sharingReady || developerReady ? MSG.ADD_DEVICES_IN_SMART_LIFE_AND_REFRESH_THE : MSG.CONNECT_A_TUYA_ACCOUNT_TO_SEE_YOUR_DEVICES;
  const emptyState = !busy && current && !entries.length && (
    <div className="empty-state">
      <h3>{t(hasDevices ? MSG.NOTHING_FOUND : MSG.NO_DEVICES_YET)}</h3>
      <p>{t(hasDevices ? MSG.CHANGE_YOUR_FILTERS_OR_SEARCH_QUERY : setupMessage)}</p>
      {!devices.length && !sharingReady && !developerReady && onConnections && (
        <button type="button" className="secondary compact" onClick={onConnections}>
          {t(MSG.SET_UP_CONNECTION)}
        </button>
      )}
    </div>
  );

  return (
    <section
      className="card control-center"
      aria-labelledby="control-center-heading"
      data-room-appearance={Boolean(roomAppearance) || undefined}
      data-room-background={Boolean(roomAppearance?.backgroundUrl) || undefined}
      style={roomAppearance && {
        '--room-card-opacity': `${roomAppearance.appearance.card_opacity}%`,
        '--room-background-image': roomAppearance.backgroundUrl ? `url("${roomAppearance.backgroundUrl}")` : undefined,
      } as CSSProperties | undefined}
    >
      <div className="card-heading">
        <div>
          <p className="eyebrow">{t(MSG.YOUR_HOME)}</p>
          <h2 id="control-center-heading">{t(MSG.DEVICES_AND_GROUPS)}
            {current && <span className="count">{devices.length + (inventory?.groups.length || 0)}</span>}
          </h2>
        </div>
        <div className="survey-toolbar dashboard-actions">
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
          <p className="help dashboard-intro">{t(MSG.MAIN_CONTROLS_ARE_AVAILABLE_HERE)}</p>
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
                {filteredRooms.map(item => <option key={item.id} value={item.id}>{roomLabel(item)}</option>)}
              </select>
            </label>
            {dashboardPanel === 'tools' && (
              <label>
                <span>{t(MSG.SEARCH_BY_NAME_ALIAS_OR_ID)}</span>
                <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t(MSG.FIND_A_DEVICE_OR_GROUP)} />
              </label>
            )}
          </div>
          {busy && <p role="status" className="help">{t(MSG.LOADING_LIST)}</p>}
          {current?.errors.map(error => <p key={translateText(error)} role="alert" className="field-error">{translateText(error)}</p>)}
          <DashboardGrid<DashboardEntry>
            api={api}
            density={cardSize}
            items={gridItems}
            view={canUseLayout ? { building, room, page: page + 1 } : undefined}
            editable={Boolean(current && !busy && !detailsOpen && !quick)}
            editing={editingLayout}
            onEditingChange={setEditingLayout}
            remoteVisibility={{ shown: showRemote, toggle: () => setShowRemote((value) => !value) }}
            navigation={(
              <RoomNavigation
                api={api}
                allRooms={inventory?.rooms}
                rooms={filteredRooms}
                selected={room}
                onSelect={selectRoom}
                management={!api.isMember && inventory && import.meta.env.MODE !== 'demo' ? {
                  buildings: inventory.buildings,
                  onSaved: updateRoom,
                  onDeleted: roomDeleted,
                  onAuthError,
                } : undefined}
              />
            )}
            emptyState={emptyState}
            roomAction={roomAction}
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
          api={api}
          combined={combined}
          onAliasesSaved={saveCombinationAliases}
          onAuthError={onAuthError}
          members={resolvedMembers.get(combined.id) ?? []}
          onChoose={(device, route) => choose({ kind: 'device', device, route, combinedParent: combined })}
          onEdit={() => openOverlay(overlayHref(`/combined-devices/${combined.id}/edit`))}
          onClose={() => closeOverlay()}
        />
      )}
      {selected?.kind === 'device' && selected.route === 'local' && detailDevice?.local && (
        <LocalControl
          key={detailDevice.local.id}
          api={api}
          room={roomName(detailDevice)}
          roomEditor={detailRoomEditor}
          device={detailDevice.local}
          gateway={detailGateway}
          cloudDevice={detailDevice.cloud.sharing ?? detailDevice.cloud.developer}
          routes={deviceRoutes(detailDevice)}
          onAuthError={onAuthError}
          onSetup={inventory && !api.isMember ? () => setupDetailDevice() : undefined}
          showMappingEditor={localMappingsReady}
          onMappingsSaved={(updated) => {
            setRecord((previous) => {
              if (previous?.api !== api || !previous.inventory) return previous;
              const local = previous.inventory.devices.map((device) => (device.id === updated.id ? updated : device));
              return { ...previous, inventory: { ...previous.inventory, devices: local } };
            });
          }}
          closeLabel={detailCloseLabel}
          onClose={close}
        />
      )}
      {detailDevice && detailProvider && detailCloud && (
        <CloudControl
          key={detailProvider + detailDevice.id}
          api={api}
          room={roomName(detailDevice)}
          roomEditor={detailRoomEditor}
          displayName={detailDevice.name}
          closeLabel={detailCloseLabel}
          device={detailCloud}
          roomPreview={previewKey ? {
            enabled: Boolean(cameraPreviews[previewKey]),
            available: deviceRoom(detailDevice) !== null,
            toggle: toggleRoomPreview,
          } : undefined}
          localDevice={detailDevice.local}
          gateway={detailGateway}
          routes={deviceRoutes(detailDevice)}
          provider={detailProvider}
          onClose={close}
          onAuthError={onAuthError}
        />
      )}
      {selected?.kind === 'group' && <GroupControl key={selected.group.id} api={api} group={selected.group} onAuthError={onAuthError} onClose={close} onDevice={device => choose({ kind: 'device', device: mergeDevices([device], cloud)[0], route: 'local', parent: selected.group })} />}
    </section>
  );
}
