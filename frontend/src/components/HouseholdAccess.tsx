import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import type { HouseholdMember } from '../api';
import type { HomeApi } from '../home-api';
import { MSG, t, translateText } from '../i18n';

export default function HouseholdAccess({ api, onAuthError }: { api: HomeApi; onAuthError: () => void }) {
  const memberNameId = useId();
  const issuedKeyId = useId();
  const [members, setMembers] = useState<HouseholdMember[]>();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<HouseholdMember & { accessKey: string }>();
  const [revoke, setRevoke] = useState<HouseholdMember>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api.householdMembers(controller.signal).then((rows) => {
      if (!controller.signal.aborted) setMembers(rows);
    }).catch((failure) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    });
    return () => controller.abort();
  }, [api, onAuthError, retry]);

  async function change(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    } finally {
      setBusy(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || issued) return;
    change(async () => {
      const result = await api.createHouseholdMember(name.trim());
      const member = { id: result.id, name: result.name };
      setIssued({ ...member, accessKey: result.access_key });
      setMembers((rows) => [...(rows ?? []), member]);
      setName('');
    });
  }

  function confirmRevocation() {
    if (!revoke) return;
    change(async () => {
      await api.revokeHouseholdMember(revoke.id);
      setMembers((rows) => rows?.filter(({ id }) => id !== revoke.id));
      if (issued?.id === revoke.id) setIssued(undefined);
      setRevoke(undefined);
    });
  }

  function reload() {
    setError('');
    setRetry((attempt) => attempt + 1);
  }

  return (
    <section className="card household-access">
      <h2>{t(MSG.HOUSEHOLD_ACCESS)}</h2>
      <p className="help">{t(MSG.HOUSEHOLD_ACCESS_HELP)}</p>
      {members && (
        <>
          <form className="actions" onSubmit={create}>
            <label htmlFor={memberNameId}>
              {t(MSG.HOUSEHOLD_MEMBER_NAME)}
              <input
                id={memberNameId}
                value={name}
                maxLength={80}
                required
                disabled={busy || Boolean(issued || revoke)}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button type="submit" disabled={busy || !name.trim() || Boolean(issued || revoke)}>
              {t(MSG.CREATE_HOUSEHOLD_ACCESS)}
            </button>
          </form>
          {issued && (
            <div className="saved-summary">
              <label htmlFor={issuedKeyId}>
                {t(MSG.HOUSEHOLD_NEW_KEY, [issued.name])}
                <input
                  id={issuedKeyId}
                  value={issued.accessKey}
                  readOnly
                  autoComplete="off"
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <p className="help">{t(MSG.HOUSEHOLD_NEW_KEY_HELP)}</p>
              <button type="button" className="secondary compact" onClick={() => setIssued(undefined)}>
                {t(MSG.CLOSE)}
              </button>
            </div>
          )}
          <ul className="group-members">
            {members.map((member) => (
              <li key={member.id}>
                <strong>{member.name}</strong>
                <button
                  type="button"
                  className="secondary compact"
                  disabled={busy || Boolean(revoke)}
                  onClick={() => setRevoke(member)}
                >
                  {t(MSG.REVOKE_HOUSEHOLD_ACCESS, [member.name])}
                </button>
              </li>
            ))}
          </ul>
          {revoke && (
            <div className="saved-summary">
              <p>{t(MSG.REVOKE_HOUSEHOLD_CONFIRM, [revoke.name])}</p>
              <div className="actions">
                <button type="button" disabled={busy} onClick={confirmRevocation}>
                  {t(MSG.YES)}
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setRevoke(undefined)}>
                  {t(MSG.CANCEL)}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <p className="field-error" role="alert">{translateText(error)}</p>}
      {!members && error && (
        <button type="button" className="secondary compact" onClick={reload}>{t(MSG.REFRESH_LIST)}</button>
      )}
      {!members && !error && <p className="help" role="status">{t(MSG.LOADING_LIST)}</p>}
    </section>
  );
}
