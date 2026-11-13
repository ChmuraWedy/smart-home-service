import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';
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
  const [privacy, setPrivacy] = useState<boolean|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (paused || !camera.controls_available) return undefined;
    let active = true;
    api.localCameraControls(camera.id).then((value) => {
      if (active) {
        setPrivacy(typeof value.state.basic_private === 'boolean' ? value.state.basic_private : null);
        setError('');
      }
    }).catch((failure) => {
      if (active) {
        setPrivacy(null);
        if (failure instanceof ApiError && failure.status === 401) onAuthError();
        setError(failure instanceof Error ? failure.message : t(MSG.CAMERA_CONNECTION_FAILED));
      }
    });
    return () => { active = false; };
  }, [api, camera.id, camera.controls_available, paused, onAuthError]);
  const togglePrivacy = useCallback(async () => {
    if (busy || typeof privacy !== 'boolean') return;
    setBusy(true); setError('');
    try {
      const value = await api.localCameraCommand(camera.id, 'basic_private', !privacy);
      setPrivacy(typeof value.state.basic_private === 'boolean' ? value.state.basic_private : null);
      if (value.confirmed === false) setError(t(MSG.CAMERA_LOCAL_UNCONFIRMED));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      setError(failure instanceof Error ? failure.message : t(MSG.CAMERA_CONNECTION_FAILED));
    } finally { setBusy(false); }
  }, [api, busy, camera.id, onAuthError, privacy]);
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
            <span className="help">{t(MSG.ON_YOUR_HOME_NETWORK)} · {camera.host}</span>
          </>
        )}
        actions={<CardDetailsButton label={t(MSG.DETAILS)} disabled={paused} onClick={onOpen} />}
      />
      <DashboardCardFooter>
        <CameraQuickActions
          disabled={paused}
          privacyDisabled={busy}
          privacy={privacy}
          onOpen={onOpen}
          onPrivacy={togglePrivacy}
        />
        {error && <p className="error" role="alert">{error}</p>}
      </DashboardCardFooter>
    </Card>
  );
}
