import { useEffect, useRef, useState } from 'react';
import type { Provider } from '../api';
import type { UnifiedDevice } from '../devices';
import { useDeviceDisplayName } from '../devices';
import type { HomeApi } from '../home-api';
import { MSG, t } from '../i18n';
import { deviceCardId } from '../device-links';
import { CardControls } from './CardControls';
import { CardDetailsButton, DashboardCardHeader } from './DashboardCardHeader';
import DashboardCardFooter from './DashboardCardFooter';
import type { GridCardPlacement } from './DashboardGrid';
import { DeviceIcon } from './DevicePresentation';
import { Card } from './ui/card';

export const cameraRoomCardId = (id: string) => `${deviceCardId(id)}:v`;

const ignoreBusy = () => undefined;

export default function CameraRoomCard({
  api, device, provider, now, placement, paused, onOpen, onAuthError,
}: {
  api: HomeApi;
  device: UnifiedDevice;
  provider: Provider;
  now: number;
  placement: GridCardPlacement;
  paused: boolean;
  onOpen: () => void;
  onAuthError: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(!window.IntersectionObserver);
  const [foreground, setForeground] = useState(!document.hidden);
  const name = useDeviceDisplayName()(device, device.id);
  const title = `${name} · ${t(MSG.CAMERA_VIDEO)}`;

  useEffect(() => {
    if (!ref.current || !window.IntersectionObserver) return undefined;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  return (
    <Card
      ref={ref}
      id={cameraRoomCardId(device.id)}
      className="device-card dashboard-device camera-room-card"
      aria-label={title}
      data-layout-slot={placement.slot}
      data-layout-nudge={placement.nudge}
      style={placement.style}
      inert={placement.inert}
    >
      <DashboardCardHeader
        title={title}
        icon={<DeviceIcon category={device.cloud[provider]?.category} codes={[]} />}
        metadata={null}
        actions={<CardDetailsButton label={t(MSG.DETAILS)} disabled={paused} onClick={onOpen} />}
      />
      <DashboardCardFooter>
        {visible && foreground && !paused ? (
          <CardControls
            api={api}
            device={device}
            displayName={name}
            route={provider}
            now={now}
            paused={false}
            previewOnly
            onAuthError={onAuthError}
            onBusy={ignoreBusy}
          />
        ) : <div className="camera-preview-placeholder" aria-hidden="true" />}
      </DashboardCardFooter>
    </Card>
  );
}
