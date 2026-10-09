import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, CloudFunctions, Provider } from '../api';
import { labelFor } from '../controls';

export function ChannelAliases({ api, deviceId, provider, definitions, disabled, onBusy, onSaved, onAuthError }: {
  api: CloudApi; deviceId: string; provider: Provider; definitions: CloudFunctions; disabled: boolean;
  onBusy: (busy: boolean) => void; onSaved: (labels: Record<string, string>) => void; onAuthError: () => void;
}) {
  const channels = [...new Map([...(definitions.status_range || []), ...definitions.functions].filter(fn => /^switch_[1-9][0-9]*$/.test(fn.code)).map(fn => [fn.code, fn])).values()];
  const saved = JSON.stringify(Object.fromEntries(channels.map(fn => [fn.code, fn.user_label || ''])));
  const [draft, setDraft] = useState<Record<string, string>>(() => JSON.parse(saved));
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => { setDraft(JSON.parse(saved)); }, [saved]);
  useEffect(() => () => { pending.current?.abort(); onBusy(false); }, [onBusy]);
  if (!channels.length) return null;
  async function save() {
    if (disabled || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); onBusy(true); setNotice(''); setError('');
    try {
      const result = await api.saveChannelLabels(deviceId, provider, Object.fromEntries(Object.entries(draft).map(([code, label]) => [code, label.trim() || null])), controller.signal);
      if (controller.signal.aborted) return;
      if (result.device_id !== deviceId) throw new Error('Сервис вернул алиасы другого устройства.');
      onSaved(result.labels); setNotice('Алиасы сохранены в нашей базе.');
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : 'Не удалось сохранить алиасы.');
        if (failure instanceof ApiError && failure.status === 401) onAuthError();
      }
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false); onBusy(false); }
    }
  }
  return <details className="cloud-properties"><summary>Алиасы каналов</summary>
    <p className="help">Дополнительные подписи сохраняются в нашей базе и показываются тегами под каналами. Они не заменяют названия каналов и не синхронизируются со Smart Life. Пустое поле удаляет алиас.</p>
    <form aria-label="Алиасы каналов" onSubmit={event => { event.preventDefault(); void save(); }}>
      {channels.map(fn => <label key={fn.code}>Алиас канала {fn.code.slice(7)}<input maxLength={120} value={draft[fn.code] || ''} placeholder={labelFor(fn.code)} disabled={disabled || busy} onChange={event => { setDraft({ ...draft, [fn.code]: event.target.value }); setNotice(''); setError(''); }} /></label>)}
      <button type="submit" disabled={disabled || busy || JSON.stringify(draft) === saved}>Сохранить алиасы</button>
    </form>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </details>;
}
