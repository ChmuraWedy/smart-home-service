import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { STORAGE_KEY } from './connection';
import { setLocale } from './i18n';
import { App } from './test/App';

const EMBED_PATH = '/api/v1/assistant/embed';
const BASE = 'http://api.test:8765';
const FRAME = 'https://voice.test:8012/embed';
const TICKET = 't'.repeat(43);
const TOKEN = 'test-service-key';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function openChat(respond: () => Response | Promise<Response>) {
  setLocale('en', false);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: BASE, token: TOKEN }));
  vi.mocked(fetch).mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === EMBED_PATH) return respond();
    if (path === '/api/v1/cloud/status') return json({
      enabled: false, connected: false, has_saved_user_code: false,
      saved_user_code_requires_login: false, developer: { configured: false, connected: false },
    });
    return json([]);
  });
  const user = userEvent.setup();
  render(<App />);
  const button = await screen.findByRole('button', { name: 'AI chat' });
  expect(embedRequests()).toHaveLength(0);
  await user.click(button);
  const dialog = screen.getByRole('dialog', { name: 'AI chat' });
  return { button, dialog };
}

function embedRequests() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === BASE + EMBED_PATH).map(([, options]) => options!);
}

it('opens Classic Chat in a titled iframe and restores focus when dismissed', async () => {
  const { button, dialog } = await openChat(() => json({ url: FRAME, ticket: TICKET }));
  const chat = within(dialog);
  const iframe = await chat.findByTitle('AI chat');
  expect(iframe).toHaveAttribute('src', `${FRAME}#ticket=${TICKET}`);
  expect(iframe).toHaveAttribute('allow', 'microphone');
  expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(embedRequests()[0].headers).toEqual({ 'X-API-Key': TOKEN });
  expect(embedRequests()[0].method).toBe('POST');

  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

it.each([null, 'http://voice.test/', 'javascript:alert(1)', 'https://user:password@voice.test/'])(
  'shows the unavailable message for an unset or unsafe frame URL (%s)',
  async (url) => {
    const { dialog } = await openChat(() => json({ url, ticket: TICKET }));
    await within(dialog).findByText('AI chat is unavailable on this server.');
    expect(dialog.querySelector('iframe')).toBeNull();
  },
);

it('cancels configuration loading if the panel is closed', async () => {
  const { dialog } = await openChat(() => new Promise(() => {}));
  expect(within(dialog).getByRole('status')).toHaveTextContent('Loading chat');
  await waitFor(() => expect(embedRequests()).toHaveLength(1));
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(embedRequests()[0].signal?.aborted).toBe(true);
});

it('shows the chat only after connecting to the service', () => {
  setLocale('en', false);
  render(<App />);
  expect(screen.queryByRole('button', { name: 'AI chat' })).toBeNull();
});
