import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardGrid from './components/DashboardGrid';
import { ensureDashboardBrowserId, MAX_LAYOUT_SLOTS, moveCard, placeCards } from './dashboard-layout';
import type { DashboardLayout, LayoutSlots } from './dashboard-layout';
import { HomeApi } from './home-api';
import { setLocale } from './i18n';

const items = ['device-a', 'group-1', 'device-b'].map((id, index) => ({
  id, cardName: `Card ${index + 1}`, entry: { id, title: `Card ${index + 1}` }, hideable: id.startsWith('device-'),
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
      renderCard={({ id, title }, { style, inert, slot, nudge }) => (
        <li key={id} data-testid={id} data-layout-slot={slot} data-layout-nudge={nudge} style={style} inert={inert}>{title}</li>
      )}
    />,
  );
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

function cardAt(id: string, row: number, column: number) {
  const card = screen.getByTestId(id);
  expect(card.style.gridRowStart).toBe(String(row));
  expect(card.closest('[data-dashboard-column]')).toHaveAttribute('data-dashboard-column', String(column));
}

beforeEach(() => {
  setLocale('en', false);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: 900, height: 64, top: 0, left: 0 } as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

describe('dashboard layout', () => {
  it('preserves explicit holes and appends new cards, including after inventory changes', () => {
    expect(moveCard(['device-a', 'group-1'], 0, 2, 3)).toEqual([null, 'group-1', 'device-a']);
    expect(moveCard([null, 'group-1', 'device-a'], 2, 1, 3)).toEqual([null, 'device-a', null, null, 'group-1']);
    expect(moveCard(['device-a', 'group-1', null, null, 'device-b'], 0, 1, 3))
      .toEqual([null, 'device-a', null, null, 'group-1', null, null, 'device-b']);
    expect(moveCard(['device-a', 'group-1', null, null, 'device-b'], 0, 1, 3, true))
      .toEqual([null, 'group-1', null, null, 'device-a', null, null, 'device-b']);
    expect(placeCards(['device-a', 'device-b'], [null, 'group-1', 'device-a'])).toEqual([null, null, 'device-a', 'device-b']);
    const lastSlot = moveCard(['device-a'], 0, MAX_LAYOUT_SLOTS - 1, 3);
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
    click('Move here (Row 7, column 2)');
    cardAt('device-a', 7, 2);
    expect(screen.queryByRole('button', { name: 'Move here (Row 7, column 3)' })).toBeNull();
    click('Move Card 2 (Row 1, column 2)');
    click('Insert before Card 3 (Row 1, column 3)');
    cardAt('group-1', 1, 3);
    click('Save');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit layout' })).toBeEnabled());
    expect(screen.getByTestId('device-a')).not.toHaveAttribute('inert');
    const expected: LayoutSlots = Array(20).fill(null);
    expected[2] = 'group-1';
    expected[5] = 'device-b';
    expected[19] = 'device-a';
    expect([...stored.values()]).toEqual([{ slots: expected }]);
    expect([...stored.keys()][0]).toMatch(/\/dashboard-layouts\/[0-9a-f]{32}\?building=all&room=3&page=1&columns=3$/);

    first.unmount();
    const reloaded = mount();
    await waitFor(() => cardAt('device-a', 7, 2));
    cardAt('group-1', 1, 3);
    reloaded.unmount();
    mount('4');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit layout' })).toBeEnabled());
    cardAt('device-a', 1, 1);
  });

  it('hides individual cards persistently and reveals them temporarily with Show all', async () => {
    let stored: DashboardLayout = { slots: [] };
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') stored = JSON.parse(String(init.body));
      return Response.json(stored);
    });
    const first = mount();
    click('Edit layout');
    fireEvent.click(screen.getByText('Visible individual devices'));
    expect(screen.getByRole('checkbox', { name: 'Card 1' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Card 2' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Card 1' }));
    click('Save');
    expect(await screen.findByRole('button', { name: 'Show all' })).toHaveAttribute('aria-pressed', 'false');
    expect(stored.hidden_devices).toEqual(['device-a']);
    expect(screen.queryByTestId('device-a')).toBeNull();
    expect(screen.getByTestId('group-1')).toBeInTheDocument();

    click('Show all');
    cardAt('device-a', 1, 1);
    expect(screen.getByRole('button', { name: 'Show all' })).toHaveAttribute('aria-pressed', 'true');

    first.unmount();
    mount();
    await screen.findByRole('button', { name: 'Show all' });
    expect(screen.queryByTestId('device-a')).toBeNull();
    click('Edit layout');
    fireEvent.click(screen.getByText('Visible individual devices'));
    const checkbox = screen.getByRole('checkbox', { name: 'Card 1' });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    click('Save');
    await waitFor(() => expect(stored.hidden_devices).toEqual([]));
    expect(screen.getByTestId('device-a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('keeps a previously saved card beyond the editor slots accessible', async () => {
    ensureDashboardBrowserId();
    const slots: LayoutSlots = Array(MAX_LAYOUT_SLOTS).fill(null);
    slots[0] = 'group-1';
    slots[1] = 'device-b';
    slots[MAX_LAYOUT_SLOTS - 1] = 'device-a';
    vi.mocked(fetch).mockImplementation(async () => Response.json({ slots }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit layout' })).toBeEnabled());
    click('Edit layout');
    cardAt('device-a', 32, 3);
    expect(screen.queryByRole('button', { name: 'Move here (Row 8, column 1)' })).toBeNull();
    click('Move Card 1 (Row 32, column 3)');
    click('Move here (Row 7, column 2)');
    cardAt('device-a', 7, 2);
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
    cardAt('device-a', 1, 1);
    expect(screen.getByTestId('device-a')).not.toHaveAttribute('inert');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows a floating copy and inserts ahead of the target without swapping', () => {
    mount();
    click('Edit layout');
    const source = screen.getByRole('button', { name: 'Move Card 1 (Row 1, column 1)' });
    const target = screen.getByRole('button', { name: 'Move Card 2 (Row 1, column 2)' });
    Object.defineProperty(source, 'setPointerCapture', { value: vi.fn() });
    const hit = vi.fn<() => HTMLElement | null>().mockReturnValue(target);
    const original = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { value: hit, configurable: true });
    const drag = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperties(event, { pointerType: { value: 'mouse' }, pointerId: { value: 1 } });
      fireEvent(source, event);
    };

    try {
      drag('pointerdown', 12, 15);
      drag('pointermove', 60, 8);
      const preview = document.querySelector('.dashboard-layout-drag-layer');
      expect(preview).toHaveTextContent('Card 1');
      expect(target).toHaveAttribute('data-drop-over', 'down');
      cardAt('group-1', 1, 2);
      drag('pointermove', 60, 56);
      expect(target).toHaveAttribute('data-drop-over', 'up');
      hit.mockReturnValue(null);
      drag('pointermove', 60, 65);
      expect(target).not.toHaveAttribute('data-drop-over');
      hit.mockReturnValue(target);
      drag('pointerup', 60, 8);
      expect(preview).toBeEmptyDOMElement();
      cardAt('group-1', 2, 2);
      cardAt('device-a', 1, 2);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(document, 'elementFromPoint', original);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });
});
