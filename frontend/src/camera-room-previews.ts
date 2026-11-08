import { useMemo, useSyncExternalStore } from 'react';
import type { Provider } from './api';

const storageKey = 'smart-home.ui.camera-room-previews.v1';
const listeners = new Set<() => void>();
let fallback = '{}';

const read = () => {
  try { return localStorage.getItem(storageKey) ?? '{}'; } catch { return fallback; }
};

function parse(value: string): Partial<Record<string, Provider>> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* Old or malformed browser preferences start empty. */ }
  return {};
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export const cameraRoomPreviewKey = (baseUrl: string, deviceId: string) => JSON.stringify([baseUrl, deviceId]);

export function setCameraRoomPreview(key: string, provider?: Provider) {
  const next = parse(read());
  if (provider) next[key] = provider;
  else delete next[key];
  fallback = JSON.stringify(next);
  try { localStorage.setItem(storageKey, fallback); } catch { /* Keep the setting in memory for this page. */ }
  listeners.forEach((listener) => listener());
}

export function useCameraRoomPreviews() {
  const stored = useSyncExternalStore(subscribe, read);
  return useMemo(() => parse(stored), [stored]);
}
