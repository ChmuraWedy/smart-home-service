import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { App } from './test/App';
import { STORAGE_KEY } from './connection';
import { setLocale } from './i18n';

const address = 'http://household.test';
const ownerKey = 'owner-test-key';
const memberKey = 'member-test-key';
const member = { id: 'member-id', name: 'Alex' };

function stored(token: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: address, token }));
}

function mockHousehold() {
  const requests: { path: string; token: string; method: string }[] = [];
  let exists = false;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const { pathname: path } = new URL(String(input));
    const token = (init?.headers as Record<string, string>)['X-API-Key'];
    const method = init?.method ?? 'GET';
    requests.push({ path, token, method });
    if (token !== ownerKey && token !== memberKey) return Response.json({}, { status: 401 });
    if (path === '/api/v1/cloud/status') {
      const account = token === ownerKey ? { id: 'owner', name: 'Owner', role: 'owner' } : { ...member, role: 'member' };
      return Response.json({ account, enabled: false, connected: false, developer: { configured: false, connected: false } });
    }
    if (path.startsWith('/api/v1/accounts') && token !== ownerKey) return Response.json({}, { status: 403 });
    if (path === '/api/v1/accounts' && method === 'GET') return Response.json(exists ? [member] : []);
    if (path === '/api/v1/accounts' && method === 'POST') {
      expect(JSON.parse(String(init?.body))).toEqual({ name: member.name });
      exists = true;
      return Response.json({ ...member, access_key: memberKey }, { status: 201 });
    }
    if (path === `/api/v1/accounts/${member.id}` && method === 'DELETE') {
      exists = false;
      return new Response(null, { status: 204 });
    }
    if (path === '/api/v1/dashboard-layouts/me') return Response.json({ slots: [] });
    if (path === '/api/v1/devices') {
      return Response.json([{
        id: 1,
        device_id: 'shared-device',
        name: token === ownerKey ? 'Owner inventory fixture' : 'Member inventory fixture',
        aliases: [],
        enabled: true,
        transport: 'wifi',
        capabilities: {},
      }]);
    }
    if (path.endsWith('/state')) return Response.json({ device_id: 1, name: 'Shared device', enabled: true, available: true, values: {} });
    if (['/api/v1/buildings', '/api/v1/rooms', '/api/v1/groups'].includes(path)) return Response.json([]);
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return requests;
}

it('creates a named member, shows their key once, and confirms revocation', async () => {
  setLocale('en', false);
  stored(ownerKey);
  window.history.replaceState(null, '', '/settings');
  mockHousehold();
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: 'Household access' });
  await user.type(await screen.findByLabelText('Member name'), ' Alex ');
  await user.click(screen.getByRole('button', { name: 'Create access key' }));
  expect(await screen.findByLabelText('Access key for Alex')).toHaveValue(memberKey);
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByLabelText('Access key for Alex')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Revoke access for Alex' }));
  expect(screen.getByText('Revoke access for Alex and delete their saved dashboard layouts?')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Yes' }));
  expect(await screen.findByRole('button', { name: 'Create access key' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Revoke access for Alex' })).toBeNull();
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
  expect(screen.queryByRole('heading', { name: 'Household access' })).toBeNull();
  expect(requests.filter(({ token }) => token === memberKey).every(({ path }) => !path.startsWith('/api/v1/accounts'))).toBe(true);
});

it('returns members who open an owner-only link to their dashboard', async () => {
  setLocale('en', false);
  stored(memberKey);
  window.history.replaceState(null, '', '/network');
  const requests = mockHousehold();
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Member inventory fixture' })).toBeVisible();
  expect(window.location.pathname).toBe('/');
  expect(requests.some(({ path }) => path.startsWith('/api/v1/network/'))).toBe(false);
});
