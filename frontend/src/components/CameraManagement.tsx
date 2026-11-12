import { useId, useState } from 'react';
import type { FormEvent, SyntheticEvent } from 'react';
import { ApiError } from '../api';
import type { CloudDevice } from '../api';
import type { CameraServiceApi, LocalCamera } from '../camera-service-api';
import { MSG, t } from '../i18n';
import { CameraLive } from './CameraLive';

export default function CameraManagement({ api, onAuthError }:{api:CameraServiceApi;onAuthError:()=>void}) {
  const id = useId();
  const [rows, setRows] = useState<LocalCamera[]>([]);
  const [devices, setDevices] = useState<CloudDevice[]>([]);
  const [configured, setConfigured] = useState<boolean|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LocalCamera|null>(null);
  const [watch, setWatch] = useState<string|null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState('');
  const [transcode, setTranscode] = useState(true);
  async function run(action:()=>Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.CAMERA_CONNECTION_FAILED));
    } finally { setBusy(false); }
  }
  function load(scan = false) {
    run(async () => {
      const status = await api.cameraServiceStatus();
      setConfigured(status.configured);
      if (!status.configured) return;
      setRows(await (scan ? api.discoverCameras() : api.localCameras()));
      try {
        setDevices((await api.devices('sharing')).filter((device) => ['sp', 'dghsxj'].includes(device.category || '')));
      } catch { setDevices([]); }
    });
  }
  function open(event:SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open && configured === null) load();
    if (!event.currentTarget.open) setWatch(null);
  }
  function edit(row:LocalCamera) {
    setSelected(row);
    setDeviceId(devices.some((device) => device.id === row.device_id) ? row.device_id || '' : '');
    setUsername('');
    setPassword('');
    setProfile(row.profile || '');
  }
  function disconnect(row:LocalCamera) {
    setWatch(null);
    run(async () => {
      await api.disconnectLocalCamera(row.id);
      setRows(await api.localCameras());
    });
  }
  function cancel() {
    setSelected(null);
    setPassword('');
  }
  function submit(event:FormEvent) {
    event.preventDefault();
    if (!selected) return;
    run(async () => {
      await api.connectLocalCamera(selected.id, {
        ...(deviceId ? { device_id: deviceId } : {}),
        username,
        password,
        ...(profile ? { profile } : {}),
        transcode,
      });
      cancel();
      setRows(await api.localCameras());
    });
  }
  return (
    <details className="camera-management" onToggle={open}>
      <summary>{t(MSG.LOCAL_CAMERAS)}</summary>
      <p className="help">{t(MSG.LOCAL_CAMERAS_DESCRIPTION)}</p>
      {configured === false && <p role="status">{t(MSG.CAMERA_SERVICE_NOT_CONFIGURED)}</p>}
      {configured && (
        <>
          <button type="button" className="secondary compact" disabled={busy} onClick={() => load(true)}>{t(MSG.DISCOVER_CAMERAS)}</button>
          {!rows.length && !busy && <p>{t(MSG.NO_DISCOVERED_CAMERAS)}</p>}
          <ul className="camera-management-list">
            {rows.map((row) => (
              <li key={row.id}>
                <strong>{row.name}</strong>
                <p className="help">{row.host}{row.model ? ` · ${row.model}` : ''}{row.connected ? ` · ${t(MSG.CONNECTED)}` : ''}</p>
                <div className="actions">
                  {row.connected && (
                    <button type="button" className="secondary compact" onClick={() => setWatch(watch === row.id ? null : row.id)}>{t(MSG.WATCH_VIDEO)}</button>
                  )}
                  <button type="button" className="secondary compact" disabled={busy} onClick={() => edit(row)}>{t(MSG.CAMERA_CONNECT)}</button>
                  {row.connected && (
                    <button type="button" className="secondary compact" disabled={busy} onClick={() => disconnect(row)}>{t(MSG.CAMERA_DISCONNECT)}</button>
                  )}
                </div>
                {watch === row.id && (
                  <CameraLive
                    api={api}
                    deviceId={`local-camera:${row.id}`}
                    provider="sharing"
                    onAuthError={onAuthError}
                    autoStart
                    compact
                  />
                )}
              </li>
            ))}
          </ul>
          {selected && (
            <form className="camera-connection-form" onSubmit={submit}>
              <h3>{selected.name}</h3>
              <label htmlFor={`${id}-device`}>
                {t(MSG.CAMERA_DASHBOARD_DEVICE)}
                <select id={`${id}-device`} value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
                  <option value="">{t(MSG.CAMERA_STANDALONE)}</option>
                  {devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
                </select>
              </label>
              <label htmlFor={`${id}-username`}>
                {t(MSG.CAMERA_USERNAME)}
                <input id={`${id}-username`} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label htmlFor={`${id}-password`}>
                {t(MSG.CAMERA_PASSWORD)}
                <input
                  id={`${id}-password`}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {!!selected.profiles?.length && (
                <label htmlFor={`${id}-profile`}>
                  {t(MSG.CAMERA_PROFILE)}
                  <select id={`${id}-profile`} value={profile} onChange={(event) => setProfile(event.target.value)}>
                    <option value="">{t(MSG.AUTO)}</option>
                    {selected.profiles.map((item) => <option key={item.token} value={item.token}>{item.token}{item.codec ? ` · ${item.codec}` : ''}</option>)}
                  </select>
                </label>
              )}
              <label htmlFor={`${id}-transcode`}>
                <input id={`${id}-transcode`} type="checkbox" checked={transcode} onChange={(event) => setTranscode(event.target.checked)} />
                {t(MSG.CAMERA_BROWSER_COMPATIBILITY)}
              </label>
              <div className="actions">
                <button type="submit" disabled={busy}>{t(MSG.CAMERA_CONNECT)}</button>
                <button type="button" className="secondary" onClick={cancel}>{t(MSG.CANCEL)}</button>
              </div>
            </form>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </details>
  );
}
