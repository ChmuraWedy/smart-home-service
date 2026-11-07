export type LayoutSlots = (string | null)[];

export const MAX_LAYOUT_SLOTS = 96;
const BROWSER_STORAGE_KEY = 'smart-home.ui.dashboard-browser.v1';

export function dashboardBrowserId() {
  try {
    const id = localStorage.getItem(BROWSER_STORAGE_KEY);
    return id && /^[0-9a-f]{32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function ensureDashboardBrowserId() {
  const existing = dashboardBrowserId();
  if (existing) return existing;

  // getRandomValues is available on the dashboard's HTTP LAN address.
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(BROWSER_STORAGE_KEY, id);
  return id;
}

export function trimSlots(slots: LayoutSlots): LayoutSlots {
  let end = slots.length;
  while (end > 0 && slots[end - 1] === null) end -= 1;
  return slots.slice(0, end);
}

export function placeCards(cards: string[], saved: LayoutSlots): LayoutSlots {
  const remaining = new Set(cards);
  const slots = trimSlots(saved.map((id) => (id && remaining.delete(id) ? id : null)));
  remaining.forEach((id) => {
    if (slots.length < MAX_LAYOUT_SLOTS) slots.push(id);
    else slots[slots.indexOf(null)] = id;
  });
  return slots;
}

export function moveCard(slots: LayoutSlots, from: number, to: number): LayoutSlots {
  const card = slots[from];
  if (!card || from === to || to < 0 || to >= MAX_LAYOUT_SLOTS) return slots;
  const next = Array.from({ length: Math.max(slots.length, to + 1) }, (_, index) => slots[index] ?? null);
  next[from] = next[to];
  next[to] = card;
  return trimSlots(next);
}
