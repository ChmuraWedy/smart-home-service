import { useEffect, useRef, useState } from 'react';
import type { Connection } from '../api';

type Props = {
  connection: Connection;
  connected: boolean;
  busy: boolean;
  onSave: (address: string, candidate: string) => Promise<void>;
};

export function ConnectionSettings({ connection, connected, busy, onSave }: Props) {
  const [address, setAddress] = useState(connection.baseUrl);
  const [candidate, setCandidate] = useState('');
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    setAddress(connection.baseUrl); setCandidate('');
    if (details.current) details.current.open = !connection.token;
  }, [connection]);
  return <details ref={details} className="connection-settings">
    <summary>Настройки подключения</summary>
    <p className="muted">Укажите адрес Python-сервиса. Ключ доступа хранится в этом браузере и используется автоматически.</p>
    <form onSubmit={event => { event.preventDefault(); void onSave(address, candidate); }}>
      <label>Адрес API<input type="url" value={address} onChange={event => setAddress(event.target.value)} required disabled={busy} placeholder="http://192.168.1.10:8000" /></label>
      <label>Ключ доступа к сервису<input type="password" value={candidate} onChange={event => setCandidate(event.target.value)} disabled={busy} autoComplete="off" placeholder={connected ? 'Сохранён · оставьте пустым, чтобы сохранить текущий' : 'Введите ключ доступа'} /></label>
      <button disabled={busy} type="submit">Сохранить подключение</button>
    </form>
  </details>;
}
