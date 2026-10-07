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
};
export type DeveloperCredentials = {
  access_id: string;
  access_secret: string;
  region: Region;
  sample_device_id: string | null;
};
export type QRLogin = { session_id: string; qr_url: string; expires_in: number };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CloudFunction = { code: string; type: string; values: string | Record<string, unknown> | null };
export type CloudFunctions = { device_id: string; functions: CloudFunction[]; status_range?: CloudFunction[] };
export type CloudSnapshot = {
  device_id: string; online: boolean; source: string;
  status: Record<string, JsonValue>; device_update_time?: number | null; status_range?: CloudFunction[];
};
export type CloudCommandResult = { acknowledged: boolean; state_confirmed: boolean };

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export function normalizeApiBase(input: string): string {
  const value = input.trim();
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Укажите полный адрес API, например http://192.168.1.10:8000.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Адрес API должен быть HTTP(S), без пароля, параметров и фрагмента.');
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
      throw new Error('Сервис вернул недопустимый путь запроса.');
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
      if (response.status === 401) throw new ApiError('Ключ доступа недействителен. Проверьте настройки подключения.', 401);
      if (!response.ok) {
        let detail: unknown;
        try { detail = (await response.json()).detail; } catch { /* Non-JSON proxy error. */ }
        throw new ApiError(typeof detail === 'string' ? detail : `Сервис не выполнил запрос (${response.status}).`, response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(timeout.signal.aborted ? 'Сервис не ответил вовремя. Попробуйте ещё раз.' : 'Не удалось связаться с API. Проверьте адрес, доступность сервиса и разрешённый адрес интерфейса.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  protected async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.response('/api/v1' + path, method, body, signal);
    try { return await response.json() as T; }
    catch { throw new Error('Сервис вернул неожиданный ответ.'); }
  }

  private json<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('/cloud' + path, method, body, signal);
  }

  status(signal?: AbortSignal) { return this.json<CloudStatus>('/status', 'GET', undefined, signal); }
  saveCode(user_code: string) { return this.json<CodeStatus>('/user-code', 'PUT', { user_code }); }
  saveDeveloper(body: DeveloperCredentials) { return this.json<DeveloperStatus>('/developer/credentials', 'PUT', body); }
  connectDeveloper() { return this.json<DeveloperStatus>('/developer/connect', 'POST'); }
  beginQR() { return this.json<QRLogin>('/login/qr', 'POST', {}); }
  confirmQR(session: string) { return this.json<{ connected: boolean }>('/login/' + encodeURIComponent(session) + '/confirm', 'POST'); }
  devices(provider: Provider) { return this.json<CloudDevice[]>('/devices?refresh=true&provider=' + provider); }
  deviceFunctions(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<CloudFunctions>('/devices/' + encodeURIComponent(id) + '/functions?provider=' + provider, 'GET', undefined, signal);
  }
  deviceSnapshot(id: string, provider: Provider, signal?: AbortSignal) {
    return this.json<CloudSnapshot>('/devices/' + encodeURIComponent(id) + '/status?refresh=true&provider=' + provider, 'GET', undefined, signal);
  }
  sendDeviceCommands(id: string, provider: Provider, commands: { code: string; value: JsonValue }[]) {
    return this.json<CloudCommandResult>('/devices/' + encodeURIComponent(id) + '/commands?provider=' + provider, 'POST', { commands });
  }

  async qrImage(login: QRLogin): Promise<Blob> {
    // Resolve only this account's QR endpoint on the configured API. Never send
    // the service key to a URL supplied by a different origin.
    const expected = '/api/v1/cloud/login/' + encodeURIComponent(login.session_id) + '/qr.svg';
    if (login.qr_url !== expected) throw new Error('Сервис вернул недопустимый адрес QR-кода.');
    const response = await this.response(expected, 'GET');
    return response.blob();
  }
}
