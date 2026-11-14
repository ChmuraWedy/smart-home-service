import { useCallback, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import useLocalCamera from '../use-local-camera';
import type { CameraControls, LocalCamera } from '../camera-service-api';
import { cameraPrivacyBlock } from '../camera-controls';
import { CameraLive } from './CameraLive';
import CameraAccessSection from './CameraAccessSection';

type Props = ComponentProps<typeof CameraLive> & { localCamera?:LocalCamera;fallbackLocalControl?:ReactNode;remoteHeadingActions?:ReactNode;extended?:boolean };
type LocalState = {cameraId:string;data:CameraControls};

export default function CameraViewer({
  api, deviceId, provider, onAuthError, compact, sheet, autoStart, networkSignal, headingActions, overlay, viewingBlocked,
  localCamera, fallbackLocalControl, remoteHeadingActions, extended = true,
}:Props) {
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
      {extended && !camera && !resolving && fallbackLocalControl}
      {extended && camera && (
        <CameraAccessSection
          key={camera.id}
          api={api}
          camera={camera}
          onAuthError={onAuthError}
          onStateChange={updateState}
        />
      )}
    </div>
  );
}
