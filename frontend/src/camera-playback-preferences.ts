import { useSyncExternalStore } from 'react';

const storageKey = 'smart-home.ui.camera-playback-stopped.v1';
const listeners = new Set<() => void>();
let fallback = '{}';
let memoryOnly = false;

function read() {
  if (memoryOnly) return fallback;
  try { return localStorage.getItem(storageKey) ?? '{}'; } catch { return fallback; }
}

function parse(value: string): Record<string, true> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter(([, stopped]) => stopped === true));
    }
  } catch { /* Ignore malformed browser preferences. */ }
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

export const cameraPlaybackPreferenceKey = (baseUrl: string, deviceId: string) => JSON.stringify([baseUrl, deviceId]);
export const cameraPlaybackStopped = (key: string) => parse(read())[key] === true;

export function setCameraPlaybackStopped(key: string, stopped: boolean) {
  const next = parse(read());
  if (stopped) next[key] = true;
  else delete next[key];
  fallback = JSON.stringify(next);
  try { localStorage.setItem(storageKey, fallback); memoryOnly = false; } catch { memoryOnly = true; }
  listeners.forEach((listener) => listener());
}

export function useCameraPlaybackStopped(key: string) {
  const stored = useSyncExternalStore(subscribe, read);
  return parse(stored)[key] === true;
}
