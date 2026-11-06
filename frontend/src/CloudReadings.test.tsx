import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CloudDevice, CloudFunctions, CloudSnapshot, Provider } from './api';
import { CardControls } from './components/CardControls';
import { CloudControl } from './components/CloudControl';
import { HomeApi } from './home-api';
import { renderWithStore } from './test/render-with-store';

const definitions: CloudFunctions = {
  device_id: 'lamp',
  functions: [{ code: 'switch_led', type: 'Boolean', values: {} }],
};
const snapshot = (power: boolean): CloudSnapshot => ({
  device_id: 'lamp', online: true, source: 'cloud', status: { switch_led: power },
});
const device: CloudDevice = {
  id: 'lamp', name: 'Lamp', online: true, has_local_key: false,
  controls: { ready: true, definitions, snapshot: snapshot(false) },
};
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe('cloud readings in the dashboard and details', () => {
  it.each(['sharing', 'developer'] as const)('shares a fresh %s reading with a paused and remounted card', async (provider: Provider) => {
    const api = new HomeApi({ baseUrl: 'http://cloud.test', token: 'fixture-key' });
    const statusReads: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      expect(options?.method).toBe('GET');
      const url = new URL(String(input));
      if (url.pathname.endsWith('/functions')) return json(definitions);
      if (url.pathname.endsWith('/status')) {
        statusReads.push(url.search);
        return json(snapshot(true));
      }
      return json({});
    });
    function Dashboard({ card, details }: { card: boolean; details: boolean }) {
      return <>
        {card && <CardControls api={api} device={{ id: device.id, name: device.name, cloud: { [provider]: device } }}
          route={provider} now={Date.now()} paused={details} onAuthError={vi.fn()} onBusy={vi.fn()} />}
        {details && <CloudControl api={api} device={device} provider={provider} onClose={vi.fn()} onAuthError={vi.fn()} />}
      </>;
    }
    const power = () => within(screen.getByRole('group', { name: 'Основные параметры: Lamp' }))
      .getByRole('switch', { name: 'Питание' });
    const view = renderWithStore(<Dashboard card details={false} />);
    await screen.findByRole('switch', { name: 'Питание' });
    expect(power()).toHaveAttribute('aria-checked', 'false');
    expect(statusReads).toEqual([]);
    view.rerender(<Dashboard card details />);
    await waitFor(() => expect(power()).toHaveAttribute('aria-checked', 'true'));
    expect(statusReads).toEqual(['?refresh=true&provider=' + provider]);
    view.rerender(<Dashboard card={false} details={false} />);
    view.rerender(<Dashboard card details={false} />);
    await screen.findByRole('switch', { name: 'Питание' });
    expect(power()).toHaveAttribute('aria-checked', 'true');
    expect(statusReads).toHaveLength(1);
  });

  it('does not poll Developer or a hidden document', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let notifyVisible!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notifyVisible = callback; }
      observe() {}
      disconnect() {}
    });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const api = new HomeApi({ baseUrl: 'http://cloud.test', token: 'fixture-key' });
    vi.mocked(fetch).mockImplementation(async () => json(snapshot(true)));
    function Card({ route }: { route: Provider }) {
      return <CardControls key={route} api={api} device={{ id: device.id, name: device.name, cloud: { [route]: device } }}
        route={route} now={Date.now()} paused={false} onAuthError={vi.fn()} onBusy={vi.fn()} />;
    }
    const view = renderWithStore(<Card route="sharing" />);
    const show = () => act(async () => notifyVisible([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    try {
      await screen.findByRole('switch', { name: 'Питание' });
      await show();
      await act(async () => vi.advanceTimersByTime(3000));
      expect(fetch).not.toHaveBeenCalled();
      visibility.mockReturnValue('visible');
      await act(async () => vi.advanceTimersByTime(1000));
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Питание' })).toHaveAttribute('aria-checked', 'true'));
      expect(fetch).toHaveBeenCalledOnce();
      view.rerender(<Card route="developer" />);
      await screen.findByRole('switch', { name: 'Питание' });
      await show();
      await act(async () => vi.advanceTimersByTime(3000));
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      visibility.mockRestore();
    }
  });
});
