import {
  useCallback, useEffect, useId, useState,
} from 'react';
import { ApiError } from '../api';
import type { CloudApi } from '../api';
import type { CameraControls } from '../camera-service-api';
import { CAMERA_LABELS, CAMERA_OPTIONS } from '../camera-controls';
import { MSG, t } from '../i18n';

export default function LocalCameraControls({
  api, cameraId, onAuthError, initialOpen = false, onStateChange,
}:{
  api:CloudApi;cameraId:string;onAuthError:()=>void;initialOpen?:boolean;onStateChange?:(state:CameraControls)=>void;
}) {
  const instance = useId();
  const [expanded, setExpanded] = useState(initialOpen);
  const [data, setData] = useState<CameraControls|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (action:()=>Promise<CameraControls>) => {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      setData(result);
      onStateChange?.(result);
      if (result.confirmed === false) setError(t(MSG.CAMERA_LOCAL_UNCONFIRMED));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.CAMERA_CONNECTION_FAILED));
    } finally { setBusy(false); }
  }, [onAuthError, onStateChange]);
  useEffect(() => {
    if (expanded) run(() => api.localCameraControls(cameraId));
  }, [expanded, api, cameraId, run]);
  const labels:Record<string, string> = {
    ...CAMERA_LABELS,
    motion_tracking: t(MSG.CAMERA_MOTION_TRACKING),
    ipc_auto_siren: t(MSG.CAMERA_AUTO_SIREN),
    ipc_siren_duration: t(MSG.CAMERA_SIREN_DURATION),
  };
  const privateMode = data?.state.basic_private !== false;
  return (
    <details
      className="local-camera-controls"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{t(MSG.CAMERA_LOCAL_CONTROLS)}</summary>
      <p className="help">{t(MSG.CAMERA_LOCAL_CONTROLS_DESCRIPTION)}</p>
      <button type="button" className="secondary compact" disabled={busy} onClick={() => run(() => api.localCameraControls(cameraId))}>{t(MSG.REFRESH_CONTROLS)}</button>
      {data && (
        <>
          <p role="status" className="help">{t(MSG.CAMERA_LAN_UPDATED, [new Date(data.observed_at * 1000).toLocaleTimeString()])}</p>
          {data.functions.ptz_control && data.functions.ptz_stop && (
            <div className="camera-ptz" role="group" aria-label={t(MSG.CAMERA_MOVEMENT)}>
              {([
                ['up', '↑', MSG.CAMERA_MOVE_UP], ['left', '←', MSG.CAMERA_MOVE_LEFT],
                ['right', '→', MSG.CAMERA_MOVE_RIGHT], ['down', '↓', MSG.CAMERA_MOVE_DOWN],
              ] as const).map(([direction, glyph, label]) => (
                <button
                  key={direction}
                  type="button"
                  className={`secondary camera-ptz-${direction}`}
                  aria-label={t(label)}
                  disabled={busy || privateMode}
                  onClick={() => run(() => api.localCameraAction(cameraId, 'move', direction))}
                >{glyph}
                </button>
              ))}
              <button type="button" className="secondary camera-ptz-stop" onClick={() => run(() => api.localCameraAction(cameraId, 'stop'))}>{t(MSG.STOP)}</button>
            </div>
          )}
          <div className="camera-local-settings">
            {Object.entries(data.functions).filter(([code]) => !['ptz_control', 'ptz_stop', 'siren_switch'].includes(code)).map(([code, spec]) => {
              const value = data.state[code];
              const id = `camera-${instance}-${code}`;
              return (
                <label key={code} htmlFor={id}>
                  <span>{labels[code] || code}</span>
                  {spec.type === 'Boolean' && (
                    <input
                      id={id}
                      aria-label={labels[code] || code}
                      type="checkbox"
                      disabled={busy || typeof value !== 'boolean'}
                      checked={value === true}
                      onChange={(event) => run(() => api.localCameraCommand(cameraId, code, event.target.checked))}
                    />
                  )}
                  {spec.type === 'Enum' && (
                    <select
                      id={id}
                      aria-label={labels[code] || code}
                      disabled={busy || typeof value !== 'string'}
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) => run(() => api.localCameraCommand(cameraId, code, event.target.value))}
                    >
                      {typeof value !== 'string' && <option value="">—</option>}
                      {spec.values.range?.map((option) => <option key={option} value={option}>{CAMERA_OPTIONS[code]?.[option] || option}</option>)}
                    </select>
                  )}
                  {spec.type === 'Integer' && (
                    <input
                      key={String(value)}
                      id={id}
                      aria-label={labels[code] || code}
                      type="number"
                      disabled={busy}
                      defaultValue={typeof value === 'number' ? value : ''}
                      placeholder={t(MSG.NO_READING)}
                      min={spec.values.min}
                      max={spec.values.max}
                      step={spec.values.step}
                      onBlur={(event) => {
                        if (event.target.validity.valid && event.target.value !== '' && Number(event.target.value) !== value) {
                          run(() => api.localCameraCommand(cameraId, code, Number(event.target.value)));
                        }
                      }}
                    />
                  )}
                </label>
              );
            })}
          </div>
          {data.functions.siren_switch && (
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy || privateMode}
                onClick={() => run(() => api.localCameraAction(cameraId, 'siren'))}
              >{t(MSG.CAMERA_TEST_SIREN)}
              </button>
              <button type="button" className="secondary" onClick={() => run(() => api.localCameraCommand(cameraId, 'siren_switch', false))}>{t(MSG.CAMERA_STOP_SIREN)}</button>
            </div>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </details>
  );
}
