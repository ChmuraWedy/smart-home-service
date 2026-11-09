import { MSG, t } from "./i18n";
import { CloudApi } from './api';
import type {
  AccountIdentity, HouseholdDeviceKey, HouseholdMember, IssuedMember, JsonValue, Provider,
} from './api';
import type { SavedLightScene, ScenePresetInput, TuyaSceneReference } from './light-scenes';
import type { DeviceTranslations, TranslatedText } from './device-translations';
import type { Locale } from './i18n';
import type { DashboardLayout, RoomNavigationLayout } from './dashboard-layout';
import type { DeviceRoute } from './devices';

export type Capability = {
  dp?: string; 'read_dp'?: string | null;
  type: 'boolean' | 'integer' | 'number' | 'string' | 'object';
  readable: boolean; writable: boolean; minimum?: number | null; maximum?: number | null;
  step?: number | null; enum?: JsonValue[] | null; unit?: string | null; encoding?: string;
};
export type Reading = { value: JsonValue; known: boolean; stale: boolean; observed_at?: string | null; received_at?:string; liveRequestAt?: number; source?:string };
export type DeviceState = { device_id: number; name: string; enabled: boolean; available: boolean; values: Record<string, Reading> };
export type LocalDevice = {
  id: number; device_id: string; name: string; aliases: string[]; building_id: number | null;
  room_id: number | null; transport: 'wifi' | 'zigbee'; parent_id: number | null; cid: string | null;
  enabled: boolean; capabilities: Record<string, Capability>;
  is_gateway?: boolean; ip?: string | null; version?: string | null; has_local_key?: boolean;
  mac?: string | null; 'product_id'?: string | null; category?: string | null;
  description?: string | null; 'last_seen_at'?: string | null;
  translations?: DeviceTranslations;
};
export type Building = { id: number; name: string; aliases: string[] };
export type Room = {
  id: number;
  building_id: number;
  name: string;
  aliases: string[];
  'name_translations'?: TranslatedText;
  'manual_name_languages'?: Locale[];
};
export type RoomNameChanges = Partial<Record<Locale, string | null>>;
export type RoomAppearance = { 'card_opacity': number; 'background_version': string | null };
export type Group = { id: number; name: string; room_id: number; device_ids: number[] };
export type GroupState = { group_id: number; state: 'on' | 'off' | 'mixed' | 'unknown'; members: DeviceState[] };
export type GroupResult = { all_acknowledged: boolean; results: { device_id: number; acknowledged: boolean }[] };
export type Inventory = { buildings: Building[]; rooms: Room[]; devices: LocalDevice[]; groups: Group[] };
export type CombinedPowerSource = { 'device_id': string; channel: string };
export type CombinedMemberInput = { 'device_id': string; route: DeviceRoute; 'power_source'?: CombinedPowerSource | null };
export type CombinedInput = { 'name': string; 'room_id': number | null; members: CombinedMemberInput[]; 'show_all_power'?: boolean; 'show_member_cards'?: boolean };
export type CombinedMember = CombinedMemberInput & { accessible: boolean; 'fallback_route'?: 'local' };
export type CombinedDevice = Omit<CombinedInput, 'members'> & { id: number; members: CombinedMember[]; aliases?: string[] };
export type CombinedPowerOutcome = 'accepted' | 'unavailable' | 'unsupported' | 'unknown';
export type CombinedPowerResult = { results: { 'device_id': string; outcome: CombinedPowerOutcome }[] };
export type Placement = { device_id: string; building_id: number | null; room_id: number | null };
export type TopologyJob = { status: 'idle' | 'running' | 'done' | 'failed'; processed: number; total: number; message: string | null };
export type Topology = { synced_at: string | null; warnings: number; empty_rooms_available: boolean; placements: Placement[]; job: TopologyJob };
export type DeviceDraft = {
  name: string; device_id: string; transport: 'wifi' | 'zigbee'; is_gateway: boolean;
  ip: string | null; version: string | null; parent_id: number | null; cid: string | null;
  local_key?: string;
};
export type ObservationReading = {
  key: string; code: string | null; dp: string | null; value: JsonValue;
  received_at: string | null; source: 'local' | 'cloud'; can_write: boolean;
};
export type ObservationChange = ObservationReading & { previous: JsonValue; detected_at: string; action: string };
export type ObservationSession = {
  session_id: string; device_id: string; mode: 'local' | 'cloud'; expires_in: number;
  interval_seconds: number; sample_count: number; has_local_key: boolean;
  readings: ObservationReading[]; changes: ObservationChange[];
  gateway_verification?: { ip: string; version: string; key_source: 'device' | 'child' };
};
export type ObservationAction = 'observe' | 'power' | 'brightness' | 'temperature' | 'color' | 'sensor' | 'button';
export type ConnectionAction = 'created' | 'updated' | 'unchanged';
export type ConnectionFinding = {
  finding_id: string; expires_in: number; action: ConnectionAction; verified: true;
  key_source: 'device' | 'child'; interface_address: string;
  requested_device_id: string; connection_device_id: string; route: 'direct' | 'gateway';
  device: { device_id: string; existing_id: number | null; name: string; aliases: string[];
    building_id: number | null; room_id: number | null; ip: string; version: string;
    changed_fields: ('ip' | 'version' | 'local_key')[]; is_gateway: boolean; 'timer_mappings'?: string[] };
};
export type ConnectionSaved = { action: ConnectionAction; device: LocalDevice; verified: true;
  key_source: 'device' | 'child'; interface_address: string };

export class HomeApi extends CloudApi {
  assistantEmbed(signal: AbortSignal) {
    return this.request<{ url: string | null }>('/assistant/embed', 'GET', undefined, signal);
  }

  lightPresets(device: string, signal: AbortSignal) {
    return this.request<SavedLightScene[]>(`/light-presets/${encodeURIComponent(device)}`, 'GET', undefined, signal);
  }

  saveLightPreset(device: string, preset: ScenePresetInput, id?: number) {
    const base = `/light-presets/${encodeURIComponent(device)}`;
    return this.request<SavedLightScene>(id === undefined ? base : `${base}/${id}`, id === undefined ? 'POST' : 'PUT', preset);
  }

  deleteLightPreset(device: string, id: number) {
    return this.deleteResource(`/light-presets/${encodeURIComponent(device)}/${id}`);
  }

  tuyaSceneReferences(signal: AbortSignal) {
    return this.request<TuyaSceneReference[]>('/cloud/scenes?provider=sharing', 'GET', undefined, signal);
  }

  dashboardLayout(browser: string, view: string, signal: AbortSignal) {
    return this.request<DashboardLayout>(`/dashboard-layouts/${browser}?${view}`, 'GET', undefined, signal);
  }

  saveDashboardLayout(browser: string, view: string, layout: DashboardLayout) {
    return this.request<DashboardLayout>(`/dashboard-layouts/${browser}?${view}`, 'PUT', layout);
  }

  roomNavigationLayout(browser: string, signal: AbortSignal) {
    const scope = this.isMember ? 'me' : browser;
    return this.request<RoomNavigationLayout>(`/dashboard-layouts/${scope}/room-navigation`, 'GET', undefined, signal);
  }

  saveRoomNavigationLayout(browser: string, layout: RoomNavigationLayout, signal: AbortSignal) {
    const scope = this.isMember ? 'me' : browser;
    return this.request<RoomNavigationLayout>(`/dashboard-layouts/${scope}/room-navigation`, 'PUT', layout, signal);
  }

  accountDashboardLayout(view: string, legacyBrowser: string | null, signal: AbortSignal) {
    const browser = this.account?.role === 'owner' && legacyBrowser ? `&browser_id=${legacyBrowser}` : '';
    return this.request<DashboardLayout>(`/dashboard-layouts/me?${view}${browser}`, 'GET', undefined, signal);
  }

  saveAccountDashboardLayout(view: string, layout: DashboardLayout) {
    return this.request<DashboardLayout>(`/dashboard-layouts/me?${view}`, 'PUT', layout);
  }

  householdMembers(signal: AbortSignal) {
    return this.request<HouseholdMember[]>('/accounts', 'GET', undefined, signal);
  }

  createHouseholdMember(name: string, login: string, deviceName: string) {
    return this.request<IssuedMember>('/accounts', 'POST', { name, login, device_name: deviceName });
  }

  nameHouseholdOwner(name: string, login: string) {
    return this.request<AccountIdentity>('/accounts/owner', 'PUT', { name, login });
  }

  householdDeviceKeys(id: string, signal?: AbortSignal) {
    return this.request<HouseholdDeviceKey[]>(`/accounts/${encodeURIComponent(id)}/keys`, 'GET', undefined, signal);
  }

  createHouseholdDeviceKey(id: string, name: string) {
    return this.request<HouseholdDeviceKey>(`/accounts/${encodeURIComponent(id)}/keys`, 'POST', { name });
  }

  householdDeviceKey(id: string, key: string) {
    return this.request<{ 'access_key': string }>(`/accounts/${encodeURIComponent(id)}/keys/${encodeURIComponent(key)}`);
  }

  revokeHouseholdDeviceKey(id: string, key: string) {
    return this.deleteResource(`/accounts/${encodeURIComponent(id)}/keys/${encodeURIComponent(key)}`);
  }

  revokeHouseholdMember(id: string) {
    return this.deleteResource(`/accounts/${encodeURIComponent(id)}`);
  }

  beginFunctionSetup(id: number, provider?: Provider, signal?: AbortSignal) {
    return this.request<ObservationSession>('/commissioning/devices/' + id, 'POST', { provider: provider || null }, signal);
  }
  findLocalConnection(device_id: string, provider: Provider, interface_address: string, signal?: AbortSignal, discovery_seconds?: number) {
    return this.request<ConnectionFinding>('/local-connections/find', 'POST', { device_id, provider, interface_address, ...(discovery_seconds === undefined ? {} : { discovery_seconds }) }, signal);
  }
  saveLocalConnection(finding_id: string) {
    return this.request<ConnectionSaved>('/local-connections/save', 'POST', { finding_id, confirmed: true });
  }
  topology(signal?: AbortSignal) { return this.request<Topology>('/cloud/topology', 'GET', undefined, signal); }
  syncTopology(signal?: AbortSignal) { return this.request<TopologyJob>('/cloud/topology/sync', 'POST', undefined, signal); }
  private async list<T>(path: string, signal?: AbortSignal): Promise<T[]> {
    const result: T[] = [];
    // Page metadata only; loading the inventory never contacts physical devices.
    for (let offset = 0; offset < 10_000; offset += 500) {
      const page = await this.request<T[]>(`${path}?offset=${offset}&limit=500`, 'GET', undefined, signal);
      if (!Array.isArray(page)) throw new Error(t(MSG.THE_SERVICE_RETURNED_AN_UNEXPECTED_LIST));
      result.push(...page);
      if (page.length < 500) return result;
    }
    throw new Error(t(MSG.THE_LIST_IS_TOO_LARGE));
  }

  combinations(signal: AbortSignal) {
    return this.request<CombinedDevice[]>('/combined-devices', 'GET', undefined, signal);
  }

  saveCombination(input: CombinedInput, id?: number) {
    return this.request<CombinedDevice>(id === undefined ? '/combined-devices' : `/combined-devices/${id}`, id === undefined ? 'POST' : 'PUT', input);
  }

  saveCombinationAliases(id: number, aliases: string[]) {
    return this.request<{ aliases: string[] }>(`/combined-devices/${id}/aliases`, 'PUT', { aliases });
  }

  async removeCombination(id: number) {
    await this.deleteResource(`/combined-devices/${id}`);
  }

  combinationPower(id: number, value: boolean) {
    return this.request<CombinedPowerResult>(`/combined-devices/${id}/power/${value ? 'on' : 'off'}`, 'POST');
  }

  async inventory(signal?: AbortSignal): Promise<Inventory> {
    const [buildings, rooms, devices, groups] = await Promise.all([
      this.list<Building>('/buildings', signal), this.list<Room>('/rooms', signal),
      this.list<LocalDevice>('/devices', signal), this.list<Group>('/groups', signal),
    ]);
    return { buildings, rooms, devices, groups };
  }

  async roomCatalog(signal?: AbortSignal) {
    const [buildings, rooms] = await Promise.all([this.list<Building>('/buildings', signal), this.list<Room>('/rooms', signal)]);
    return { buildings, rooms };
  }

  createBuilding(name: string) {
    return this.request<Building>('/buildings', 'POST', { name });
  }

  createRoom(name: string, buildingId: number, translations?: RoomNameChanges) {
    return this.request<Room>('/rooms', 'POST', { name, building_id: buildingId, name_translations: translations });
  }

  previewRoomName(name: string, signal: AbortSignal) {
    return this.request<TranslatedText>('/rooms/translation-preview', 'POST', { name }, signal);
  }

  renameRoom(roomId: number, name?: string, translations?: RoomNameChanges) {
    return this.request<Room>(`/rooms/${roomId}`, 'PATCH', { name, name_translations: translations });
  }

  deleteRoom(roomId: number) {
    return this.deleteResource(`/rooms/${roomId}`);
  }

  setLocalDeviceRoom(deviceId: number, roomId: number | null) {
    return this.request<LocalDevice>(`/devices/${deviceId}`, 'PATCH', { room_id: roomId });
  }

  roomAppearance(roomId: number, signal: AbortSignal) {
    return this.request<RoomAppearance>(`/rooms/${roomId}/appearance`, 'GET', undefined, signal);
  }

  setRoomOpacity(roomId: number, opacity: number) {
    return this.request<RoomAppearance>(`/rooms/${roomId}/appearance`, 'PATCH', { card_opacity: opacity });
  }

  roomBackground(roomId: number, signal: AbortSignal) {
    return this.readBlob(`/rooms/${roomId}/background`, signal);
  }

  uploadRoomBackground(roomId: number, image: Blob) {
    return this.request<RoomAppearance>(`/rooms/${roomId}/background`, 'PUT', image);
  }

  removeRoomBackground(roomId: number) {
    return this.request<RoomAppearance>(`/rooms/${roomId}/background`, 'DELETE');
  }

  device(id: number, signal?: AbortSignal) { return this.request<LocalDevice>(`/devices/${id}`, 'GET', undefined, signal); }

  localTimerSuggestion(id: number, name: string, signal: AbortSignal) {
    return this.request<{ dp: string; minimum: number; maximum: number; step: number } | null>(
      `/commissioning/devices/${id}/mappings/${encodeURIComponent(name)}/suggestion`,
      'GET',
      undefined,
      signal,
    );
  }

  editLocalMapping(id: number, name: string, expected: Capability, mapping: Capability) {
    return this.request<LocalDevice>(`/commissioning/devices/${id}/mappings/${encodeURIComponent(name)}`, 'PATCH', { expected, mapping });
  }

  state(id: number, refresh = false, signal?: AbortSignal, watch = false) {
    return this.request<DeviceState>(`/devices/${id}/state?refresh=${refresh}&max_age=60${watch ? "&watch=true" : ""}`, 'GET', undefined, signal);
  }
  setCapability(id: number, name: string, value: JsonValue) {
    return this.setCapabilities(id, { [name]: value });
  }
  setCapabilities(id: number, values: Record<string, JsonValue>) {
    return this.request<{ acknowledged: boolean }>(`/devices/${id}/commands/capabilities`, 'POST', { values });
  }
  groupState(id: number, signal?: AbortSignal) { return this.request<GroupState>(`/groups/${id}/state`, 'GET', undefined, signal); }
  groupCommand(id: number, command: 'on' | 'off') { return this.request<GroupResult>(`/groups/${id}/commands/${command}`, 'POST'); }
  beginObservation(draft: DeviceDraft, mode: 'local' | 'cloud', provider?: Provider, signal?: AbortSignal) {
    return this.request<ObservationSession>('/commissioning', 'POST', { draft, mode, provider: provider || null }, signal);
  }
  discoverGatewayKey(draft: DeviceDraft, provider: Provider, signal?: AbortSignal) {
    return this.request<ObservationSession>('/commissioning', 'POST', { draft, mode: 'local', provider, discover_gateway_key: true }, signal);
  }
  observationSample(id: string, action: ObservationAction, signal?: AbortSignal) {
    return this.request<ObservationSession>(`/commissioning/${encodeURIComponent(id)}/samples`, 'POST', { action }, signal);
  }
  async cancelObservation(id: string) { await this.deleteResource(`/commissioning/${encodeURIComponent(id)}`); }
  registerObservation(id: string, body: { name: string; aliases: string[]; room_id: number | null; building_id: number | null; reviewed: true; writable: string[] }) {
    return this.request<LocalDevice>(`/commissioning/${encodeURIComponent(id)}/register`, 'POST', body);
  }
}
