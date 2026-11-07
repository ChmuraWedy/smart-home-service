import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import type { CloudApi, CloudFunctions } from './api';
import { localDeviceKey } from './local-device-cache';
import { withTranslation, withoutRemovedAliases } from './device-translations';
import type { DeviceTranslations, TranslationEdit } from './device-translations';

type Versioned<T> = { revision: number; value: T };
type DeviceIdentity = {
  name?: Versioned<string>;
  aliases?: Versioned<string[]>;
  translations?: Versioned<DeviceTranslations>;
};
type DeviceMetadataState = {
  devices: Record<string, DeviceIdentity | undefined>;
  channels: Record<string, Versioned<Record<string, string>> | undefined>;
};
type DeviceMetadataUpdate = {
  key: string; revision: number; name?: string; aliases?: string[]; channelLabels?: Record<string, string>;
  translations?: DeviceTranslations;
};

const initialState: DeviceMetadataState = { devices: {}, channels: {} };
let latestRevision = 0;

export const nextDeviceMetadataRevision = () => ++latestRevision;
export const cloudMetadataKey = (scope: number, deviceId: string) => 'cloud:' + scope + ':' + deviceId;
export const localMetadataKey = (api: CloudApi, id: number) => 'local:' + localDeviceKey(api, id).scope + ':' + id;

export function labelsFromCloudDefinitions(definitions: CloudFunctions) {
  return Object.fromEntries(
    [...(definitions.status_range ?? []), ...definitions.functions]
      .flatMap(fn => fn.user_label ? [[fn.code, fn.user_label]] : []),
  );
}

const deviceMetadata = createSlice({
  name: 'deviceMetadata',
  initialState,
  reducers: {
    cacheDeviceMetadata(state, { payload }: PayloadAction<DeviceMetadataUpdate[]>) {
      for (const { key, revision, name, aliases, channelLabels, translations } of payload) {
        // A response from a read started before a save cannot roll back the saved metadata.
        if (channelLabels !== undefined && (state.channels[key]?.revision ?? 0) < revision) {
          state.channels[key] = { revision, value: channelLabels };
        }
        if (name !== undefined || aliases !== undefined || translations !== undefined) {
          const device = state.devices[key] ?? {};
          if (name !== undefined && (device.name?.revision ?? 0) < revision) device.name = { revision, value: name };
          if (aliases !== undefined && (device.aliases?.revision ?? 0) < revision) device.aliases = { revision, value: aliases };
          if (translations !== undefined && (device.translations?.revision ?? 0) < revision) device.translations = { revision, value: translations };
          state.devices[key] = device;
        }
      }
    },
    saveDeviceAliases(state, { payload }: PayloadAction<{
      key: string; localKey?: string; linkedKeys: string[]; revision: number; aliases: string[];
    }>) {
      const { key, localKey, linkedKeys, revision, aliases } = payload;
      const previousLocal = localKey ? state.devices[localKey]?.aliases?.value ?? [] : [];
      for (const linkedKey of linkedKeys) {
        const linked = state.devices[linkedKey];
        if (!linked?.aliases || linked.aliases.revision >= revision) continue;
        // Cloud alias lists include local tags as well as provider-specific tags.
        const providerAliases = linked.aliases.value.filter(alias => !previousLocal.includes(alias));
        linked.aliases = { revision, value: [...new Set([...providerAliases, ...aliases])] };
        if (linked.translations) {
          linked.translations = { revision, value: withoutRemovedAliases(linked.translations.value, linked.aliases.value) };
        }
      }
      for (const itemKey of new Set(localKey ? [key, localKey] : [key])) {
        const item = state.devices[itemKey] ?? {};
        item.aliases = { revision, value: aliases };
        state.devices[itemKey] = item;
        if (item.translations) item.translations = { revision, value: withoutRemovedAliases(item.translations.value, aliases) };
      }
    },
    saveDeviceTranslation(state, { payload }: PayloadAction<{
      key: string; linkedKeys: string[]; revision: number; edit: TranslationEdit; initial?: DeviceTranslations;
    }>) {
      const {
        key, linkedKeys, revision, edit, initial,
      } = payload;
      for (const itemKey of new Set([key, ...linkedKeys])) {
        const item = state.devices[itemKey] ?? {};
        const previous = item.translations?.value ?? (itemKey === key ? initial : undefined);
        item.translations = { revision, value: withTranslation(previous, edit) };
        state.devices[itemKey] = item;
      }
    },
  },
});

export const { cacheDeviceMetadata, saveDeviceAliases, saveDeviceTranslation } = deviceMetadata.actions;
export const deviceMetadataReducer = deviceMetadata.reducer;
