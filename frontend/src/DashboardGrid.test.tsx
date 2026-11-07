import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardGrid from './components/DashboardGrid';
import { MAX_LAYOUT_SLOTS, moveCard, placeCards } from './dashboard-layout';
import type { LayoutSlots } from './dashboard-layout';
import { HomeApi } from './home-api';
import { setLocale } from './i18n';

const items = ['device-a', 'group-1', 'device-b'].map((id, index) => ({
  id, cardName: `Card ${index + 1}`, entry: { id, title: `Card ${index + 1}` },
}));
const api = new HomeApi({ baseUrl: 'http://dashboard.test', token: 'fixture-key' });
const view = { building: '', room: '3', page: 1 };

function mount(room = '3') {
  return render(
    <DashboardGrid
      api={api}
      density="large"
      items={items}
      view={{ ...view, room }}
      editable
      renderCard={({ id, title }, placement) => <li key={id} data-testid={id} {...placement}>{title}</li>}
    />,
  );
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

function cardAt(id: string, row: number, column: number) {
  const card = screen.getByTestId(id);
  expect(card.style.gridRowStart).toBe(String(row));
  expect(card.style.gridColumnStart).toBe(String(column));
}

beforeEach(() => {
  setLocale('en', false);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: 900 } as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

describe('dashboard layout', () => {
  it('preserves explicit holes and appends new cards, including after inventory changes', () => {
    expect(moveCard(['device-a', 'group-1'], 0, 2)).toEqual([null, 'group-1', 'device-a']);
    expect(moveCard([null, 'group-1', 'device-a'], 2, 1)).toEqual([null, 'device-a', 'group-1']);
    expect(placeCards(['device-a', 'device-b'], [null, 'group-1', 'device-a'])).toEqual([null, null, 'device-a', 'device-b']);
    const lastSlot = moveCard(['device-a'], 0, MAX_LAYOUT_SLOTS - 1);
    const filled = placeCards(['device-a', 'group-1'], lastSlot);
    expect(filled[0]).toBe('group-1');
    expect(filled.at(-1)).toBe('device-a');
  });

  it('saves sparse positions to the server and restores them after a reload in the same room', async () => {
    const stored = new Map<string, { slots: LayoutSlots }>();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const key = String(input);
      if (init?.method === 'PUT') stored.set(key, JSON.parse(String(init.body)));
      return Response.json(stored.get(key) ?? { slots: [] });
    });
    const first = mount();
    click('Edit layout');
    expect(screen.getByTestId('device-a')).toHaveAttribute('inert');
    click('Move Card 1 (Row 1, column 1)');
    click('Move here (Row 2, column 3)');
    cardAt('device-a', 2, 3);
    click('Move Card 2 (Row 1, column 2)');
    click('Swap with Card 3 (Row 1, column 3)');
    cardAt('group-1', 1, 3);
    click('Save');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit layout' })).toBeEnabled());
    expect(screen.getByTestId('device-a')).not.toHaveAttribute('inert');
    expect([...stored.values()]).toEqual([{ slots: [null, 'device-b', 'group-1', null, null, 'device-a'] }]);
    expect([...stored.keys()][0]).toMatch(/\/dashboard-layouts\/[0-9a-f]{32}\?building=all&room=3&page=1&columns=3$/);

    first.unmount();
    const reloaded = mount();
    await waitFor(() => cardAt('device-a', 2, 3));
    cardAt('group-1', 1, 3);
    reloaded.unmount();
    mount('4');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit layout' })).toBeEnabled());
    expect(screen.getByTestId('device-a').style.gridColumnStart).toBe('');
  });

  it('keeps the draft on save failure and discards it on cancel', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 500 }));
    mount();
    click('Edit layout');
    click('Move Card 1 (Row 1, column 1)');
    click('Move here (Row 2, column 1)');
    click('Save');
    expect(await screen.findByRole('alert')).toHaveTextContent('Your edits are still here.');
    cardAt('device-a', 2, 1);
    click('Cancel');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('device-a').style.gridRowStart).toBe('');
    expect(screen.getByTestId('device-a')).not.toHaveAttribute('inert');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
