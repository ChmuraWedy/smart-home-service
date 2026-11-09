import { useEffect, useRef, useState } from 'react';
import { MSG, t } from '../i18n';
import { normalizeApiBase } from '../api';
import type { Connection } from '../api';

type Props = {
  connection: Connection;
  busy: boolean;
  inline?: boolean;
  onSave: (address: string, candidate: string) => Promise<void>;
};

export function ConnectionSettings({
  connection, busy, onSave, inline,
}: Props) {
  const [address, setAddress] = useState(connection.baseUrl);
  const [candidate, setCandidate] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    setAddress(connection.baseUrl); setCandidate(''); setEditingKey(false);
    if (details.current) details.current.open = !connection.token;
  }, [connection]);
  let savedForAddress = false;
  try { savedForAddress = Boolean(connection.token) && normalizeApiBase(address) === connection.baseUrl; } catch { /* An incomplete address needs its own key before saving. */ }
  const fields = (
    <>
      <p className="muted">{t(MSG.ENTER_THE_PYTHON_SERVICE_ADDRESS)}</p>
      <form aria-label={t(MSG.SERVICE_ACCESS)} onSubmit={(event) => { event.preventDefault(); void onSave(address, candidate); }}>
        <label>{t(MSG.API_ADDRESS)}
          <input
            type="url"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value); setCandidate(''); setEditingKey(false);
            }}
            required
            disabled={busy}
            placeholder="http://192.168.1.10:8000"
          />
        </label>
        <div id="service-key">
          {savedForAddress && !editingKey ? (
            <p className="saved-summary">{`${t(MSG.THE_SERVICE_ACCESS_KEY_IS_SAVED_IN_THIS)} `}
              <a
                href="#service-key"
                aria-controls="service-key"
                aria-expanded={false}
                aria-disabled={busy}
                onClick={(event) => {
                  event.preventDefault(); if (!busy) { setCandidate(''); setEditingKey(true); }
                }}
              >{t(MSG.EDIT)}
              </a>
            </p>
          ) : (
            <label>{t(MSG.SERVICE_ACCESS_KEY)}
              <input
                type="password"
                value={candidate}
                onChange={(event) => setCandidate(event.target.value)}
                disabled={busy}
                autoComplete="off"
                autoFocus={editingKey}
                required
                placeholder={savedForAddress ? t(MSG.ENTER_A_NEW_ACCESS_KEY) : t(MSG.ENTER_ACCESS_KEY)}
              />
            </label>
          )}
        </div>
        <div className="actions">
          <button disabled={busy} type="submit">{t(MSG.SAVE_CONNECTION)}</button>
          {savedForAddress && editingKey && <button type="button" className="secondary" disabled={busy} onClick={() => { setCandidate(''); setEditingKey(false); }}>{t(MSG.CANCEL_EDITING)}</button>}
        </div>
      </form>
    </>
  );
  if (inline) return fields;
  return (
    <details ref={details} className="connection-settings">
      <summary>{t(MSG.CONNECTION_SETTINGS)}</summary>
      {fields}
    </details>
  );
}
