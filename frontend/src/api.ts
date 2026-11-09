import { MSG, t, translateText } from "./i18n";
import type { DeviceTranslations, TranslationSaved, TranslationWrite } from './device-translations';
export type Provider = 'sharing' | 'developer';
type SavedDeviceAliases = { device_id: string; aliases: string[]; translations?: DeviceTranslations };
export type Region = 'eu' | 'eu-w' | 'us' | 'us-e' | 'cn' | 'in' | 'sg';
export type Connection = { baseUrl: string; token: string };
export type DeveloperStatus = {
  configured: boolean;
  connected: boolean;
  region?: Region;
  device_count?: number;
};
export type HouseholdMember = { id: string; 'name': string; login: string };
export type AccountIdentity = HouseholdMember & {
  role: 'owner' | 'member'; 'key_id'?: string | null; 'needs_name'?: boolean;
};
export type HouseholdDeviceKey = { id: string; 'name': string; 'key_available': boolean };
export type IssuedMember = HouseholdMember & { 'key_id': string };
export type CloudStatus = {
  'redroid_available'?: boolean;
  account?: AccountIdentity;
  enabled: boolean;
  connected: boolean;
  has_saved_user_code: boolean;
  saved_user_code_requires_login: boolean;
  developer: DeveloperStatus;
};
export type CodeStatus = Pick<CloudStatus, 'connected' | 'has_saved_user_code' | 'saved_user_code_requires_login'>;
export type AppRoomAssignment = { 'room_id': number | null; 'building_id': number | null };
export type CloudDevice = {
  id: string;
  name: string;
  category?: string;
  'product_id'?: string | null;
  'support_local'?: boolean | null;
  'gateway_id'?: string | null;
  online: boolean;
  sub?: boolean;
  has_local_key: boolean;
  node_id?: string | null;
  aliases?: string[];
  'app_room'?: AppRoomAssignment;
  'synced_room'?: AppRoomAssignment;
  translations?: DeviceTranslations;
  battery?: { code: string; value: JsonValue; unit?: string | null } | null;
  controls?: { ready: boolean; definitions: CloudFunctions; snapshot: CloudSnapshot };
};
export type DeveloperCredentials = {
  access_id: string;
  access_secret: string;
  region: Region;
  sample_device_id: string | null;
};
export type RedroidCredentials = { region: string; account: string; password: string };
export type QRLogin = { session_id: string; qr_url: string; expires_in: number };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CloudFunction = { code: string; type: string; values: string | Record<string, unknown> | null; dp_id?: number; dp_ids?: number[]; user_label?: string };
export type CloudFunctions = { device_id: string; functions: CloudFunction[]; status_range?: CloudFunction[] };
export type CloudSnapshot = {
  device_id: string; online: boolean; source: string;
  status: Record<string, JsonValue>; device_update_time?: number | null; status_range?: CloudFunction[];
  snapshot_received_at?: string | null; event_stream_connected?: boolean;
  status_observations?: Record<string, {observed_at: string | null; received_at: string}>;
};
export type CloudCommandResult = { acknowledged: boolean; state_confirmed: boolean };
export type DeviceEvent = { id: number; at: string; observed_at: string | null; kind: string; code: string; value: JsonValue; outcome: string | null };
export type NetworkWatch = {
  watch_id: string; device_id: string; target_id: string; route: 'direct' | 'gateway';
  configured_ip: string | null; observed_ip: string | null; version: string | null;
  last_seen: string | null; packets: number; listening: boolean; ports: number[]; failed_ports: number[];
  remaining_seconds: number; changes: { at: string; previous_ip: string | null; ip: string }[];
};
export type NetworkObservation = Omit<NetworkWatch, 'watch_id' | 'remaining_seconds'> & { enabled: boolean };
export type NetworkInterface = { name: string; address: string; network: string; broadcast: string };
export type LanDevice = {
  cached?: boolean;
  ip: string; device_id: string | null; version: string | null; hostname: string | null;
  mac: string | null; protocols: string[]; services: string[]; packets: number;
  first_seen: string | null; last_seen: string | null;
  changes: { at: string; previous_ip: string; ip: string }[];
};
export type NetworkScan = {
  scan_id: string; interface: NetworkInterface | null; devices: LanDevice[];
  events: { at: string; ip: string; port: number; protocol: string; device_id: string | null }[];
  packets: number; recognized_packets: number; neighbors_available: boolean | null;
  discovery_requests: number; truncated: boolean; listening: boolean; ports: number[];
  failed_ports: number[]; remaining_seconds: number;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export function normalizeApiBase(input: string): string {
  const value = input.trim();
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(t(MSG.ENTER_A_FULL_API_ADDRESS_FOR_EXAMPLE_HTTP)); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(t(MSG.THE_API_ADDRESS_MUST_USE_HTTP_S_WITHOUT));
  }
  return url.href.replace(/\/+$/, '');
}

export class CloudApi {
  readonly baseUrl: string;
  constructor(private readonly connection: Connection, readonly account?: AccountIdentity) {
    this.baseUrl = normalizeApiBase(connection.baseUrl);
  }

  get isMember() { return this.account?.role === 'member'; }

  private url(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      throw new Error(t(MSG.THE_SERVICE_RETURNED_AN_INVALID_REQUEST_PATH));
    }
    return this.baseUrl + path;
  }

  private async response(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 120_000);
    try {
      const binary = body instanceof Blob;
      const transport = import.meta.env.MODE === 'demo' ? (await import('./demo/backend')).default : fetch;
      const response = await transport(this.url(path), {
        method,
        headers: { 'X-API-Key': this.connection.token, ...(body === undefined ? {} : { 'Content-Type': binary ? body.type : 'application/json' }) },
        body: binary ? body : JSON.stringify(body),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: timeout.signal,
      });
      if (response.status === 401) throw new ApiError(t(MSG.INVALID_ACCESS_KEY), 401);
      if (!response.ok) {
        let detail: unknown;
        try { detail = (await response.json()).detail; } catch { /* Non-JSON proxy error. */ }
        throw new ApiError(typeof detail === 'string' ? translateText(detail) : t(MSG.THE_SERVICE_COULD_NOT_COMPLETE_THE_REQUEST, [response.status]), response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(timeout.signal.aborted ? t(MSG.THE_SERVICE_DID_NOT_RESPOND_IN_TIME) : t(MSG.COULD_NOT_REACH_THE_API));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  verifyHouseholdLogin(login: string) {
    return this.request<AccountIdentity>('/accounts/login', 'POST', { login });
  }

  protected async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.response('/api/v1' + path, method, body, signal);
    try { return await response.json() as T; }
    catch { throw new Error(t(MSG.THE_SERVICE_RETURNED_AN_UNEXPECTED_RESPONSE)); }
  }

  protected async deleteResource(path: string): Promise<void> {
    await this.response('/api/v1' + path, 'DELETE');
  }

  protected async readBlob(path: string, signal: AbortSignal): Promise<Blob> {
    const response = await this.response(`/api/v1${path}`, 'GET', undefined, signal);
    return response.blob();
  }

  private json<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('/cloud' + path, method, body, signal);
  }

  status(signal?: AbortSignal) { return this.json<CloudStatus>('/status', 'GET', undefined, signal); }
  deviceActivity(id: string, provider: Provider | 'local', before?: number, signal?: AbortSignal) {
    return this.request<{ device_id: string; events: DeviceEvent[]; next_before: number | null }>('/activity/devices/' + encodeURIComponent(id) + '?provider=' + provider + (before ? '&before=' + before : ''), 'GET', undefined, signal);
  }
  deviceNetworkObservation(id: string, provider: Provider | 'local', signal?: AbortSignal) {
    return this.request<NetworkObservation>('/network/devices/' + encodeURIComponent(id) + '/observation?provider=' + provider, 'GET', undefined, signal);
  }
  startNetworkWatch(id: string, provider: Provider | 'local', signal?: AbortSignal) {
    return this.request<NetworkWatch>('/network/devices/' + encodeURIComponent(id) + '/watch?provider=' + provider, 'POST', {}, signal);
  }
  networkInterfaces(signal?: AbortSignal) { return this.request<NetworkInterface[]>('/network/interfaces', 'GET', undefined, signal); }
  startNetworkScan(address: string, signal?: AbortSignal) { return this.request<NetworkScan>('/network/scans', 'POST', { interface_address: address }, signal); }
  networkScan(id: string, signal?: AbortSignal) { return this.request<NetworkScan>('/network/scans/' + encodeURIComponent(id), 'GET', undefined, signal); }
  requestNetworkAnnouncements(id: string, signal?: AbortSignal) { return this.request<NetworkScan>('/network/scans/' + encodeURIComponent(id) + '/discover', 'POST', {}, signal); }
  stopNetworkScan(id: string) { return this.deleteResource('/network/scans/' + encodeURIComponent(id)); }
  networkWatch(id: string, signal?: AbortSignal) { return this.request<NetworkWatch>('/network/watches/' + encodeURIComponent(id), 'GET', undefined, signal); }
  stopNetworkWatch(id: string) { return this.deleteResource('/network/watches/' + encodeURIComponent(id)); }
  saveCode(user_code: string) { return this.json<CodeStatus>('/user-code', 'PUT', { user_code }); }
  saveDeveloper(body: DeveloperCredentials) { return this.json<DeveloperStatus>('/developer/credentials', 'PUT', body); }
  connectDeveloper() { return this.json<DeveloperStatus>('/developer/connect', 'POST'); }
  beginQR() { return this.json<QRLogin>('/login/qr', 'POST', {}); }
  loginRedroid(body: RedroidCredentials) {
    return this.json<{ 'screen': 'home' | 'verification' }>('/login/redroid/credentials', 'POST', body);
  }

  beginRedroidQR() {
    return this.json<QRLogin & { 'android_approval_ready': boolean }>('/login/redroid/qr', 'POST');
  }

  confirmRedroidQR(session: string) {
    return this.json<{ 'connected': boolean }>(`/login/redroid/${encodeURIComponent(session)}/confirm`, 'POST');
  }

  confirmQR(session: string) { return this.json<{ connected: boolean }>('/login/' + encodeURIComponent(session) + '/confirm', 'POST'); }
  devices(provider: Provider, signal?: AbortSignal) { return this.json<CloudDevice[]>('/devices?refresh=true&provider=' + provider, 'GET', undefined, signal); }
  cameraStream(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<{device_id:string;type:"hls";url:string}>('/devices/' + encodeURIComponent(id) + '/stream/relay?provider=' + provider, 'POST', {}, signal);
  }
  deviceFunctions(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<CloudFunctions>('/devices/' + encodeURIComponent(id) + '/functions?provider=' + provider, 'GET', undefined, signal);
  }

  setCloudDeviceRoom(id: string, provider: Provider, roomId: number | null) {
    return this.json<AppRoomAssignment>(`/devices/${encodeURIComponent(id)}/room?provider=${provider}`, 'PUT', { room_id: roomId });
  }

  saveChannelLabels(id: string, provider: Provider, labels: Record<string, string | null>, signal?: AbortSignal) {
    return this.json<{ device_id: string; labels: Record<string, string> }>('/devices/' + encodeURIComponent(id) + '/channel-labels?provider=' + provider, 'PUT', { labels }, signal);
  }
  deviceAliases(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<{ device_id: string; aliases: string[] }>('/devices/' + encodeURIComponent(id) + '/aliases?provider=' + provider, 'GET', undefined, signal);
  }
  saveDeviceAliases(id: string, provider: Provider, aliases: string[], signal?: AbortSignal) {
    return this.json<SavedDeviceAliases>('/devices/' + encodeURIComponent(id) + '/aliases?provider=' + provider, 'PUT', { aliases }, signal);
  }
  saveLocalDeviceAliases(id: number, aliases: string[], signal?: AbortSignal) {
    return this.request<SavedDeviceAliases>('/devices/' + id, 'PATCH', { aliases }, signal);
  }

  saveDeviceTranslation(id: string, provider: Provider, body: TranslationWrite, signal?: AbortSignal) {
    return this.json<TranslationSaved>(`/devices/${encodeURIComponent(id)}/translations?provider=${provider}`, 'PUT', body, signal);
  }

  saveLocalDeviceTranslation(id: number, body: TranslationWrite, signal?: AbortSignal) {
    return this.request<TranslationSaved>(`/devices/${id}/translations`, 'PUT', body, signal);
  }
  deviceSnapshot(id: string, provider: Provider, signal?: AbortSignal, refresh = true, watch = false) {
    const query = new URLSearchParams({ refresh: String(refresh), provider });
    if (watch) query.set('watch', 'true');
    return this.json<CloudSnapshot>(`/devices/${encodeURIComponent(id)}/status?${query}`, 'GET', undefined, signal);
  }
  sendDeviceCommands(id: string, provider: Provider, commands: { code: string; value: JsonValue }[]) {
    return this.json<CloudCommandResult>('/devices/' + encodeURIComponent(id) + '/commands?provider=' + provider, 'POST', { commands });
  }

  async qrImage(login: QRLogin): Promise<Blob> {
    // Resolve only this account's QR endpoint on the configured API. Never send
    // the service key to a URL supplied by a different origin.
    const expected = '/api/v1/cloud/login/' + encodeURIComponent(login.session_id) + '/qr.svg';
    if (login.qr_url !== expected) throw new Error(t(MSG.THE_SERVICE_RETURNED_AN_INVALID_QR_CODE_URL));
    const response = await this.response(expected, 'GET');
    return response.blob();
  }
}
