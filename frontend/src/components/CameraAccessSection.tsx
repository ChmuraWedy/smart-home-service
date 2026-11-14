import { useCallback, useState } from 'react';
import type { CloudApi, Provider } from '../api';
import { MSG, t } from '../i18n';
import type { CameraControls, LocalCamera } from '../camera-service-api';
import DeviceLocalControl from './DeviceLocalControl';
import LocalCameraControls from './LocalCameraControls';

export default function CameraAccessSection({
  api, camera, onAuthError, onStateChange, currentState, remoteControl,
}:{
  api:CloudApi;camera:LocalCamera;onAuthError:()=>void;onStateChange:(value:CameraControls)=>void;currentState?:CameraControls;
  remoteControl?:{deviceId:string;provider:Provider};
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
      deviceId={!camera.controls_available && remoteControl ? remoteControl.deviceId : camera.id}
      route={!camera.controls_available && remoteControl ? remoteControl.provider : 'native'}
      onAuthError={onAuthError}
      onUseLocal={activate}
    >
      {!camera.controls_available && <p className="help">{t(MSG.CAMERA_LOCAL_VIDEO_ONLY_HELP)}</p>}
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
