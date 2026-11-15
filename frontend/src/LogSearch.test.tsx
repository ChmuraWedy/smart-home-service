import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import LogSearchButton from './components/LogSearchButton';
import { setLocale } from './i18n';

it('posts a short-lived ticket to the secure log console without putting credentials in its URL', async () => {
  setLocale('en', false);
  const api = new CloudApi({baseUrl:'http://api.test/api/v1',token:'existing-key'});
  vi.spyOn(api, 'logSearchTicket').mockResolvedValue({url:'https://logs.test:8096/session',ticket:'short-lived-ticket'});
  const doc = document.implementation.createHTMLDocument();
  const close = vi.fn();
  const tab = {document:doc,close,opener:window};
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this:HTMLFormElement) {
    expect(this.action).toBe('https://logs.test:8096/session');
    expect(this.method).toBe('post');
    expect(this.querySelector('input')?.value).toBe('short-lived-ticket');
    expect(this.outerHTML).not.toContain('existing-key');
  });
  render(<LogSearchButton api={api} disabled={false} />);
  await userEvent.setup().click(screen.getByRole('button', {name:'Log search'}));
  expect(submit).toHaveBeenCalledOnce();
  expect(tab.opener).toBeNull();
  expect(close).not.toHaveBeenCalled();
});

it('does not request credentials when a new tab is blocked', async () => {
  setLocale('en', false);
  const api = new CloudApi({baseUrl:'http://api.test/api/v1',token:'existing-key'});
  const ticket = vi.spyOn(api, 'logSearchTicket');
  vi.spyOn(window, 'open').mockReturnValue(null);
  render(<LogSearchButton api={api} disabled={false} />);
  await userEvent.setup().click(screen.getByRole('button', {name:'Log search'}));
  expect(ticket).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toBeInTheDocument();
});

it('closes a blank tab when sign-in fails or the destination is unsafe', async () => {
  setLocale('en', false);
  const api = new CloudApi({baseUrl:'http://api.test/api/v1',token:'existing-key'});
  vi.spyOn(api, 'logSearchTicket').mockResolvedValue({url:'http://logs.test/session',ticket:'ticket'});
  const close = vi.fn();
  vi.spyOn(window, 'open').mockReturnValue({opener:window,close} as unknown as Window);
  render(<LogSearchButton api={api} disabled={false} />);
  await userEvent.setup().click(screen.getByRole('button', {name:'Log search'}));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert')).toBeInTheDocument();
});

it.each(['owner', 'member'] as const)('shows the menu entry only to an owner (%s)', async (role) => {
  const { App } = await import('./test/App');
  const { STORAGE_KEY } = await import('./connection');
  setLocale('en', false);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({baseUrl:'http://api.test:8765',token:'test-key'}));
  vi.mocked(fetch).mockImplementation(async input => {
    if (new URL(String(input)).pathname.endsWith('/status')) return Response.json({
      enabled:true,connected:false,developer:{configured:false,connected:false},
      log_search_supported:true,account:{id:'account',name:'Owner',login:'owner',role},
    });
    return Response.json([]);
  });
  const user = userEvent.setup();
  render(<App />);
  const menu = await screen.findByRole('button', {name:'Menu'});
  const { waitFor } = await import('@testing-library/react');
  await waitFor(() => expect(menu).toBeEnabled());
  await user.click(menu);
  if (role === 'owner') expect(screen.getByRole('button', {name:'Log search'})).toBeInTheDocument();
  else expect(screen.queryByRole('button', {name:'Log search'})).toBeNull();
});
