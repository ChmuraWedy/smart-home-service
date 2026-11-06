import { MSG, t } from "../i18n";
import { useEffect, useRef } from 'react';
import { ApiError } from '../api';
import type { CloudApi, Provider } from '../api';
import { cloudAccountScope } from '../cloud-account-scope';
import { cloudMetadataKey, localMetadataKey, nextDeviceMetadataRevision, saveDeviceAliases } from '../device-metadata';
import { useAppDispatch, useAppSelector } from '../store';
import { AliasRow } from './AliasRow';

export function DeviceAliases({ api, deviceId, name, initialAliases = [], provider, localId, disabled, onBusy, onAuthError }: {
  api: CloudApi; deviceId: string; name: string; initialAliases?: string[]; provider?: Provider; localId?: number;
  disabled: boolean; onBusy: (busy: boolean) => void; onAuthError: () => void;
}) {
  const custom = (values: string[]) => values.filter(alias => alias.normalize('NFC').toLocaleLowerCase() !== name.normalize('NFC').toLocaleLowerCase());
  const dispatch = useAppDispatch();
  const localKey = localId === undefined ? undefined : localMetadataKey(api, localId);
  const key = provider ? cloudMetadataKey(cloudAccountScope(api, provider), deviceId) : localKey!;
  const aliases = useAppSelector(state => state.deviceMetadata.devices[key]?.aliases?.value) ?? initialAliases;
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); onBusy(false); }, [onBusy]);
  async function save(values: string[]) {
    const linkedKeys = localKey ? (['sharing', 'developer'] as const)
      .filter(route => route !== provider)
      .map(route => cloudMetadataKey(cloudAccountScope(api, route), deviceId)) : [];
    const controller = new AbortController(); pending.current = controller; onBusy(true);
    try {
      const result = provider ? await api.saveDeviceAliases(deviceId, provider, values, controller.signal)
        : await api.saveLocalDeviceAliases(localId!, values, controller.signal);
      if (controller.signal.aborted) return;
      if (result.device_id !== deviceId || !Array.isArray(result.aliases)) throw new Error(t(MSG.THE_SERVICE_RETURNED_ANOTHER_DEVICES_ALIASES));
      dispatch(saveDeviceAliases({ key, localKey, linkedKeys, revision: nextDeviceMetadataRevision(), aliases: result.aliases }));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      if (failure instanceof ApiError && failure.status === 409) throw new Error(t(MSG.THIS_ALIAS_IS_ALREADY_USED_BY_ANOTHER_DEVICE));
      throw failure;
    } finally { if (!controller.signal.aborted) { pending.current = null; onBusy(false); } }
  }
  return (
    <div className="device-alias-heading">
      <h2>{name}</h2>
      <AliasRow label={t(MSG.ALIASES_LABEL)} aliases={custom(aliases)} disabled={disabled} onSave={save} validate={value => /^[\p{L}][\p{L}\p{M}\p{N} ._-]*$/u.test(value)} />
    </div>
  );
}
