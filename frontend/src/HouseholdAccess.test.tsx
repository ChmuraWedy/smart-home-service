import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { App } from './test/App';
import { DEFAULT_API_BASE, STORAGE_KEY } from './connection';
import { householdSignInLink } from './household-login';
import { setLocale } from './i18n';

const address = DEFAULT_API_BASE;
const ownerKey = 'owner-test-key';
const memberKey = `shm_${'m'.repeat(43)}`;
const member = { id: 'member-id', name: 'Alex', login: 'alex' };
const laptop = { id: 'laptop-key', name: 'Laptop', key_available: true };
const phone = { id: 'phone-key', name: 'Phone', key_available: true };

function stored(token: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: address, token }));
}

function mockHousehold(options: { exists?: boolean; needsName?: boolean } = {}) {
  const requests: { path: string; token: string; method: string }[] = [];
  let exists = Boolean(options.exists);
  let ownerName = options.needsName ? '' : 'Dmitry';
  let keys = exists ? [laptop] : [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const { pathname: path } = new URL(String(input));
    const token = (init?.headers as Record<string, string>)['X-API-Key'];
    const method = init?.method ?? 'GET';
    requests.push({ path, token, method });
    if (token !== ownerKey && token !== memberKey) return Response.json({}, { status: 401 });
    const owner = token === ownerKey;
    const account = owner
      ? { id: 'owner', name: ownerName || 'Owner', login: 'root', role: 'owner', needs_name: !ownerName }
      : { ...member, role: 'member', key_id: laptop.id };
    if (path === '/api/v1/cloud/status') {
      return Response.json({ account, enabled: false, connected: false, developer: { configured: false, connected: false } });
    }
    if (path === '/api/v1/accounts/login' && method === 'POST') {
      return JSON.parse(String(init?.body)).login === account.login ? Response.json(account) : Response.json({}, { status: 401 });
    }
    if (path === '/api/v1/accounts/owner' && method === 'PUT' && owner) {
      ownerName = JSON.parse(String(init?.body)).name;
      return Response.json({ ...account, name: ownerName, needs_name: false });
    }
    if (path === '/api/v1/accounts' && !owner) return Response.json({}, { status: 403 });
    if (path === '/api/v1/accounts' && method === 'GET') return Response.json(exists ? [member] : []);
    if (path === '/api/v1/accounts' && method === 'POST') {
      expect(JSON.parse(String(init?.body))).toEqual({ name: member.name, login: member.login, device_name: 'Laptop' });
      exists = true;
      keys = [laptop];
      return Response.json({ ...member, key_id: laptop.id, access_key: memberKey }, { status: 201 });
    }
    if (path === '/api/v1/accounts/owner/keys') return Response.json([]);
    const memberPath = `/api/v1/accounts/${member.id}`;
    const keyPath = `${memberPath}/keys`;
    if (path === keyPath && method === 'GET') return Response.json(keys);
    if (path === keyPath && method === 'POST') {
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'Phone' });
      keys.push(phone);
      return Response.json(phone, { status: 201 });
    }
    if (path.startsWith(`${keyPath}/`) && method === 'GET') return Response.json({ access_key: memberKey });
    if (path === `${keyPath}/${phone.id}` && method === 'DELETE') {
      keys = keys.filter((key) => key.id !== phone.id);
      return new Response(null, { status: 204 });
    }
    if (path === memberPath && method === 'DELETE') {
      exists = false;
      keys = [];
      return new Response(null, { status: 204 });
    }
    if (path === '/api/v1/dashboard-layouts/me') return Response.json({ slots: [] });
    if (path === '/api/v1/devices') {
      return Response.json([{
        id: 1,
        device_id: 'shared-device',
        name: owner ? 'Owner inventory fixture' : 'Member inventory fixture',
        aliases: [],
        enabled: true,
        transport: 'wifi',
        capabilities: {},
      }]);
    }
    if (path.endsWith('/state')) return Response.json({ device_id: 1, name: 'Shared device', enabled: true, available: true, values: {} });
    if (['/api/v1/buildings', '/api/v1/rooms', '/api/v1/groups', '/api/v1/combined-devices'].includes(path)) return Response.json([]);
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return requests;
}

it('asks root for the owner name on first sign-in and shows it in Users', async () => {
  setLocale('en', false);
  stored(ownerKey);
  mockHousehold({ needsName: true });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Set up the owner' })).toBeVisible();
  await user.type(screen.getByLabelText('Owner name'), 'Dmitry');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('heading', { name: 'Device keys for Dmitry' })).toBeVisible();
  expect(window.location.pathname).toBe('/settings/users');
});

it('creates a user with a masked device key and reveals a fragment-only sign-in link on demand', async () => {
  setLocale('en', false);
  stored(ownerKey);
  window.history.replaceState(null, '', '/settings');
  mockHousehold();
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Users' }));
  expect(await screen.findByRole('heading', { name: 'Users' })).toBeVisible();
  await user.type(screen.getByLabelText('Member name'), ' Alex ');
  await user.type(screen.getByLabelText('Login'), 'alex');
  const create = screen.getByRole('button', { name: 'Add user' });
  const addUser = within(create.closest('form') as HTMLFormElement);
  await user.type(addUser.getByLabelText('Device name'), 'Laptop');
  await user.click(create);
  const show = await screen.findByRole('button', { name: 'Show key for Laptop' });
  expect(screen.queryByLabelText('Sign-in link')).toBeNull();
  await user.click(show);
  const link = await screen.findByLabelText<HTMLInputElement>('Sign-in link');
  expect(new URL(link.value).search).toBe('');
  expect(new URL(link.value).hash).toBe(`#login=alex&key=${memberKey}`);
  expect(screen.getByLabelText('Access key for Laptop')).toHaveValue(memberKey);
  await user.click(screen.getByRole('button', { name: 'Hide access key' }));
  expect(screen.queryByLabelText('Access key for Laptop')).toBeNull();
});

it('opens a shared link without signing in until confirmed and strips the key from the URL', async () => {
  setLocale('en', false);
  window.history.replaceState(null, '', householdSignInLink(member.login, memberKey));
  const requests = mockHousehold({ exists: true });
  const user = userEvent.setup();
  render(<App />);
  const field = await screen.findByLabelText('Login');
  expect(field).toHaveValue('alex');
  expect(screen.getByLabelText('Service access key')).toHaveAttribute('type', 'password');
  await waitFor(() => expect(window.location.hash).toBe(''));
  expect(requests).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Save connection' }));
  expect(await screen.findByRole('heading', { name: 'Member inventory fixture' })).toBeVisible();
  expect(requests).toContainEqual({ path: '/api/v1/accounts/login', token: memberKey, method: 'POST' });
  expect(window.location.pathname).toBe('/');
});

it('lets a member manage only their own keys and revoke one device independently', async () => {
  setLocale('en', false);
  stored(memberKey);
  window.history.replaceState(null, '', '/settings/users');
  const requests = mockHousehold({ exists: true });
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'My device keys' })).toBeVisible();
  await screen.findByRole('button', { name: 'Show key for Laptop' });
  expect(screen.queryByRole('button', { name: 'Add user' })).toBeNull();
  await user.type(screen.getByLabelText('Device name'), 'Phone');
  await user.click(screen.getByRole('button', { name: 'Create access key' }));
  await user.click(await screen.findByRole('button', { name: 'Revoke key for Phone' }));
  await user.click(screen.getByRole('button', { name: 'Yes' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke key for Phone' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Show key for Laptop' })).toBeVisible();
  expect(requests.some(({ path }) => path === '/api/v1/accounts')).toBe(false);
});

it('signs out the owner and opens a fresh dashboard for a member without admin links', async () => {
  setLocale('en', false);
  stored(ownerKey);
  localStorage.setItem('smart-home.cloud.api-key', ownerKey);
  const requests = mockHousehold();
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: 'Owner inventory fixture' });
  await user.click(screen.getByRole('button', { name: 'Menu' }));
  await user.click(screen.getByRole('button', { name: 'Settings' }));
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Sign in to Smart Home' })).toBeVisible();
  expect(localStorage.getItem('smart-home.cloud.api-key')).toBeNull();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').token).toBe('');

  await user.type(screen.getByLabelText('Service access key'), memberKey);
  await user.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByRole('heading', { name: 'Member inventory fixture' });
  expect(screen.queryByRole('heading', { name: 'Owner inventory fixture' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Menu' }));
  const nav = within(screen.getByRole('navigation', { name: 'App navigation' }));
  expect(nav.queryByRole('button', { name: 'Network and packets' })).toBeNull();
  expect(nav.queryByRole('button', { name: 'Local connections' })).toBeNull();
  await user.click(nav.getByRole('button', { name: 'Settings' }));
  expect(screen.getByText('Signed in as Alex')).toBeVisible();
  expect(screen.getByRole('button', { name: 'My device keys' })).toBeVisible();
  expect(requests.filter(({ token }) => token === memberKey).every(({ path }) => path !== '/api/v1/accounts')).toBe(true);
});
