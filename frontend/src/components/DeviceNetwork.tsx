import { MSG, dateLocale, t, translateText } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api';
import type { CloudApi, NetworkObservation, Provider } from '../api';

export function DeviceNetwork({ api, deviceId, provider, onAuthError, information }: {
  api: CloudApi; deviceId: string; provider: Provider | 'local'; onAuthError: () => void;
  information?: (network: NetworkObservation | null) => ReactNode;
}) {
  const [open, setOpen] = useState(false), [data, setData] = useState<NetworkObservation | null>(null);
  const [error, setError] = useState('');
  const auth = useRef(onAuthError);
  auth.current = onAuthError;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null); setError('');
    const poll = async () => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), 1000); return;
      }
      try {
        const result = await api.deviceNetworkObservation(deviceId, provider, controller.signal);
        if (result.device_id !== deviceId || !result.target_id || !Array.isArray(result.changes)) throw new Error(t(MSG.THE_SERVICE_RETURNED_UNEXPECTED_OBSERVATION_DATA));
        if (!controller.signal.aborted) { setData(result); setError(''); }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof ApiError && failure.status === 409 ? t(MSG.THIS_DEVICES_GATEWAY_IS_NOT_KNOWN_YET) : failure instanceof Error ? failure.message : t(MSG.COULD_NOT_START_OBSERVATION));
        if (failure instanceof ApiError && failure.status === 401) { auth.current(); return; }
        if (failure instanceof ApiError && failure.status === 409) return;
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, api, deviceId, provider]);
  return (
    <details className="cloud-properties device-network" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{t(information ? MSG.DEVICE_PROPERTIES : MSG.DEVICE_ON_YOUR_HOME_NETWORK)}</summary>
      {information?.(data)}
      <p className="help">{t(MSG.THE_SERVICE_CONTINUOUSLY_RECEIVES_TUYA_NETWORK_ANNOUNCEMENTS)}</p>
      <p className="help">{t(MSG.THE_SHARED_RECEIVER_ALSO_RUNS_WHILE_CARDS_ARE)}</p>
      {data && <p role="status">{data.listening ? t(MSG.LISTENING_FOR_ANNOUNCEMENTS_ON_YOUR_HOME_NETWORK) : !data.enabled ? t(MSG.GLOBAL_ANNOUNCEMENT_RECEPTION_IS_DISABLED_IN_THE_SERVICE) : data.failed_ports.length ? t(MSG.COULD_NOT_START_THE_ANNOUNCEMENT_RECEIVER) : t(MSG.STARTING_ANNOUNCEMENT_RECEIVER)}</p>}
      {data && (
      <>
        <dl>
          <div>
            <dt>{t(MSG.MONITORING)}</dt>
            <dd>{data.route === 'gateway' ? t(MSG.DEVICE_GATEWAY) : t(MSG.DEVICE_ITSELF)}{" · "}
              <code>{data.target_id}</code>
            </dd>
          </div>
          {!information && (
          <div>
            <dt>{t(MSG.CONFIGURED_IP)}</dt>
            <dd>{data.configured_ip || t(MSG.NOT_SET)}</dd>
          </div>
          )}
          {!information && (
          <div>
            <dt>{t(MSG.OBSERVED_IP)}</dt>
            <dd>{data.observed_ip || t(MSG.NO_ANNOUNCEMENTS_YET)}</dd>
          </div>
          )}
          <div>
            <dt>{t(MSG.LAST_ANNOUNCEMENT)}</dt>
            <dd>{data.last_seen ? new Date(data.last_seen).toLocaleString(dateLocale()) : t(MSG.NOT_YET)}</dd>
          </div>
          <div>
            <dt>{t(MSG.ANNOUNCEMENTS_RECEIVED)}</dt>
            <dd>{data.packets}</dd>
          </div>
        </dl>
        {data.configured_ip && data.observed_ip && data.configured_ip !== data.observed_ip && <p className="saved-summary">{t(MSG.THE_OBSERVED_IP_DIFFERS_FROM_THE_SAVED_CONFIGURATION)}</p>}
        {!!data.failed_ports.length && <p role="alert">{t(MSG.SOME_RECEPTION_IS_UNAVAILABLE_UDP) + " "}{data.failed_ports.join(', ')}{t(MSG.CHECK_WHETHER_ANOTHER_APPLICATION_IS_USING_THE_PORT)}</p>}
        {!!data.changes.length && (
        <>
          <h3>{t(MSG.RECENT_IP_CHANGES)}</h3>
          <ul>
            {data.changes.map((change, index) => <li key={index}>{new Date(change.at).toLocaleTimeString(dateLocale())} · {change.previous_ip ? change.previous_ip + ' → ' : t(MSG.DISCOVERED)}{change.ip}</li>)}
          </ul>
        </>
)}
      </>
)}
      {error && <p role="alert">{translateText(error)}</p>}
    </details>
  );
}
