import type { FormEvent } from 'react';
import { MSG, t } from '../i18n';
import type { RedroidCredentials } from '../api';

type Props = {
  available: boolean;
  protectedConnection: boolean;
  connected: boolean;
  ready: boolean;
  busy: boolean;
  approval: { remaining: number; imageUrl?: string; readyOnAndroid: boolean } | null;
  onConnect: (credentials?: RedroidCredentials) => Promise<void>;
  onConfirm: () => Promise<void>;
};

function secureSignInUrl() {
  const origin = import.meta.env.VITE_DASHBOARD_HTTPS_ORIGIN;
  if (!origin) return undefined;
  try {
    const url = new URL('/settings/connections?provider=android', origin);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function LoginForm({ busy, onConnect }: Pick<Props, 'busy' | 'onConnect'>) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const region = String(fields.get('region') ?? '').trim();
    const account = String(fields.get('account') ?? '').trim();
    const password = String(fields.get('password') ?? '');
    if (!region || !account || !password) return;
    (form.elements.namedItem('password') as HTMLInputElement).value = '';
    onConnect({ region, account, password });
  }

  return (
    <form method="post" onSubmit={submit}>
      <label htmlFor="redroid-region">
        {t(MSG.SMART_LIFE_COUNTRY_OR_REGION)}
        <input
          id="redroid-region"
          name="region"
          autoComplete="off"
          maxLength={120}
          required
          disabled={busy}
        />
      </label>
      <label htmlFor="redroid-account">
        {t(MSG.SMART_LIFE_EMAIL_OR_PHONE)}
        <input
          id="redroid-account"
          name="account"
          autoComplete="off"
          maxLength={254}
          required
          disabled={busy}
        />
      </label>
      <label htmlFor="redroid-password">
        {t(MSG.SMART_LIFE_PASSWORD)}
        <input
          id="redroid-password"
          name="password"
          type="password"
          autoComplete="off"
          maxLength={256}
          required
          disabled={busy}
        />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy}>{t(MSG.CONNECT_THROUGH_ANDROID)}</button>
      </div>
    </form>
  );
}

export default function RedroidConnection({
  available, protectedConnection, connected, ready, busy, approval, onConnect, onConfirm,
}: Props) {
  if (!available) return <p className="help">{t(MSG.SMART_LIFE_ANDROID_NOT_CONFIGURED)}</p>;
  if (!ready) return <p className="help">{t(MSG.CLOUD_MODE_IS_DISABLED_ON_THE_SERVER)}</p>;
  if (approval) {
    const { remaining, imageUrl, readyOnAndroid } = approval;
    return (
      <div className="qr-panel">
        {readyOnAndroid && <p className="help">{t(MSG.APPROVE_DASHBOARD_ACCESS_ON_ANDROID, [remaining])}</p>}
        {imageUrl && <img src={imageUrl} alt={t(MSG.QR_CODE_FOR_TUYA_SIGN_IN)} />}
        {imageUrl && <p className="help">{t(MSG.SCAN_DASHBOARD_QR_ON_ANOTHER_DEVICE, [remaining])}</p>}
        <button type="button" className="full-width" disabled={busy || remaining === 0} onClick={onConfirm}>
          {t(readyOnAndroid ? MSG.APPROVE_IN_ANDROID_AND_CONNECT : MSG.I_CONFIRMED_SIGN_IN_IN_THE_APP)}
        </button>
      </div>
    );
  }
  const httpsUrl = protectedConnection ? undefined : secureSignInUrl();
  return (
    <>
      {connected && <p className="saved-summary">{t(MSG.SMART_LIFE_CONNECTED)}</p>}
      {protectedConnection && (
        <>
          <p className="muted">{t(MSG.SMART_LIFE_ANDROID_LOGIN_HELP)}</p>
          <LoginForm busy={busy} onConnect={onConnect} />
        </>
      )}
      <button className="secondary full-width" type="button" disabled={busy} onClick={() => onConnect()}>
        {t(MSG.USE_EXISTING_ANDROID_SESSION)}
      </button>
      {!protectedConnection && !connected && (
        <p className="help">{t(MSG.SMART_LIFE_SIGN_IN_REQUIRES_HTTPS)}</p>
      )}
      {httpsUrl && <a href={httpsUrl}>{t(MSG.OPEN_SECURE_SMART_LIFE_SIGN_IN)}</a>}
    </>
  );
}
