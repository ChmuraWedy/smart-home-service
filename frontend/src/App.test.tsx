import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './test/App';
import { DEFAULT_API_BASE, STORAGE_KEY } from './connection';
import type { CloudStatus } from './api';

const BASE = 'http://api.test:8765';
const TOKEN = 'valid-service-key';
function stored(baseUrl = BASE) { localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl, token: TOKEN })); }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function fakeApi(initial: Partial<CloudStatus> = {}) {
  const status: CloudStatus = {
    enabled: true, connected: true, has_saved_user_code: true, saved_user_code_requires_login: false,
    developer: { configured: true, connected: false, region: 'eu' }, ...initial,
  };
  const calls: { path: string; method: string; body: Record<string, unknown> | undefined; token: string | undefined }[] = [];
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const path = new URL(String(input)).pathname;
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    const token = (options?.headers as Record<string, string> | undefined)?.['X-API-Key'];
    calls.push({ path, method: options?.method || 'GET', body, token });
    if (token !== TOKEN) return json({ detail: 'Unauthorized' }, 401);
    if (path === '/api/v1/network/interfaces') return json([{name:'en1', address:'192.168.40.147', network:'192.168.40.0/24', broadcast:'192.168.40.255'}]);
    if (path === '/api/v1/cloud/topology') return json({ synced_at: null, warnings: 0, placements: [], job: { status: 'idle', processed: 0, total: 0, message: null } });
    if (path.endsWith('/status')) return json(status);
    if (path.endsWith('/user-code')) {
      status.has_saved_user_code = true; status.saved_user_code_requires_login = true;
      return json({ has_saved_user_code: true, connected: status.connected, saved_user_code_requires_login: true });
    }
    if (path.endsWith('/developer/credentials')) {
      status.developer = { configured: true, connected: false, region: body?.region as 'eu' };
      return json(status.developer);
    }
    if (path.endsWith('/developer/connect')) {
      status.developer.connected = true; status.developer.device_count = 2;
      return json(status.developer);
    }
    if (path.endsWith('/login/qr')) return json({ session_id: 'qr-session', qr_url: '/api/v1/cloud/login/qr-session/qr.svg', expires_in: 120 });
    if (path.endsWith('/login/redroid/credentials')) return json({ screen: 'home' });
    if (path.endsWith('/login/redroid/qr')) return json({ session_id: 'android-session', qr_url: '/api/v1/cloud/login/android-session/qr.svg', expires_in: 90, android_approval_ready: true });
    if (path.endsWith('/qr.svg')) return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
    if (path.endsWith('/confirm')) {
      status.connected = true; status.saved_user_code_requires_login = false;
      return json({ connected: true });
    }
    if (['/api/v1/buildings','/api/v1/rooms','/api/v1/groups','/api/v1/devices'].includes(path)) return json([]);
    if (path.endsWith('/devices')) return json([
      { id: 'device-1', name: 'Лампа кухни', category: 'dj', online: true, sub: false, has_local_key: true },
      { id: 'device-2', name: '<script>alert(1)</script>', online: false, sub: true, has_local_key: false },
    ]);
    throw new Error('Unexpected test request');
  });
  return { calls, status };
}

async function go(user: ReturnType<typeof userEvent.setup>, name: string) { await user.click(screen.getByRole('button', { name: 'Меню' })); await user.click(screen.getByRole('button', { name })); }

it('opens local connections from the hamburger and restores its direct URL', async () => {
  stored(); window.history.replaceState(null, '', '/#local-connections');
  const backend = fakeApi(); render(<App />); await screen.findByText('API подключён');
  expect(screen.getByRole('heading', { name: 'Локальные подключения' })).toBeInTheDocument();
  await screen.findByRole('option', { name: /192.168.40.0/ });
  expect(screen.getByRole('button', { name: 'Найти устройства' })).toBeDisabled();
  expect(screen.queryByRole('combobox', { name: 'Устройство' })).toBeNull();
  expect(backend.calls.some(call => call.path.endsWith('/find') || call.path.endsWith('/save'))).toBe(false);
  await go(userEvent.setup(), 'Сеть и пакеты'); expect(window.location.pathname).toBe('/network');
  await go(userEvent.setup(), 'Локальные подключения'); expect(window.location.pathname).toBe('/local-connections');
  expect(screen.getByRole('heading', { name: 'Локальные подключения' })).toBeInTheDocument();
});

async function restored(connections = true) {
  stored(); const backend = fakeApi(); render(<App />);
  await screen.findByText('API подключён');
  if (connections) await go(userEvent.setup(), 'Подключения');
  return backend;
}

it('uses the Android Docker session from the LAN dashboard without entering a password', async () => {
  vi.stubGlobal('isSecureContext', false);
  vi.stubEnv('VITE_DASHBOARD_HTTPS_ORIGIN', 'https://homeassistant.dom:8443');
  try {
    stored(window.location.origin);
    window.history.replaceState(null, '', '/settings/connections?provider=android');
    const backend = fakeApi({ redroid_available: true });
    render(<App />);
    const user = userEvent.setup();
    const connect = await screen.findByRole('button', { name: 'Использовать текущий сеанс Android' });
    expect(screen.getByText('Smart Life подключён.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть защищённый вход в Smart Life' }))
      .toHaveAttribute('href', 'https://homeassistant.dom:8443/settings/connections?provider=android');
    expect(screen.queryByLabelText('Пароль Smart Life')).toBeNull();
    await user.click(connect);
    await user.click(await screen.findByRole('button', { name: 'Подтвердить в Android и подключиться' }));
    expect(backend.calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual([
      '/api/v1/cloud/login/redroid/qr', '/api/v1/cloud/login/redroid/android-session/confirm',
    ]);
    expect(window.location.pathname + window.location.search).toBe('/settings/connections?provider=android');
  } finally {
    vi.unstubAllEnvs();
  }
});

it('sends credentials once and waits for Smart Life approval before connecting the dashboard', async () => {
  vi.stubGlobal('isSecureContext', true);
  stored(window.location.origin);
  window.history.replaceState(null, '', '/settings/connections?provider=android');
  const backend = fakeApi({ redroid_available: true, connected: false });
  render(<App />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Страна или регион Smart Life'), 'Poland');
  await user.type(screen.getByLabelText('Электронная почта или телефон Smart Life'), 'demo@example.invalid');
  await user.type(screen.getByLabelText('Пароль Smart Life'), 'temporary-password');
  await user.click(screen.getByRole('button', { name: 'Подключиться через Android' }));
  await screen.findByText(/Smart Life готов подтвердить доступ/);
  const posts = () => backend.calls.filter(call => call.method === 'POST');
  expect(posts().map(call => call.path)).toEqual(['/api/v1/cloud/login/redroid/credentials', '/api/v1/cloud/login/redroid/qr']);
  expect(posts()[0].body).toEqual({ region: 'Poland', account: 'demo@example.invalid', password: 'temporary-password' });
  expect(localStorage.getItem(STORAGE_KEY)).not.toContain('temporary-password');
  await user.click(screen.getByRole('button', { name: 'Подтвердить в Android и подключиться' }));
  expect(posts().at(-1)?.path).toBe('/api/v1/cloud/login/redroid/android-session/confirm');
  expect(await screen.findByRole('heading', { name: 'Tuya подключена' })).toBeInTheDocument();
});

describe('cloud UI journeys', () => {
  it('opens the common device list after restoring access and uses Connections only for account settings', async () => {
    const backend = await restored(false); const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Лампа кухни' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Меню' }));
    expect(screen.getByRole('button', { name: 'Управление' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('Локальное управление')).toBeNull();
    expect(screen.queryByText(/Облачные устройства доступны на вкладке/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Получить QR-код' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Подключения' }));
    expect(screen.getByRole('heading', { name: 'Tuya подключена' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Лампа кухни' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Показать устройства' })).toBeNull();
    expect(backend.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('restores access, hides saved credentials, and allows an empty change followed by cancellation', async () => {
    const backend = await restored(); const user = userEvent.setup();
    expect(screen.getByRole('heading', { name: 'Tuya подключена' })).toBeInTheDocument();
    expect(screen.getByText(/Авторизация сохранена на сервере/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Устройства и группы/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Подключите Tuya-аккаунт')).not.toBeInTheDocument();
    expect(backend.calls.filter(call => call.path === '/api/v1/cloud/status')).toEqual([{ path: '/api/v1/cloud/status', method: 'GET', body: undefined, token: TOKEN }]);
    expect(backend.calls.every(call => call.method === 'GET')).toBe(true);
    expect(screen.queryByLabelText('User Code')).not.toBeInTheDocument();
    expect(document.querySelector('#access-token')).toBeNull();
    await user.click(within(screen.getByRole('region', { name: 'Подключение Tuya' })).getByRole('link', { name: 'Хочу изменить' }));
    expect(screen.getByLabelText('User Code')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Отменить изменение' }));
    expect(screen.queryByLabelText('User Code')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Access ID / Secret' }));
    expect(screen.queryByLabelText('Access Secret')).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('region', { name: 'Подключение Tuya' })).getByRole('link', { name: 'Хочу изменить' }));
    expect(screen.getByLabelText('Access ID')).toHaveValue('');
    expect(screen.getByLabelText('Access Secret')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Отменить изменение' }));
    expect(screen.queryByLabelText('Access Secret')).not.toBeInTheDocument();
  });

  it('verifies a new browser connection before saving it', async () => {
    fakeApi(); render(<App />); const user = userEvent.setup();
    const address = screen.getByLabelText('Адрес API');
    await user.clear(address); await user.type(address, BASE);
    await user.type(screen.getByLabelText('Ключ доступа к сервису'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Сохранить подключение' }));
    await screen.findByText('Подключение сохранено.');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ baseUrl: BASE, token: TOKEN });
    expect(screen.queryByLabelText('Ключ доступа к сервису')).not.toBeInTheDocument();
    expect(screen.getByText('Ключ доступа к сервису сохранён в этом браузере.')).toBeInTheDocument();
    expect(screen.queryByLabelText('User Code')).not.toBeInTheDocument();
  });

  it('does not overwrite a valid stored key after an invalid replacement', async () => {
    const backend = await restored(); const user = userEvent.setup();
    await user.click(screen.getByText('Настройки подключения'));
    const access = within(screen.getByRole('form', { name: 'Доступ к сервису' }));
    expect(access.queryByLabelText('Ключ доступа к сервису')).not.toBeInTheDocument();
    await user.click(access.getByRole('link', { name: 'Хочу изменить' }));
    expect(access.getByLabelText('Ключ доступа к сервису')).toHaveValue('');
    expect(access.getByLabelText('Ключ доступа к сервису')).toHaveFocus();
    await user.type(screen.getByLabelText('Ключ доступа к сервису'), 'wrong-key');
    await user.click(screen.getByRole('button', { name: 'Сохранить подключение' }));
    await screen.findByRole('alert');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).token).toBe(TOKEN);
    expect(screen.getByText('API подключён')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Получить QR-код' })).toBeEnabled();
    const requests = backend.calls.length;
    await user.click(access.getByRole('button', { name: 'Отменить изменение' }));
    expect(access.queryByLabelText('Ключ доступа к сервису')).not.toBeInTheDocument();
    expect(backend.calls).toHaveLength(requests);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).token).toBe(TOKEN);
    await user.click(access.getByRole('link', { name: 'Хочу изменить' }));
    expect(access.getByLabelText('Ключ доступа к сервису')).toHaveValue('');
  });

  it('requires a new key when changing servers and never sends the saved one to the new host', async () => {
    const backend = await restored(); const user = userEvent.setup();
    const requests = backend.calls.length;
    await user.click(screen.getByText('Настройки подключения'));
    await user.clear(screen.getByLabelText('Адрес API'));
    await user.type(screen.getByLabelText('Адрес API'), 'http://other-api.test:8000');
    expect(screen.getByLabelText('Ключ доступа к сервису')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Сохранить подключение' }));
    expect(screen.getByLabelText('Ключ доступа к сервису')).toBeInvalid();
    expect(backend.calls).toHaveLength(requests);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).baseUrl).toBe(BASE);
  });

  it('saves User Code separately without starting login or retaining the code in browser storage', async () => {
    stored(); const backend = fakeApi({ connected: false, has_saved_user_code: false });
    render(<App />); await screen.findByText('API подключён'); const user = userEvent.setup();
    await go(user, 'Подключения');
    expect(screen.getByRole('button', { name: 'Получить QR-код' })).toBeDisabled();
    await user.type(screen.getByLabelText('User Code'), 'private-code');
    await user.click(screen.getByRole('button', { name: 'Сохранить User Code' }));
    await screen.findByText('User Code сохранён. Подтвердите QR-вход.');
    expect(backend.calls.filter(call => call.method !== 'GET')).toEqual([{ path: '/api/v1/cloud/user-code', method: 'PUT', body: { user_code: 'private-code' }, token: TOKEN }]);
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('private-code');
    expect(screen.queryByLabelText('User Code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Получить QR-код' })).toBeEnabled();
  });

  it('creates a QR on the API host, confirms login, and releases the image URL', async () => {
    stored(); const backend = fakeApi({ connected: false }); render(<App />);
    await screen.findByText('API подключён'); const user = userEvent.setup();
    await go(user, 'Подключения');
    expect(screen.getByRole('heading', { name: 'Подключить Tuya' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Подробнее' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Получить QR-код' }));
    await screen.findByAltText('QR-код для входа в Tuya');
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]) === BASE + '/api/v1/cloud/login/qr-session/qr.svg')).toBe(true);
    expect(backend.calls.find(call => call.path.endsWith('/login/qr'))?.body).toEqual({});
    await user.click(screen.getByRole('button', { name: 'Я подтвердил вход в приложении' }));
    await screen.findByText('Аккаунт подключён. User Code и токены сохранены на сервере.');
    expect(screen.queryByAltText('QR-код для входа в Tuya')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:qr-test');
    expect(screen.getByRole('heading', { name: 'Tuya подключена' })).toBeInTheDocument();
    await go(user, 'Управление');
    expect(await screen.findByRole('heading', { name: 'Лампа кухни' })).toBeInTheDocument();
  });

  it('expires the QR, removes the confirmation action, and allows a new login', async () => {
    vi.useFakeTimers(); stored(); fakeApi({ connected: false });
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Меню' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Подключения' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Получить QR-код' })); });
    expect(screen.getByAltText('QR-код для входа в Tuya')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(screen.queryByRole('button', { name: 'Я подтвердил вход в приложении' })).not.toBeInTheDocument();
    expect(screen.getByText('Срок QR-кода истёк. Получите новый код.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Получить QR-код' })).toBeEnabled();
  });

  it('saves Developer credentials independently and connects only on the separate action', async () => {
    stored(); const backend = fakeApi({ developer: { configured: false, connected: false } });
    render(<App />); await screen.findByText('API подключён'); const user = userEvent.setup();
    await go(user, 'Подключения');
    await user.click(screen.getByRole('button', { name: 'Access ID / Secret' }));
    await user.type(screen.getByLabelText('Access ID'), 'project-id');
    await user.type(screen.getByLabelText('Access Secret'), 'private-secret');
    await user.selectOptions(screen.getByLabelText('Регион проекта'), 'us-e');
    await user.click(screen.getByRole('button', { name: 'Сохранить реквизиты' }));
    await screen.findByText('Реквизиты сохранены на сервере. Теперь проверьте подключение.');
    expect(screen.queryByLabelText('Access Secret')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('private-secret');
    expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
    expect(backend.calls.find(call => call.method === 'PUT')?.body).toEqual({ access_id: 'project-id', access_secret: 'private-secret', region: 'us-e', sample_device_id: null });
    await user.click(screen.getByRole('button', { name: 'Проверить и подключить' }));
    await screen.findByText('Tuya Developer подключён. Найдено устройств: 2.');
    await go(user, 'Управление');
    await screen.findByText('Лампа кухни');
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('provider=developer'))).toBe(true);
    await go(user, 'Подключения');
    await user.click(screen.getByRole('button', { name: 'Smart Life / QR' }));
    expect(screen.getByText('User Code сохранён на сервере.')).toBeInTheDocument();
    expect(screen.queryByText('Лампа кухни')).not.toBeInTheDocument();
  });

  it('searches names and IDs and renders device names as text', async () => {
    await restored(false); const user = userEvent.setup();
    await screen.findByText('Лампа кухни');
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Поиск' }));
    const search = screen.getByRole('searchbox');
    await user.type(search, 'КУХНИ');
    expect(screen.getByText('Лампа кухни')).toBeInTheDocument();
    expect(screen.queryByText('<script>alert(1)</script>')).not.toBeInTheDocument();
    await user.clear(search); await user.type(search, 'device-2');
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.queryByText('Лампа кухни')).not.toBeInTheDocument();
  });

  it('handles a disabled cloud adapter while keeping connection settings available', async () => {
    stored(); fakeApi({ enabled: false }); render(<App />);
    await screen.findByText('API подключён');
    await go(userEvent.setup(), 'Подключения');
    await screen.findByText('Облачный режим выключен на сервере.');
    expect(screen.getByRole('button', { name: 'Получить QR-код' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Показать устройства' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Адрес API')).toHaveValue(BASE);
  });

  it('clears invalid stored access after an authorization rejection', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: BASE, token: 'invalid' }));
    fakeApi(); render(<App />);
    await screen.findByRole('alert');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).token).toBe('');
    expect(screen.queryByRole('button', { name: 'Получить QR-код' })).toBeNull();
  });

  it('starts without credentials and never sends a request before access is entered', () => {
    fakeApi(); render(<App />);
    expect(screen.getByLabelText('Адрес API')).toHaveValue(DEFAULT_API_BASE);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Получить QR-код' })).toBeNull();
  });
});


it('opens LAN observations from the menu without a connected Tuya account', async () => {
  stored(); window.history.replaceState(null, '', '/#network');
  const backend = fakeApi({ enabled: false, connected: false, developer: { configured: false, connected: false, region: 'eu' } });
  render(<App />); await screen.findByText('API подключён');
  expect(screen.getByRole('heading', { name: 'Сеть и пакеты' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Начать наблюдение' })).toBeDisabled();
  expect(await screen.findByRole('option', { name: /192.168.40.0/ })).toBeInTheDocument();
  expect(backend.calls.map(call => call.path)).toEqual(['/api/v1/cloud/status', '/api/v1/network/interfaces']);
  const menu = screen.getByRole('button', { name: 'Меню' });
  fireEvent.click(menu); expect(screen.getByRole('navigation', { name: 'Раздел приложения' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Сеть и пакеты' })).toHaveAttribute('aria-current', 'page');
  fireEvent.keyDown(menu, { key: 'Escape' }); expect(screen.queryByRole('navigation')).toBeNull();
  expect(menu).toHaveFocus();
  fireEvent.click(menu); fireEvent.pointerDown(document.body); expect(screen.queryByRole('navigation')).toBeNull();
  await go(userEvent.setup(), 'Подключения');
  expect(screen.queryByRole('heading', { name: 'Сеть и пакеты' })).toBeNull();
  expect(window.location.pathname).toBe('/settings/connections');
});
