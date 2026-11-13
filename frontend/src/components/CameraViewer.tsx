import { useCallback, useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { ApiError } from '../api';
import type { CloudApi } from '../api';
import type { CameraControls, LocalCamera } from '../camera-service-api';
import { cameraPrivacyBlock } from '../camera-controls';
import { CameraLive } from './CameraLive';
import LocalCameraControls from './LocalCameraControls';

type Props = ComponentProps<typeof CameraLive> & { localCamera?:LocalCamera };
type Binding = {api:CloudApi;deviceId:string;row:LocalCamera|null};
type LocalState = {cameraId:string;data:CameraControls};

export default function CameraViewer({
  api, deviceId, provider, onAuthError, compact, sheet, autoStart, networkSignal, headingActions, overlay, viewingBlocked, localCamera,
}:Props) {
  const [binding, setBinding] = useState<Binding|null>(null);
  const [localState, setLocalState] = useState<LocalState|null>(null);
  const currentBinding = binding?.api === api && binding.deviceId === deviceId;
  const known = !api.isMember && localCamera?.connected && localCamera.controls_available ? localCamera : undefined;
  const camera = known ?? (currentBinding ? binding.row : undefined);
  const resolving = !api.isMember && !localCamera && !currentBinding;
  useEffect(() => {
    if (api.isMember || localCamera) return undefined;
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);
    api.localCameras(controller.signal).then((rows) => {
      if (!active) return;
      const match = Array.isArray(rows) ? rows.find((row) => row.connected && row.controls_available && row.device_id === deviceId) : undefined;
      setBinding({ api, deviceId, row: match ?? null });
    }).catch((error) => {
      if (!active) return;
      setBinding({ api, deviceId, row: null });
      if (error instanceof ApiError && error.status === 401) onAuthError();
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [api, deviceId, localCamera, onAuthError]);
  const cameraId = camera?.id;
  const updateState = useCallback((data:CameraControls) => {
    if (cameraId) setLocalState({ cameraId, data });
  }, [cameraId]);
  let privacy = viewingBlocked;
  if (resolving || camera) {
    const value = localState?.cameraId === cameraId ? localState?.data.state.basic_private : undefined;
    privacy = cameraPrivacyBlock(typeof value === 'boolean' ? value : null);
  }
  return (
    <div className="camera-viewer">
      <CameraLive
        api={api}
        deviceId={deviceId}
        provider={provider}
        onAuthError={onAuthError}
        compact={compact}
        sheet={sheet}
        autoStart={autoStart && !privacy}
        networkSignal={networkSignal}
        headingActions={headingActions}
        overlay={overlay}
        viewingBlocked={privacy}
      />
      {camera && (
        <LocalCameraControls
          key={camera.id}
          api={api}
          cameraId={camera.id}
          onAuthError={onAuthError}
          initialOpen
          onStateChange={updateState}
        />
      )}
    </div>
  );
}
