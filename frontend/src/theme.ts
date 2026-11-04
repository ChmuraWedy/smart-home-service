import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'dark' | 'day';
export const THEME_STORAGE_KEY = 'smart-home.ui.theme.v1';
const validTheme = (value: unknown): value is Theme => value === 'system' || value === 'dark' || value === 'day';
export function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (validTheme(saved)) return saved;
  } catch { /* Appearance remains usable without browser storage. */ }
  return 'system';
}

let theme = savedTheme();
const system = window.matchMedia?.('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
export const getTheme = () => theme;
export const resolvedTheme = () => theme === 'system' ? system?.matches ? 'dark' : 'day' : theme;
function applyTheme() {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#101720' : '#f3f6fa');
}
export function setTheme(next: Theme, persist = true) {
  if (!validTheme(next)) return;
  if (persist) { try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Keep the in-memory choice. */ } }
  const changed = next !== theme;
  theme = next;
  applyTheme();
  if (changed) for (const listener of listeners) listener();
}
system?.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
window.addEventListener('storage', event => {
  if (event.key === THEME_STORAGE_KEY && (event.newValue === null || validTheme(event.newValue))) setTheme(event.newValue || 'system', false);
});
applyTheme();

export function useTheme() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, getTheme);
}
