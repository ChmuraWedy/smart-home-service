import { MSG, t } from '../i18n';
import type { LocalCamera } from '../camera-service-api';
import type { GridCardPlacement } from './DashboardGrid';
import { CardDetailsButton, DashboardCardHeader } from './DashboardCardHeader';
import DashboardCardFooter from './DashboardCardFooter';
import { DeviceIcon } from './DevicePresentation';
import { Card } from './ui/card';

export const localCameraCardId = (id:string) => `device-native-camera:${id}`;

export default function LocalCameraCard({
  camera, room, placement, paused, onOpen,
}:{
  camera:LocalCamera;room:string;placement:GridCardPlacement;paused:boolean;onOpen:()=>void;
}) {
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
        <button type="button" className="secondary" disabled={paused} onClick={onOpen}>{t(MSG.WATCH_VIDEO)}</button>
      </DashboardCardFooter>
    </Card>
  );
}
