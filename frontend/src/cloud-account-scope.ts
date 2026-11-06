import type { CloudApi, Provider } from './api';

const scopes = new WeakMap<CloudApi, Partial<Record<Provider, number>>>();
let nextScope = 0;

export function cloudAccountScope(api: CloudApi, provider: Provider): number {
  let providers = scopes.get(api);
  if (!providers) {
    providers = {};
    scopes.set(api, providers);
  }
  return providers[provider] ??= ++nextScope;
}

export function rotateCloudAccountScope(api: CloudApi, provider: Provider) {
  const providers = scopes.get(api);
  if (providers) delete providers[provider];
}
