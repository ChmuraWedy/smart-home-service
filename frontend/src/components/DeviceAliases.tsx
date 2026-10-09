import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, Provider } from '../api';

export function DeviceAliases({ api, deviceId, name, initialAliases = [], provider, localId, disabled, onBusy, onAuthError }: {
  api: CloudApi; deviceId: string; name: string; initialAliases?: string[]; provider?: Provider; localId?: number;
  disabled: boolean; onBusy: (busy: boolean) => void; onAuthError: () => void;
}) {
  const custom = (values: string[]) => values.filter(alias => alias.toLocaleLowerCase() !== name.toLocaleLowerCase());
  const initial = JSON.stringify(custom(initialAliases));
  const [aliases, setAliases] = useState<string[]>(() => JSON.parse(initial));
  const [open, setOpen] = useState(false), [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const authError = useRef(onAuthError); authError.current = onAuthError;
  useEffect(() => { setAliases(JSON.parse(initial)); }, [initial]);
  useEffect(() => { onBusy(loading || saving); }, [loading, saving, onBusy]);
  useEffect(() => () => { pending.current?.abort(); onBusy(false); }, [onBusy]);
  const failure = (reason: unknown) => {
    setError(reason instanceof ApiError && reason.status === 409 ? 'Этот алиас уже используется другим устройством.' : reason instanceof Error ? reason.message : 'Не удалось сохранить алиасы.');
    if (reason instanceof ApiError && reason.status === 401) authError.current();
  };
  useEffect(() => {
    if (!open || !provider) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void api.deviceAliases(deviceId, provider, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.device_id !== deviceId || !Array.isArray(result.aliases)) throw new Error('Сервис вернул алиасы другого устройства.');
      setAliases(custom(result.aliases));
    }).catch(reason => { if (!controller.signal.aborted) failure(reason); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); setLoading(false); };
  }, [open, api, deviceId, provider]);
  async function save(values: string[], message: string) {
    if (disabled || loading || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setSaving(true); setNotice(''); setError('');
    try {
      const result = provider ? await api.saveDeviceAliases(deviceId, provider, values, controller.signal)
        : await api.saveLocalDeviceAliases(localId!, values, controller.signal);
      if (controller.signal.aborted) return;
      if (result.device_id !== deviceId || !Array.isArray(result.aliases)) throw new Error('Сервис вернул алиасы другого устройства.');
      setAliases(custom(result.aliases)); setDraft(''); setNotice(message);
    } catch (reason) { if (!controller.signal.aborted) failure(reason); }
    finally { if (!controller.signal.aborted) { pending.current = null; setSaving(false); } }
  }
  const busy = disabled || loading || saving;
  return <div className="device-alias-editor">
    {!!aliases.length && <ul className="capability-aliases" aria-label="Алиасы устройства">{aliases.map(alias => <li className="alias-tag" key={alias}><span>Алиас:</span> {alias}</li>)}</ul>}
    <details className="cloud-properties" onToggle={event => setOpen(event.currentTarget.open)}><summary>Алиасы устройства</summary>
      <p className="help">Дополнительные имена для тегов и поиска. Название устройства в Smart Life сохраняется. Используйте латинские буквы, цифры, точку, дефис или подчёркивание, начиная с буквы. Алиасы сохраняются строчными буквами.</p>
      {loading && <p role="status">Загружаем алиасы…</p>}
      <form aria-label="Добавление алиаса устройства" onSubmit={event => {
        event.preventDefault(); const value = draft.trim().toLowerCase();
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(value)) { setError('Введите алиас из 1–64 символов, начиная с латинской буквы.'); return; }
        if (aliases.includes(value) || value === name.toLowerCase()) { setError('Такой алиас уже есть.'); return; }
        void save([...aliases, value], 'Алиас добавлен.');
      }}><label>Новый алиас<input value={draft} maxLength={64} disabled={busy || aliases.length >= 32} onChange={event => { setDraft(event.target.value); setError(''); setNotice(''); }} /></label>
        <button type="submit" disabled={busy || !draft.trim() || aliases.length >= 32}>Добавить алиас</button>
      </form>
      {!!aliases.length && <ul className="device-alias-list">{aliases.map(alias => <li key={alias}><span>{alias}</span><button className="secondary compact" aria-label={'Удалить алиас ' + alias} disabled={busy} onClick={() => void save(aliases.filter(item => item !== alias), 'Алиас удалён.')}>Удалить</button></li>)}</ul>}
      {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    </details>
  </div>;
}
