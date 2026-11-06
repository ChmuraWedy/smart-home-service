import { expect, it } from 'vitest';
import { CloudApi } from './api';
import { cloudAccountScope, rotateCloudAccountScope } from './cloud-account-scope';
import { cacheDeviceMetadata, cloudMetadataKey, localMetadataKey, nextDeviceMetadataRevision, saveDeviceAliases } from './device-metadata';
import { createAppStore } from './store';

it('keeps a confirmed edit ahead of an older read and isolates account and provider metadata', () => {
  const api = new CloudApi({ baseUrl: 'http://api.test', token: 'fixture-key' });
  const key = cloudMetadataKey(cloudAccountScope(api, 'sharing'), 'coffee');
  const developer = cloudMetadataKey(cloudAccountScope(api, 'developer'), 'coffee');
  const store = createAppStore();
  const readRevision = nextDeviceMetadataRevision();
  store.dispatch(cacheDeviceMetadata([{ key, revision: nextDeviceMetadataRevision(), aliases: [], channelLabels: { switch_1: 'Kawa' } }]));
  store.dispatch(cacheDeviceMetadata([{ key, revision: readRevision, name: 'Coffee Machine', aliases: ['Old tag'], channelLabels: {} }]));
  expect(store.getState().deviceMetadata.devices[key]?.name?.value).toBe('Coffee Machine');
  expect(store.getState().deviceMetadata.devices[key]?.aliases?.value).toEqual([]);
  expect(store.getState().deviceMetadata.channels[key]?.value).toEqual({ switch_1: 'Kawa' });
  expect(store.getState().deviceMetadata.channels[developer]).toBeUndefined();

  store.dispatch(cacheDeviceMetadata([{ key, revision: nextDeviceMetadataRevision(), channelLabels: {} }]));
  expect(store.getState().deviceMetadata.channels[key]?.value).toEqual({});
  rotateCloudAccountScope(api, 'sharing');
  const nextAccount = cloudMetadataKey(cloudAccountScope(api, 'sharing'), 'coffee');
  expect(store.getState().deviceMetadata.devices[nextAccount]).toBeUndefined();
});

it('updates linked local aliases while preserving tags specific to the other provider', () => {
  const api = new CloudApi({ baseUrl: 'http://api.test', token: 'fixture-key' });
  const sharing = cloudMetadataKey(cloudAccountScope(api, 'sharing'), 'coffee');
  const developer = cloudMetadataKey(cloudAccountScope(api, 'developer'), 'coffee');
  const local = localMetadataKey(api, 7);
  const store = createAppStore();
  const revision = nextDeviceMetadataRevision();
  store.dispatch(cacheDeviceMetadata([
    { key: local, revision, aliases: ['Old local'] },
    { key: sharing, revision, aliases: ['Old local', 'Old Sharing'] },
    { key: developer, revision, aliases: ['Old local', 'Developer tag'] },
  ]));
  store.dispatch(saveDeviceAliases({
    key: sharing, localKey: local, linkedKeys: [developer], revision: nextDeviceMetadataRevision(), aliases: ['New local'],
  }));
  const devices = store.getState().deviceMetadata.devices;
  expect(devices[local]?.aliases?.value).toEqual(['New local']);
  expect(devices[sharing]?.aliases?.value).toEqual(['New local']);
  expect(devices[developer]?.aliases?.value).toEqual(['Developer tag', 'New local']);
});
