import { MSG, t } from "./i18n";
import { normalizeApiBase } from './api';
import type { Connection } from './api';

export const STORAGE_KEY = 'smart-home.ui.connection.v1';
const configuredBase = import.meta.env.VITE_API_BASE_URL;
export const DEFAULT_API_BASE = configuredBase === 'same-origin' ? window.location.origin : configuredBase || 'http://127.0.0.1:8000';

export function loadConnection(defaultBase = DEFAULT_API_BASE): Connection {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (stored && typeof stored.baseUrl === 'string' && typeof stored.token === 'string') {
      return { baseUrl: normalizeApiBase(stored.baseUrl), token: stored.token };
    }
    // Same-origin installations may reuse the previous plain-HTML UI's key.
    // A key from that origin must never be reused for a different API server.
    const baseUrl = normalizeApiBase(defaultBase);
    const token = baseUrl === window.location.origin ? localStorage.getItem('smart-home.cloud.api-key') || '' : '';
    return { baseUrl, token };
  } catch { return { baseUrl: normalizeApiBase(defaultBase), token: '' }; }
}

export function saveConnection(connection: Connection): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(connection)); }
  catch { throw new Error(t(MSG.THE_BROWSER_COULD_NOT_SAVE_THIS_CONNECTION)); }
}
