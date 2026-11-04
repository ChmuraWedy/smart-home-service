import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEY } from './connection';

describe('deployment API address', () => {
  it('uses the browser origin for same-origin builds without reusing another origin key', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'same-origin');
    vi.resetModules();
    try {
      const { DEFAULT_API_BASE, loadConnection } = await import('./connection');
      expect(DEFAULT_API_BASE).toBe(window.location.origin);
      expect(loadConnection()).toEqual({ baseUrl: window.location.origin, token: '' });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl: 'http://old-api.test:8765', token: 'original-host-only' }));
      expect(loadConnection()).toEqual({ baseUrl: 'http://old-api.test:8765', token: 'original-host-only' });
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
});
