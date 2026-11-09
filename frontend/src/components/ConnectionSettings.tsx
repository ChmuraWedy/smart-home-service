import {
  useEffect, useId, useRef, useState,
} from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { normalizeApiBase } from '../api';
import type { Connection } from '../api';
import { DEFAULT_API_BASE } from '../connection';
import type { HouseholdSignIn } from '../household-login';
import { MSG, t } from '../i18n';

type Props = {
  connection: Connection;
  busy: boolean;
  invitation?: HouseholdSignIn;
  onSave: (address: string, candidate: string, login: string) => Promise<void>;
};

export function ConnectionSettings({
  connection, busy, invitation, onSave,
}: Props) {
  const prefix = useId();
  const [address, setAddress] = useState(connection.baseUrl);
  const [candidate, setCandidate] = useState('');
  const [login, setLogin] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAddress(invitation ? DEFAULT_API_BASE : connection.baseUrl);
    setCandidate(invitation?.key ?? '');
    setLogin(invitation?.login ?? '');
    setEditingKey(Boolean(invitation));
    if (details.current) details.current.open = Boolean(invitation) || !connection.token;
  }, [connection, invitation]);

  useEffect(() => {
    if (editingKey && !invitation) keyInput.current?.focus();
  }, [editingKey, invitation]);

  let savedForAddress = false;
  try { savedForAddress = Boolean(connection.token) && normalizeApiBase(address) === connection.baseUrl; } catch { /* An incomplete address needs its own key before saving. */ }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(address, candidate, login);
  }

  function changeAddress(value: string) {
    setAddress(value);
    setCandidate('');
    setLogin('');
    setEditingKey(false);
  }

  function editKey(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (busy) return;
    setCandidate('');
    setEditingKey(true);
  }

  function cancelEditing() {
    setCandidate('');
    setLogin('');
    setEditingKey(false);
  }

  return (
    <details ref={details} className="connection-settings">
      <summary>{t(MSG.CONNECTION_SETTINGS)}</summary>
      <p className="muted">{t(MSG.ENTER_THE_PYTHON_SERVICE_ADDRESS)}</p>
      <form aria-label={t(MSG.SERVICE_ACCESS)} onSubmit={submit}>
        <label htmlFor={`${prefix}-address`}>
          {t(MSG.API_ADDRESS)}
          <input
            id={`${prefix}-address`}
            type="url"
            value={address}
            onChange={(event) => changeAddress(event.target.value)}
            required
            disabled={busy || Boolean(invitation)}
            placeholder="http://192.168.1.10:8000"
          />
        </label>
        {(!savedForAddress || editingKey) && (
          <label htmlFor={`${prefix}-login`}>
            {t(MSG.USER_LOGIN)}
            <input
              id={`${prefix}-login`}
              value={login}
              maxLength={40}
              autoComplete="username"
              disabled={busy}
              required={Boolean(invitation)}
              onChange={(event) => setLogin(event.target.value)}
            />
          </label>
        )}
        <div id="service-key">
          {savedForAddress && !editingKey ? (
            <p className="saved-summary">
              {t(MSG.THE_SERVICE_ACCESS_KEY_IS_SAVED_IN_THIS)}
              {' '}
              <a
                href="#service-key"
                aria-controls="service-key"
                aria-expanded={false}
                aria-disabled={busy}
                onClick={editKey}
              >
                {t(MSG.EDIT)}
              </a>
            </p>
          ) : (
            <label htmlFor={`${prefix}-key`}>
              {t(MSG.SERVICE_ACCESS_KEY)}
              <input
                id={`${prefix}-key`}
                type="password"
                value={candidate}
                onChange={(event) => setCandidate(event.target.value)}
                disabled={busy}
                autoComplete="off"
                ref={keyInput}
                required
                placeholder={savedForAddress ? t(MSG.ENTER_A_NEW_ACCESS_KEY) : t(MSG.ENTER_ACCESS_KEY)}
              />
            </label>
          )}
        </div>
        <div className="actions">
          <button disabled={busy} type="submit">{t(MSG.SAVE_CONNECTION)}</button>
          {savedForAddress && editingKey && !invitation && (
            <button type="button" className="secondary" disabled={busy} onClick={cancelEditing}>{t(MSG.CANCEL_EDITING)}</button>
          )}
        </div>
      </form>
    </details>
  );
}
