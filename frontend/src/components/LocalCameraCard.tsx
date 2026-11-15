import { useCallback, useState } from 'react';
import { ApiError } from '../api';
import useLocalCamera from '../use-local-camera';
import { localCameraOnline } from '../camera-status-cache';
import type { CloudApi } from '../api';
import { MSG, t } from '../i18n';
import type { LocalCamera } from '../camera-service-api';
import type { GridCardPlacement } from './DashboardGrid';
import { CardDetailsButton, DashboardCardHeader } from './DashboardCardHeader';
import DashboardCardFooter from './DashboardCardFooter';
import CameraQuickActions from './CameraQuickActions';
import { DeviceIcon } from './DevicePresentation';
import { Card } from './ui/card';

export const localCameraCardId = (id:string) => `device-native-camera:${id}`;

export default function LocalCameraCard({
  api, camera, room, placement, paused, onOpen, onAuthError,
}:{
  api:CloudApi;onAuthError:()=>void;camera:LocalCamera;room:string;placement:GridCardPlacement;paused:boolean;onOpen:()=>void;
}) {
  const local = useLocalCamera(api, camera.id, onAuthError);
  const reportedPrivacy = local.camera?.lan.controls?.state.basic_private;
  const privacy = typeof reportedPrivacy === 'boolean' ? reportedPrivacy : null;
  const online = localCameraOnline(local.camera);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  let presence = t(MSG.CHECKING_CONNECTION);
  if (online !== undefined) presence = t(online ? MSG.AVAILABLE_LOCALLY : MSG.OFFLINE);
  const togglePrivacy = useCallback(async () => {
    if (busy || typeof privacy !== 'boolean') return;
    setBusy(true); setError('');
    try {
      const value = await local.command('basic_private', !privacy);
      if (value.confirmed === false) setError(t(MSG.CAMERA_LOCAL_UNCONFIRMED));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.CAMERA_CONNECTION_FAILED));
    } finally { setBusy(false); }
  }, [local, busy, onAuthError, privacy]);
  return (
    <Card
      id={localCameraCardId(camera.id)}
      className="device-card dashboard-device local-camera-card"
      aria-label={camera.name}
      data-layout-slot={placement.slot}
      data-layout-nudge={placement.nudge}
      style={placement.style}
      inert={placement.inert}
    >
      <DashboardCardHeader
        icon={<DeviceIcon category="sp" codes={[]} />}
        title={<button type="button" className="device-card-details-trigger" disabled={paused} onClick={onOpen}>{camera.name}</button>}
        metadata={(
          <>
            <p className="device-location">{room}</p>
            <span className={online ? 'presence online' : 'presence'}>{presence}</span>
          </>
        )}
        actions={<CardDetailsButton label={t(MSG.DETAILS)} disabled={paused} onClick={onOpen} />}
      />
      <DashboardCardFooter>
        <CameraQuickActions
          disabled={paused}
          privacyDisabled={busy || online !== true}
          privacy={privacy}
          onOpen={onOpen}
          onPrivacy={togglePrivacy}
        />
        {error && <p className="error" role="alert">{error}</p>}
      </DashboardCardFooter>
    </Card>
  );
}
