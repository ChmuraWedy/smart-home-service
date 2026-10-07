import { describe, expect, it, vi } from 'vitest';
import { CloudApi, normalizeApiBase } from './api';

const connection = { baseUrl: 'http://api.test:8765', token: 'service-test-key' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('separate API transport', () => {
  it('sends credentials only in a header to the selected API, including a path prefix', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ connected: true }));
    await new CloudApi({ ...connection, baseUrl: connection.baseUrl + '/backend/' }).saveCode('private-user-code');
    expect(fetch).toHaveBeenCalledWith('http://api.test:8765/backend/api/v1/cloud/user-code', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ user_code: 'private-user-code' }),
      headers: { 'X-API-Key': 'service-test-key', 'Content-Type': 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store',
    }));
    expect(vi.mocked(fetch).mock.calls[0][0]).not.toContain(connection.token);
  });

  it('loads a QR image from the API origin instead of the frontend origin', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }));
    const image = await new CloudApi(connection).qrImage({ session_id: 'session-1', qr_url: '/api/v1/cloud/login/session-1/qr.svg', expires_in: 120 });
    expect(image.size).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith('http://api.test:8765/api/v1/cloud/login/session-1/qr.svg', expect.objectContaining({ headers: { 'X-API-Key': connection.token } }));
  });

  it('rejects external or unrelated QR URLs before sending the API key', async () => {
    const api = new CloudApi(connection);
    for (const qr_url of ['https://external.test/qr.svg', '//external.test/qr.svg', '/api/v1/cloud/login/other/qr.svg']) {
      await expect(api.qrImage({ session_id: 'session-1', qr_url, expires_in: 120 })).rejects.toThrow('недопустимый адрес');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the provider explicit and encodes the QR session ID', async () => {
    vi.mocked(fetch).mockImplementation(async () => json([]));
    const api = new CloudApi(connection);
    await api.devices('developer');
    await api.confirmQR('id/with spaces');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(connection.baseUrl + '/api/v1/cloud/devices?refresh=true&provider=developer');
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(connection.baseUrl + '/api/v1/cloud/login/id%2Fwith%20spaces/confirm');
  });

  it('reports authorization failure without displaying an unexpected error body', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('private-upstream-body', { status: 401 }));
    await expect(new CloudApi(connection).status()).rejects.toMatchObject({
      status: 401, message: 'Ключ доступа недействителен. Проверьте настройки подключения.',
    });
  });

  it('handles an HTML proxy failure without dumping its body', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>internal-proxy-info</html>', { status: 502 }));
    await expect(new CloudApi(connection).status()).rejects.toThrow('Сервис не выполнил запрос (502)');
  });

  it('aborts a stalled request with a visible timeout instead of retrying it', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const assertion = expect(new CloudApi(connection).status()).rejects.toThrow('не ответил вовремя');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('validates the address before any request', () => {
    expect(normalizeApiBase(' https://api.test/backend/ ')).toBe('https://api.test/backend');
    for (const address of ['javascript:alert(1)', 'https://user:secret@api.test', 'https://api.test?key=secret', '/api']) {
      expect(() => new CloudApi({ baseUrl: address, token: 'key' })).toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
