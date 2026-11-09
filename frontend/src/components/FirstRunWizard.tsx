import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { HomeApi } from '../home-api';
import { MSG, t } from '../i18n';
import welcomeHome from '../assets/welcome-home.svg';

export type SetupStep = 'welcome' | 'access' | 'tuya' | 'devices';

const steps = [
  ['welcome', MSG.SETUP_WELCOME],
  ['access', MSG.SERVICE_ACCESS],
  ['tuya', MSG.TUYA_CONNECTION],
  ['devices', MSG.SETUP_DEVICES],
] as const;

export function setupStep(requested: string | null, hasAccess: boolean, connected: boolean): SetupStep {
  if (requested === 'devices' && connected) return 'devices';
  if (requested === 'tuya' || requested === 'devices') return hasAccess ? 'tuya' : 'access';
  return requested === 'access' ? 'access' : 'welcome';
}

function InitializeKey({
  api, busy, hasAccess, initialize,
}: {
  api: HomeApi; busy: boolean; hasAccess: boolean; initialize: (code: string) => Promise<string>;
}) {
  const codeId = useId();
  const keyId = useId();
  const [available, setAvailable] = useState(false);
  const [code, setCode] = useState('');
  const [key, setKey] = useState('');

  useEffect(() => {
    if (hasAccess) return undefined;
    const controller = new AbortController();
    api.setupAvailability(controller.signal).then((result) => {
      if (!controller.signal.aborted) setAvailable(result.can_initialize);
    }).catch(() => {});
    return () => controller.abort();
  }, [api, hasAccess]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const generated = await initialize(code);
    if (generated) {
      setCode('');
      setKey(generated);
    }
  }

  if (key) {
    return (
      <label className="setup-created-key" htmlFor={keyId}>
        <span>{t(MSG.SETUP_KEEP_NEW_KEY)}</span>
        <input id={keyId} value={key} readOnly onFocus={(event) => event.currentTarget.select()} />
      </label>
    );
  }
  if (hasAccess || !available) return null;
  return (
    <form className="setup-initialize" onSubmit={submit}>
      <p>{t(MSG.SETUP_INITIALIZE_DESCRIPTION)}</p>
      <label htmlFor={codeId}>
        <span>{t(MSG.SETUP_CODE)}</span>
        <input
          id={codeId}
          type="password"
          autoComplete="off"
          required
          disabled={busy}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <button type="submit" className="secondary" disabled={busy}>{t(MSG.SETUP_INITIALIZE_KEY)}</button>
    </form>
  );
}

type Props = {
  step: SetupStep;
  busy: boolean;
  hasAccess: boolean;
  connected: boolean;
  api: HomeApi;
  access: ReactNode;
  tuya: ReactNode;
  devices: ReactNode;
  initialize: (code: string) => Promise<string>;
  go: (step: SetupStep) => void;
  finish: () => void;
};

export default function FirstRunWizard(props: Props) {
  const {
    step, busy, hasAccess, connected, api, access, tuya, devices, initialize, go, finish,
  } = props;
  const index = steps.findIndex(([id]) => id === step);
  const back = steps[index - 1]?.[0];

  return (
    <section className="setup-wizard" aria-labelledby="setup-heading">
      <ol className="connection-steps" aria-label={t(MSG.SETUP_STEPS)}>
        {steps.map(([id, label], position) => (
          <li key={id} aria-current={step === id ? 'step' : undefined}>
            <span>{position + 1}</span>
            {t(label)}
          </li>
        ))}
      </ol>
      <div className="card setup-wizard-body">
        <h1 id="setup-heading">{t(steps[index][1])}</h1>
        {step === 'welcome' && (
          <>
            <img
              className="setup-welcome-picture"
              src={welcomeHome}
              alt=""
              width="420"
              height="230"
            />
            <p>{t(MSG.SETUP_WELCOME_DESCRIPTION)}</p>
          </>
        )}
        {step === 'access' && (
          <>
            {access}
            <InitializeKey api={api} busy={busy} hasAccess={hasAccess} initialize={initialize} />
          </>
        )}
        {step === 'tuya' && tuya}
        {step === 'devices' && (
          <>
            <p>{t(MSG.SETUP_DEVICES_DESCRIPTION)}</p>
            {devices}
          </>
        )}
        <div className="actions setup-wizard-actions">
          {back && (
            <button type="button" className="secondary" disabled={busy} onClick={() => go(back)}>{t(MSG.BACK)}</button>
          )}
          {step === 'welcome' && (
            <button type="button" onClick={() => go('access')}>{t(MSG.SETUP_GET_STARTED)}</button>
          )}
          {step === 'access' && (
            <button type="button" disabled={!hasAccess || busy} onClick={() => go('tuya')}>{t(MSG.NEXT)}</button>
          )}
          {step === 'tuya' && (
            <>
              <button type="button" className="secondary" disabled={busy} onClick={finish}>{t(MSG.SETUP_CONTINUE_LOCALLY)}</button>
              <button type="button" disabled={!connected || busy} onClick={() => go('devices')}>{t(MSG.NEXT)}</button>
            </>
          )}
          {step === 'devices' && (
            <button type="button" disabled={busy} onClick={finish}>{t(MSG.SETUP_OPEN_DASHBOARD)}</button>
          )}
        </div>
      </div>
    </section>
  );
}
