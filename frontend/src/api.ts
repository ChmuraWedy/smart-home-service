import { t } from "./i18n";
export type Provider = 'sharing' | 'developer';
export type Region = 'eu' | 'eu-w' | 'us' | 'us-e' | 'cn' | 'in' | 'sg';
export type Connection = { baseUrl: string; token: string };
export type DeveloperStatus = {
  configured: boolean;
  connected: boolean;
  region?: Region;
  device_count?: number;
};
export type CloudStatus = {
  enabled: boolean;
  connected: boolean;
  has_saved_user_code: boolean;
  saved_user_code_requires_login: boolean;
  developer: DeveloperStatus;
};
export type CodeStatus = Pick<CloudStatus, 'connected' | 'has_saved_user_code' | 'saved_user_code_requires_login'>;
export type CloudDevice = {
  id: string;
  name: string;
  category?: string;
  online: boolean;
  sub?: boolean;
  has_local_key: boolean;
  node_id?: string | null;
  aliases?: string[];
  battery?: { code: string; value: JsonValue; unit?: string | null } | null;
  controls?: { ready: boolean; definitions: CloudFunctions; snapshot: CloudSnapshot };
};
export type DeveloperCredentials = {
  access_id: string;
  access_secret: string;
  region: Region;
  sample_device_id: string | null;
};
export type QRLogin = { session_id: string; qr_url: string; expires_in: number };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CloudFunction = { code: string; type: string; values: string | Record<string, unknown> | null; dp_id?: number; dp_ids?: number[]; user_label?: string };
export type MappingInput = { kind: 'remote' | 'zigbee_group' | 'multi_control'; source_code: string; source_dp_id: number | null; target_device_id: string; target_code: string; target_dp_id: number | null };
export type DeviceMapping = MappingInput & { id: number; source_device_id: string; origin: 'manual'; applied_to_tuya: false };
export type MappingList = { device_id: string; provider: Provider; tuya_bindings_available: false; mappings: DeviceMapping[] };
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
export type NetworkInterface = { name: string; address: string; network: string; broadcast: string };
export type LanDevice = {
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
  catch { throw new Error(t("Укажите полный адрес API, например http://192.168.1.10:8000.")); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(t("Адрес API должен быть HTTP(S), без пароля, параметров и фрагмента."));
  }
  return url.href.replace(/\/+$/, '');
}

export class CloudApi {
  readonly baseUrl: string;
  constructor(private readonly connection: Connection) {
    this.baseUrl = normalizeApiBase(connection.baseUrl);
  }

  private url(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      throw new Error(t("Сервис вернул недопустимый путь запроса."));
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
      const response = await fetch(this.url(path), {
        method,
        headers: { 'X-API-Key': this.connection.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: timeout.signal,
      });
      if (response.status === 401) throw new ApiError(t("Ключ доступа недействителен. Проверьте настройки подключения."), 401);
      if (!response.ok) {
        let detail: unknown;
        try { detail = (await response.json()).detail; } catch { /* Non-JSON proxy error. */ }
        throw new ApiError(typeof detail === 'string' ? t(detail) : t("Сервис не выполнил запрос ({0}).", [response.status]), response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(timeout.signal.aborted ? t("Сервис не ответил вовремя. Попробуйте ещё раз.") : t("Не удалось связаться с API. Проверьте адрес, доступность сервиса и разрешённый адрес интерфейса."));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  protected async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.response('/api/v1' + path, method, body, signal);
    try { return await response.json() as T; }
    catch { throw new Error(t("Сервис вернул неожиданный ответ.")); }
  }

  protected async deleteResource(path: string): Promise<void> {
    await this.response('/api/v1' + path, 'DELETE');
  }

  private json<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('/cloud' + path, method, body, signal);
  }

  status(signal?: AbortSignal) { return this.json<CloudStatus>('/status', 'GET', undefined, signal); }
  deviceActivity(id: string, provider: Provider | 'local', before?: number, signal?: AbortSignal) {
    return this.request<{ device_id: string; events: DeviceEvent[]; next_before: number | null }>('/activity/devices/' + encodeURIComponent(id) + '?provider=' + provider + (before ? '&before=' + before : ''), 'GET', undefined, signal);
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
  confirmQR(session: string) { return this.json<{ connected: boolean }>('/login/' + encodeURIComponent(session) + '/confirm', 'POST'); }
  devices(provider: Provider, signal?: AbortSignal) { return this.json<CloudDevice[]>('/devices?refresh=true&provider=' + provider, 'GET', undefined, signal); }
  cameraStream(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<{device_id:string;type:"hls";url:string}>('/devices/' + encodeURIComponent(id) + '/stream?provider=' + provider, 'POST', {}, signal);
  }
  deviceFunctions(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<CloudFunctions>('/devices/' + encodeURIComponent(id) + '/functions?provider=' + provider, 'GET', undefined, signal);
  }
  saveChannelLabels(id: string, provider: Provider, labels: Record<string, string | null>, signal?: AbortSignal) {
    return this.json<{ device_id: string; labels: Record<string, string> }>('/devices/' + encodeURIComponent(id) + '/channel-labels?provider=' + provider, 'PUT', { labels }, signal);
  }
  deviceAliases(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<{ device_id: string; aliases: string[] }>('/devices/' + encodeURIComponent(id) + '/aliases?provider=' + provider, 'GET', undefined, signal);
  }
  saveDeviceAliases(id: string, provider: Provider, aliases: string[], signal?: AbortSignal) {
    return this.json<{ device_id: string; aliases: string[] }>('/devices/' + encodeURIComponent(id) + '/aliases?provider=' + provider, 'PUT', { aliases }, signal);
  }
  saveLocalDeviceAliases(id: number, aliases: string[], signal?: AbortSignal) {
    return this.request<{ device_id: string; aliases: string[] }>('/devices/' + id, 'PATCH', { aliases }, signal);
  }
  deviceSnapshot(id: string, provider: Provider, signal?: AbortSignal, refresh = true) {
    return this.json<CloudSnapshot>('/devices/' + encodeURIComponent(id) + '/status?refresh=' + refresh + '&provider=' + provider, 'GET', undefined, signal);
  }
  sendDeviceCommands(id: string, provider: Provider, commands: { code: string; value: JsonValue }[]) {
    return this.json<CloudCommandResult>('/devices/' + encodeURIComponent(id) + '/commands?provider=' + provider, 'POST', { commands });
  }
  deviceMappings(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<MappingList>('/devices/' + encodeURIComponent(id) + '/mappings?provider=' + provider, 'GET', undefined, signal);
  }
  saveDeviceMapping(id: string, provider: Provider, body: MappingInput, mappingId?: number) {
    return this.json<DeviceMapping>('/devices/' + encodeURIComponent(id) + '/mappings' + (mappingId ? '/' + mappingId : '') + '?provider=' + provider, mappingId ? 'PUT' : 'POST', body);
  }
  async deleteDeviceMapping(id: string, provider: Provider, mappingId: number) {
    await this.response('/api/v1/cloud/devices/' + encodeURIComponent(id) + '/mappings/' + mappingId + '?provider=' + provider, 'DELETE');
  }

  async qrImage(login: QRLogin): Promise<Blob> {
    // Resolve only this account's QR endpoint on the configured API. Never send
    // the service key to a URL supplied by a different origin.
    const expected = '/api/v1/cloud/login/' + encodeURIComponent(login.session_id) + '/qr.svg';
    if (login.qr_url !== expected) throw new Error(t("Сервис вернул недопустимый адрес QR-кода."));
    const response = await this.response(expected, 'GET');
    return response.blob();
  }
}
