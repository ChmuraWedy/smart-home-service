import { t } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, Provider } from '../api';
import { AliasRow } from './AliasRow';

export function DeviceAliases({ api, deviceId, name, initialAliases = [], provider, localId, disabled, onBusy, onAuthError }: {
  api: CloudApi; deviceId: string; name: string; initialAliases?: string[]; provider?: Provider; localId?: number;
  disabled: boolean; onBusy: (busy: boolean) => void; onAuthError: () => void;
}) {
  const custom = (values: string[]) => values.filter(alias => alias.normalize('NFC').toLocaleLowerCase() !== name.normalize('NFC').toLocaleLowerCase());
  const initial = JSON.stringify(custom(initialAliases));
  const [aliases, setAliases] = useState<string[]>(() => JSON.parse(initial));
  const pending = useRef<AbortController | null>(null);
  useEffect(() => { setAliases(JSON.parse(initial)); }, [initial]);
  useEffect(() => () => { pending.current?.abort(); onBusy(false); }, [onBusy]);
  async function save(values: string[]) {
    const controller = new AbortController(); pending.current = controller; onBusy(true);
    try {
      const result = provider ? await api.saveDeviceAliases(deviceId, provider, values, controller.signal)
        : await api.saveLocalDeviceAliases(localId!, values, controller.signal);
      if (controller.signal.aborted) return;
      if (result.device_id !== deviceId || !Array.isArray(result.aliases)) throw new Error(t("Сервис вернул алиасы другого устройства."));
      setAliases(custom(result.aliases));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      if (failure instanceof ApiError && failure.status === 409) throw new Error(t("Этот алиас уже используется другим устройством."));
      throw failure;
    } finally { if (!controller.signal.aborted) { pending.current = null; onBusy(false); } }
  }
  return <div className="device-alias-heading"><h2>{name}</h2><AliasRow label={t("Алиасы:")} aliases={aliases} disabled={disabled} onSave={save} validate={value => /^[\p{L}][\p{L}\p{M}\p{N} ._-]*$/u.test(value)} /></div>;
}
