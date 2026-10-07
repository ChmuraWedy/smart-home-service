import { useEffect, useRef, useState } from 'react';
import { normalizeApiBase } from '../api';
import type { Connection } from '../api';

type Props = {
  connection: Connection;
  busy: boolean;
  onSave: (address: string, candidate: string) => Promise<void>;
};

export function ConnectionSettings({ connection, busy, onSave }: Props) {
  const [address, setAddress] = useState(connection.baseUrl);
  const [candidate, setCandidate] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    setAddress(connection.baseUrl); setCandidate(''); setEditingKey(false);
    if (details.current) details.current.open = !connection.token;
  }, [connection]);
  let savedForAddress = false;
  try { savedForAddress = Boolean(connection.token) && normalizeApiBase(address) === connection.baseUrl; }
  catch { /* An incomplete address needs its own key before saving. */ }
  return <details ref={details} className="connection-settings">
    <summary>Настройки подключения</summary>
    <p className="muted">Укажите адрес Python-сервиса. Ключ доступа хранится в этом браузере и используется автоматически.</p>
    <form aria-label="Доступ к сервису" onSubmit={event => { event.preventDefault(); void onSave(address, candidate); }}>
      <label>Адрес API<input type="url" value={address} onChange={event => {
        setAddress(event.target.value); setCandidate(''); setEditingKey(false);
      }} required disabled={busy} placeholder="http://192.168.1.10:8000" /></label>
      <div id="service-key">
        {savedForAddress && !editingKey ? <p className="saved-summary">Ключ доступа к сервису сохранён в этом браузере. <a href="#service-key" aria-controls="service-key" aria-expanded={false} aria-disabled={busy} onClick={event => {
          event.preventDefault(); if (!busy) { setCandidate(''); setEditingKey(true); }
        }}>Хочу изменить</a></p> : <label>Ключ доступа к сервису<input type="password" value={candidate} onChange={event => setCandidate(event.target.value)} disabled={busy} autoComplete="off" autoFocus={editingKey} required placeholder={savedForAddress ? 'Введите новый ключ доступа' : 'Введите ключ доступа'} /></label>}
      </div>
      <div className="actions"><button disabled={busy} type="submit">Сохранить подключение</button>
        {savedForAddress && editingKey && <button type="button" className="secondary" disabled={busy} onClick={() => { setCandidate(''); setEditingKey(false); }}>Отменить изменение</button>}
      </div>
    </form>
  </details>;
}
