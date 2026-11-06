import { MSG, localizeMessages, t } from "../i18n";
import { useState } from 'react';
import type { DeveloperCredentials, Region } from '../api';

export const REGIONS: { value: Region; label: string }[] = localizeMessages([
  { value: 'eu', label: MSG.CENTRAL_EUROPE }, { value: 'eu-w', label: MSG.WESTERN_EUROPE },
  { value: 'us', label: MSG.WESTERN_AMERICA }, { value: 'us-e', label: MSG.EASTERN_AMERICA },
  { value: 'cn', label: MSG.CHINA }, { value: 'in', label: MSG.INDIA }, { value: 'sg', label: MSG.SINGAPORE },
]);

export function UserCodeForm({ busy, canCancel, onCancel, onSave }: {
  busy: boolean; canCancel: boolean; onCancel: () => void; onSave: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  return (
    <form id="user-code" onSubmit={event => { event.preventDefault(); void onSave(code); }}>
      <label>User Code
        <input type="password" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" maxLength={128} required disabled={busy} autoFocus={canCancel} />
      </label>
      <p className="help">{t(MSG.SMART_LIFE_TUYA_SMART_ME_SETTINGS_ACCOUNT_AND)}</p>
      <div className="actions">
        <button type="submit" disabled={busy}>{t(MSG.SAVE_USER_CODE)}</button>
        {canCancel && <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t(MSG.CANCEL_EDITING)}</button>}
      </div>
    </form>
  );
}

export function DeveloperForm({ region, busy, canCancel, onSave, onCancel }: {
  region?: Region; busy: boolean; canCancel: boolean;
  onSave: (credentials: DeveloperCredentials) => Promise<void>; onCancel: () => void;
}) {
  const [id, setID] = useState('');
  const [secret, setSecret] = useState('');
  const [selected, setSelected] = useState<Region>(region || 'eu');
  const [device, setDevice] = useState('');
  return (
    <form id="developer-form" onSubmit={event => {
    event.preventDefault(); void onSave({ access_id: id.trim(), access_secret: secret.trim(), region: selected, sample_device_id: device.trim() || null });
  }}
    >
      <label>Access ID
        <input type="password" autoComplete="off" value={id} onChange={event => setID(event.target.value)} required maxLength={256} disabled={busy} autoFocus={canCancel} />
      </label>
      <label>Access Secret
        <input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} required maxLength={256} disabled={busy} />
      </label>
      <label>{t(MSG.PROJECT_REGION)}
        <select value={selected} onChange={event => setSelected(event.target.value as Region)} disabled={busy}>
          {REGIONS.map(item => <option key={item.value} value={item.value}>{item.label} ({item.value})</option>)}
        </select>
      </label>
      <label>{"Device ID "}
        <span className="optional">{t(MSG.OPTIONAL)}</span>
        <input value={device} onChange={event => setDevice(event.target.value)} autoComplete="off" maxLength={128} disabled={busy} />
      </label>
      <p className="help">{t(MSG.WITH_A_DEVICE_ID_THE_ACCOUNT_OWNING_THAT)}</p>
      <div className="actions">
        <button type="submit" disabled={busy}>{t(MSG.SAVE_CREDENTIALS)}</button>
        {canCancel && <button className="secondary" type="button" disabled={busy} onClick={onCancel}>{t(MSG.CANCEL_EDITING)}</button>}
      </div>
    </form>
  );
}
