import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api';
import type { CloudApi } from '../api';
import type { DeviceAccess } from '../device-access';
import { MSG, t } from '../i18n';

export default function DeviceLocalControl({
  api, deviceId, route, onAuthError, onUseLocal, children,
}:{
  api:CloudApi;deviceId:string;route:'local'|'sharing'|'developer'|'native';onAuthError:()=>void;
  onUseLocal?:()=>Promise<void>;children?:ReactNode;
}) {
  const [access, setAccess] = useState<DeviceAccess>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.deviceAccess(route, deviceId).then((value) => { if (active) setAccess(value); }).catch((failure) => {
      if (active && failure instanceof ApiError && failure.status === 401) onAuthError();
    });
    return () => { active = false; };
  }, [api, deviceId, route, onAuthError]);
  async function run(action:()=>Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    } finally { setBusy(false); }
  }
  async function setInternet() {
    const value = await api.deviceInternet(route, deviceId, !access?.internet?.blocked);
    setAccess((current) => current && ({ ...current, internet: value }));
  }
  const available = access?.internet?.available && access.internet.verified;
  let internetLabel = t(MSG.DEVICE_INTERNET_UNKNOWN);
  if (available) internetLabel = access.internet.blocked ? t(MSG.DEVICE_INTERNET_BLOCKED) : t(MSG.DEVICE_INTERNET_ALLOWED);
  return (
    <section className="device-local-control" aria-label={t(MSG.LOCAL_CONTROL)}>
      <h3>{t(MSG.LOCAL_CONTROL)}</h3>
      <dl className="device-access-info">
        <dt>{t(MSG.CONTROL)}</dt>
        <dd>{t(route === 'native' || route === 'local' ? MSG.LOCAL_CONTROL : MSG.DEVICE_REMOTE_CONTROL)}</dd>
        <dt>{t(MSG.CONFIGURED_IP)}</dt>
        <dd>{access?.host || t(MSG.NOT_SET)}</dd>
        {access?.mac && (
          <>
            <dt>{t(MSG.MAC_ADDRESS)}</dt>
            <dd>{access.mac}</dd>
          </>
        )}
        <dt>{t(MSG.DEVICE_INTERNET_ACCESS)}</dt>
        <dd>{internetLabel}</dd>
      </dl>
      <div className="device-access-actions">
        <button type="button" className="secondary" disabled={busy || !onUseLocal || !access?.local_available} onClick={() => onUseLocal && run(onUseLocal)}>
          {t(MSG.DEVICE_USE_LOCAL)}
        </button>
        <button type="button" className="secondary" disabled={busy || !available} onClick={() => run(setInternet)}>
          {access?.internet?.blocked ? t(MSG.DEVICE_RESTORE_INTERNET) : t(MSG.DEVICE_BLOCK_INTERNET)}
        </button>
      </div>
      <p className="help">{t(MSG.DEVICE_INTERNET_HELP)}</p>
      {!available && <p className="help">{t(MSG.DEVICE_INTERNET_UNAVAILABLE_HELP)}</p>}
      {access && !access.local_available && <p className="help">{t(MSG.DEVICE_LOCAL_SETUP_REQUIRED)}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {children}
    </section>
  );
}
