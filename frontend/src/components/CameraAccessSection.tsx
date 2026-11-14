import { useCallback, useState } from 'react';
import type { CloudApi } from '../api';
import type { CameraControls, LocalCamera } from '../camera-service-api';
import DeviceLocalControl from './DeviceLocalControl';
import LocalCameraControls from './LocalCameraControls';

export default function CameraAccessSection({
  api, camera, onAuthError, onStateChange, currentState,
}:{
  api:CloudApi;camera:LocalCamera;onAuthError:()=>void;onStateChange:(value:CameraControls)=>void;currentState?:CameraControls;
}) {
  const [revision, setRevision] = useState(0);
  const activate = useCallback(async () => {
    const value = await api.activateLocalCamera(camera.id);
    onStateChange(value);
    setRevision((current) => current + 1);
  }, [api, camera.id, onStateChange]);
  return (
    <DeviceLocalControl
      api={api}
      deviceId={camera.id}
      route="native"
      onAuthError={onAuthError}
      onUseLocal={activate}
    >
      {camera.controls_available && (
        <LocalCameraControls
          key={`${camera.id}:${revision}`}
          api={api}
          cameraId={camera.id}
          onAuthError={onAuthError}
          initialOpen
          managed
          currentState={currentState}
          onStateChange={onStateChange}
        />
      )}
    </DeviceLocalControl>
  );
}
