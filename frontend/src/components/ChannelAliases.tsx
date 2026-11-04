import { t } from "../i18n";
import { useEffect, useRef } from 'react';
import { ApiError } from '../api';
import type { CloudApi, Provider } from '../api';
import { AliasRow } from './AliasRow';

export function ChannelAliases({ api, deviceId, provider, code, alias, disabled, onBusy, onSaved, onAuthError }: {
  api: CloudApi; deviceId: string; provider: Provider; code: string; alias?: string; disabled: boolean;
  onBusy: (busy: boolean) => void; onSaved: (labels: Record<string, string>) => void; onAuthError: () => void;
}) {
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); onBusy(false); }, [onBusy]);
  return <AliasRow aliases={alias ? [alias] : []} maxAliases={1} maxLength={120} disabled={disabled} onSave={async values => {
    const controller = new AbortController(); pending.current = controller; onBusy(true);
    try {
      const result = await api.saveChannelLabels(deviceId, provider, { [code]: values[0] || null }, controller.signal);
      if (!controller.signal.aborted) {
        if (result.device_id !== deviceId) throw new Error(t("Сервис вернул алиасы другого устройства."));
        onSaved(result.labels);
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      throw failure;
    } finally { if (!controller.signal.aborted) { pending.current = null; onBusy(false); } }
  }} />;
}
