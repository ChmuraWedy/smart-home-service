import { useCallback, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import useLocalCamera from '../use-local-camera';
import { localCameraOnline } from '../camera-status-cache';
import { ApiError } from '../api';
import { MSG, t } from '../i18n';
import CameraMovementControls from './CameraMovementControls';
import type { CameraControls, LocalCamera } from '../camera-service-api';
import { cameraPrivacyBlock } from '../camera-controls';
import { CameraLive } from './CameraLive';
import CameraAccessSection from './CameraAccessSection';

type Props = ComponentProps<typeof CameraLive> & { localCamera?:LocalCamera;fallbackLocalControl?:ReactNode;remoteHeadingActions?:ReactNode;extended?:boolean;movement?:boolean };
type LocalState = {cameraId:string;data:CameraControls};

export default function CameraViewer({
  api, deviceId, provider, onAuthError, compact, sheet, autoStart, networkSignal, headingActions, overlay, viewingBlocked,
  localCamera, fallbackLocalControl, remoteHeadingActions, extended = true, movement = false,
}:Props) {
  const [movementBusy, setMovementBusy] = useState(false);
  const [movementError, setMovementError] = useState('');
  const [localState, setLocalState] = useState<LocalState|null>(null);
  const local = useLocalCamera(api, localCamera?.id ?? deviceId.replace('local-camera:', ''), onAuthError);
  const camera = local.camera ?? (!api.isMember ? localCamera : undefined);
  const resolving = !api.isMember && !camera && local.loading;
  const cameraId = camera?.id;
  const { publish } = local;
  const updateState = useCallback((data:CameraControls) => {
    if (cameraId) { setLocalState({ cameraId, data }); publish(data); }
  }, [cameraId, publish]);
  let privacy = viewingBlocked;
  if (resolving || camera?.controls_available) {
    const current = localState && localState.cameraId === cameraId
      && localState.data.observed_at >= (local.camera?.lan.controls?.observed_at ?? 0);
    const data = current ? localState.data : local.camera?.lan.controls;
    const value = data?.state.basic_private;
    privacy = cameraPrivacyBlock(typeof value === 'boolean' ? value : null);
  }
  async function moveCamera(direction?:string) {
    if (!cameraId || (direction && movementBusy)) return;
    setMovementBusy(true); setMovementError('');
    try {
      const result = await api.localCameraAction(cameraId, direction ? 'move' : 'stop', direction);
      updateState(result);
      if (result.confirmed === false) setMovementError(t(MSG.CAMERA_LOCAL_UNCONFIRMED));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onAuthError();
      setMovementError(error instanceof Error ? error.message : t(MSG.CAMERA_CONNECTION_FAILED));
    } finally { setMovementBusy(false); }
  }
  const movementAvailable = !extended && movement && camera?.controls_available
    && local.camera?.lan.controls?.functions.ptz_control && local.camera.lan.controls.functions.ptz_stop;
  return (
    <div className="camera-viewer">
      <CameraLive
        api={api}
        deviceId={camera?.connected ? `local-camera:${camera.id}` : deviceId}
        provider={provider}
        onAuthError={onAuthError}
        compact={compact}
        sheet={sheet}
        autoStart={autoStart && !privacy}
        networkSignal={networkSignal}
        headingActions={<>{headingActions}{!camera?.controls_available && remoteHeadingActions}</>}
        overlay={overlay}
        viewingBlocked={privacy}
      />
      {movementAvailable && (
        <section className="camera-viewer-movement" aria-label={t(MSG.CAMERA_MOVEMENT)}>
          <h3>{t(MSG.CAMERA_MOVEMENT)}</h3>
          <CameraMovementControls
            disabled={movementBusy || !!privacy || localCameraOnline(local.camera) !== true}
            onMove={(direction) => moveCamera(direction)}
            onStop={() => moveCamera()}
          />
          {movementError && <p className="error" role="alert">{movementError}</p>}
        </section>
      )}
      {extended && !camera && !resolving && fallbackLocalControl}
      {extended && camera && (
        <CameraAccessSection
          key={camera.id}
          api={api}
          camera={camera}
          onAuthError={onAuthError}
          onStateChange={updateState}
          currentState={local.camera?.lan.controls}
        />
      )}
    </div>
  );
}
