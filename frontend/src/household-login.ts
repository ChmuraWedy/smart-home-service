import { appPaths } from './navigation';

export type HouseholdSignIn = { login: string; key: string };

export function readHouseholdSignIn(hash: string): HouseholdSignIn | undefined {
  const fields = new URLSearchParams(hash.slice(1));
  const login = fields.get('login');
  const key = fields.get('key');
  if (!login || !key || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/.test(login) || !/^shm_[A-Za-z0-9_-]{43}$/.test(key)) {
    return undefined;
  }
  return { login, key };
}

export function householdSignInLink(login: string, key: string) {
  const url = new URL(appPaths.connections, window.location.origin);
  url.hash = new URLSearchParams({ login, key }).toString();
  return url.href;
}
