import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import type { AccountIdentity, HouseholdDeviceKey, HouseholdMember } from '../api';
import { DEFAULT_API_BASE } from '../connection';
import { householdSignInLink } from '../household-login';
import type { HomeApi } from '../home-api';
import { MSG, t, translateText } from '../i18n';
import { Icon } from './ui/icon';

type Props = {
  api: HomeApi;
  account: AccountIdentity;
  onAuthError: () => void;
  onNameOwner: (ownerName: string) => Promise<void>;
};

type Revealed = { id: string; token: string };
type Removal = { type: 'user'; id: string; 'name': string } | { type: 'key'; id: string; 'name': string };

export default function HouseholdAccess({
  api, account, onAuthError, onNameOwner,
}: Props) {
  const prefix = useId();
  const root = account.role === 'owner';
  const [users, setUsers] = useState<HouseholdMember[]>([]);
  const [selected, setSelected] = useState(account.id);
  const [keys, setKeys] = useState<HouseholdDeviceKey[]>();
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [firstDevice, setFirstDevice] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [revealed, setRevealed] = useState<Revealed>();
  const [removal, setRemoval] = useState<Removal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const user = users.find(({ id }) => id === selected) ?? account;

  useEffect(() => {
    if (!root || account.needs_name) return undefined;
    const controller = new AbortController();
    api.householdMembers(controller.signal).then((rows) => {
      if (!controller.signal.aborted) setUsers(rows);
    }).catch((failure) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    });
    return () => controller.abort();
  }, [api, root, account.needs_name, onAuthError]);

  useEffect(() => {
    if (account.needs_name) return undefined;
    const controller = new AbortController();
    setKeys(undefined);
    setRevealed(undefined);
    api.householdDeviceKeys(selected, controller.signal).then((rows) => {
      if (!controller.signal.aborted) setKeys(rows);
    }).catch((failure) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    });
    return () => controller.abort();
  }, [api, account.needs_name, selected, onAuthError]);

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

  function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !login.trim() || !firstDevice.trim()) return;
    change(async () => {
      const { id, name: savedName, login: savedLogin } = await api.createHouseholdMember(name.trim(), login.trim().toLowerCase(), firstDevice.trim());
      setUsers((rows) => [...rows, { id, name: savedName, login: savedLogin }]);
      setKeys(undefined);
      setRevealed(undefined);
      setSelected(id);
      setName('');
      setLogin('');
      setFirstDevice('');
    });
  }

  function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deviceName.trim()) return;
    change(async () => {
      const created = await api.createHouseholdDeviceKey(selected, deviceName.trim());
      setKeys((rows) => [...(rows ?? []), created]);
      setDeviceName('');
    });
  }

  function toggleKey(key: HouseholdDeviceKey) {
    if (revealed?.id === key.id) {
      setRevealed(undefined);
      return;
    }
    setRevealed(undefined);
    change(async () => {
      const result = await api.householdDeviceKey(selected, key.id);
      setRevealed({ id: key.id, token: result.access_key });
    });
  }

  function confirmRemoval() {
    if (!removal) return;
    change(async () => {
      if (removal.type === 'user') {
        await api.revokeHouseholdMember(removal.id);
        setUsers((rows) => rows.filter(({ id }) => id !== removal.id));
        setKeys(undefined);
        setRevealed(undefined);
        setSelected(account.id);
      } else {
        await api.revokeHouseholdDeviceKey(selected, removal.id);
        setKeys((rows) => rows?.filter(({ id }) => id !== removal.id));
        if (revealed?.id === removal.id) setRevealed(undefined);
        if (account.key_id === removal.id) onAuthError();
      }
      setRemoval(undefined);
    });
  }

  function submitOwnerName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ownerName.trim()) change(() => onNameOwner(ownerName.trim()));
  }

  function selectUser(id: string) {
    setKeys(undefined);
    setRevealed(undefined);
    setSelected(id);
  }

  const alert = error && <p className="field-error" role="alert">{translateText(error)}</p>;
  if (account.needs_name) {
    return (
      <section className="card">
        <h1>{t(MSG.SET_OWNER_NAME)}</h1>
        <form className="actions" onSubmit={submitOwnerName}>
          <label htmlFor={`${prefix}-owner`}>
            {t(MSG.OWNER_NAME)}
            <input
              id={`${prefix}-owner`}
              value={ownerName}
              maxLength={80}
              required
              disabled={busy}
              onChange={(event) => setOwnerName(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !ownerName.trim()}>{t(MSG.SAVE)}</button>
        </form>
        {alert}
      </section>
    );
  }

  return (
    <section className="card household-access">
      <h1>{t(root ? MSG.USERS : MSG.MY_DEVICE_KEYS)}</h1>
      {root && (
        <form className="actions" onSubmit={createUser}>
          <label htmlFor={`${prefix}-name`}>
            {t(MSG.HOUSEHOLD_MEMBER_NAME)}
            <input
              id={`${prefix}-name`}
              value={name}
              maxLength={80}
              required
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label htmlFor={`${prefix}-login`}>
            {t(MSG.USER_LOGIN)}
            <input
              id={`${prefix}-login`}
              value={login}
              pattern="[a-zA-Z0-9][a-zA-Z0-9._\x2d]{2,39}"
              maxLength={40}
              required
              disabled={busy}
              onChange={(event) => setLogin(event.target.value)}
            />
          </label>
          <label htmlFor={`${prefix}-first-device`}>
            {t(MSG.KEY_DEVICE_NAME)}
            <input
              id={`${prefix}-first-device`}
              value={firstDevice}
              maxLength={80}
              required
              disabled={busy}
              onChange={(event) => setFirstDevice(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !name.trim() || !login.trim() || !firstDevice.trim()}>{t(MSG.ADD_USER)}</button>
        </form>
      )}
      {root && (
        <div className="actions">
          <label htmlFor={`${prefix}-user`}>
            {t(MSG.USERS)}
            <select
              id={`${prefix}-user`}
              value={selected}
              disabled={busy || Boolean(removal)}
              onChange={(event) => selectUser(event.target.value)}
            >
              {[account, ...users].map((item) => <option key={item.id} value={item.id}>{item.name} · {item.login}</option>)}
            </select>
          </label>
          {selected !== account.id && (
            <button type="button" className="secondary compact" disabled={busy || Boolean(removal)} onClick={() => setRemoval({ type: 'user', id: user.id, name: user.name })}>
              {t(MSG.REVOKE_HOUSEHOLD_ACCESS, [user.name])}
            </button>
          )}
        </div>
      )}
      <h2>{t(MSG.DEVICE_KEYS_FOR, [user.name])}</h2>
      <p className="help">{t(MSG.USER_LOGIN)} {user.login}</p>
      <form className="actions" onSubmit={createKey}>
        <label htmlFor={`${prefix}-device`}>
          {t(MSG.KEY_DEVICE_NAME)}
          <input
            id={`${prefix}-device`}
            value={deviceName}
            maxLength={80}
            required
            disabled={busy || !keys}
            onChange={(event) => setDeviceName(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !keys || !deviceName.trim()}>{t(MSG.CREATE_HOUSEHOLD_ACCESS)}</button>
      </form>
      {keys && (
        <ul className="group-members">
          {keys.map((key) => {
            const label = key.name || t(MSG.EXISTING_DEVICE_KEY);
            const token = revealed?.id === key.id ? revealed.token : undefined;
            return (
              <li key={key.id}>
                <strong>{label}</strong>
                {key.key_available ? (
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={busy}
                    aria-label={t(token ? MSG.HIDE_USER_KEY : MSG.SHOW_KEY_FOR_USER, [label])}
                    onClick={() => toggleKey(key)}
                  >
                    <Icon name={token ? 'eye-off' : 'eye'} />
                  </button>
                ) : <small>{t(MSG.USER_KEY_UNAVAILABLE)}</small>}
                <button type="button" className="secondary compact" disabled={busy || Boolean(removal)} onClick={() => setRemoval({ type: 'key', id: key.id, name: label })}>
                  {t(MSG.REVOKE_DEVICE_KEY, [label])}
                </button>
                {token && (
                  <div className="saved-summary">
                    <label htmlFor={`${prefix}-key-${key.id}`}>
                      {t(MSG.HOUSEHOLD_NEW_KEY, [label])}
                      <input
                        id={`${prefix}-key-${key.id}`}
                        value={token}
                        readOnly
                        autoComplete="off"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </label>
                    {api.baseUrl === DEFAULT_API_BASE && (
                      <label htmlFor={`${prefix}-link-${key.id}`}>
                        {t(MSG.SIGN_IN_LINK)}
                        <input
                          id={`${prefix}-link-${key.id}`}
                          value={householdSignInLink(user.login, token)}
                          readOnly
                          autoComplete="off"
                          onFocus={(event) => event.currentTarget.select()}
                        />
                      </label>
                    )}
                    <p className="help">{t(MSG.SHARE_DEVICE_KEY_PRIVATELY)}</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {removal && (
        <div className="saved-summary">
          <p>{t(removal.type === 'user' ? MSG.REVOKE_HOUSEHOLD_CONFIRM : MSG.REVOKE_DEVICE_KEY_CONFIRM, [removal.name])}</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={confirmRemoval}>{t(MSG.YES)}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setRemoval(undefined)}>{t(MSG.CANCEL)}</button>
          </div>
        </div>
      )}
      {alert}
      {!keys && !error && <p className="help" role="status">{t(MSG.LOADING_LIST)}</p>}
    </section>
  );
}
