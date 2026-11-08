import { MSG, t } from '../i18n';
import type { JsonValue, Provider } from '../api';
import { CAMERA_QUICK_LABELS, cameraPrivacyBlock } from '../camera-controls';
import { usePendingPrivacyState } from '../use-pending-device-value';
import type { ControlSpec } from '../controls';
import type { HomeApi, Reading } from '../home-api';
import { CameraLive } from './CameraLive';
import { ChannelControl } from './ChannelControl';
import { DashboardSheet } from './DashboardSheet';
import type { DashboardSheetState } from './DashboardSheet';
import { CapabilityField, ControlFeedback } from './DeviceControls';
import type { ControlNotice } from './DeviceControls';
import { Icon, IconGlyph } from './ui/icon';

export function CameraCardControls({
  api, deviceId, name, pendingScope, provider, online, onAuthError, paused, sheet,
  specs, reading, now, busy, readOK, sending, refresh, toggle, notice,
}: {
  api: HomeApi; deviceId: string; name: string; pendingScope: string; provider: Provider; online: boolean; onAuthError: () => void;
  paused: boolean; sheet?: DashboardSheetState; specs: ControlSpec[]; reading: (spec: ControlSpec) => Reading | undefined;
  now: number; busy: boolean; readOK: boolean; sending: boolean; refresh: () => Promise<void>;
  toggle: (spec: ControlSpec, value: JsonValue) => Promise<boolean>; notice: ControlNotice;
}) {
  const controls = Object.entries(CAMERA_QUICK_LABELS).flatMap(([key, label]) =>
    specs.filter(spec => spec.key === key && spec.kind === 'boolean' && spec.writable)
      .map(spec => ({ ...spec, label, help: undefined })));
  const privacy = controls.find(spec => spec.key === 'basic_private');
  const switches = controls.filter(spec => spec !== privacy);
  const disabled = paused || busy || !readOK || sending || !online;

  function renderPreview(privacyState?: boolean | null, changePrivacy?: () => void) {
    if (!sheet?.open || paused) return null;
    return (
      <DashboardSheet title={name} onClose={sheet.close} returnFocus={sheet.trigger}>
        <span className={'presence ' + (online ? 'online' : '')}>{online ? t(MSG.ONLINE) : t(MSG.OFFLINE)}</span>
        <CameraLive api={api} deviceId={deviceId} provider={provider} onAuthError={onAuthError}
          compact sheet autoStart={readOK} viewingBlocked={cameraPrivacyBlock(readOK ? privacyStatus : null)}
          headingActions={changePrivacy && (
          <button type="button" className="secondary" disabled={disabled || privacyState === null}
            onClick={changePrivacy}
          >{privacyState ? t(MSG.TURN_OFF_PRIVACY) : t(MSG.TURN_ON_PRIVACY)}
          </button>
)}
        />
        {notice.error && <ControlFeedback busy={false} notice={notice} />}
      </DashboardSheet>
    );
  }

  const privacySpec = specs.find(spec => spec.key === 'basic_private');
  const reportedPrivacy = privacySpec && reading(privacySpec);
  const privacyReading = privacySpec ? reportedPrivacy?.known && typeof reportedPrivacy.value === 'boolean' ? reportedPrivacy.value : null : undefined;
  const privacyStatus = usePendingPrivacyState(pendingScope, privacyReading);
  if (!busy && readOK && !controls.length && !notice.error && !sheet?.open) return null;

  const field = (spec: ControlSpec) => (
    <CapabilityField pendingScope={pendingScope} spec={spec} reading={reading(spec)} now={now} local={false}
      immediatePower dashboardSwitch disabled={disabled} onSend={value => toggle(spec, value)}
    />
);

  return (
    <>
      <div className="card-primary-controls tw:grid tw:grid-cols-1">
        {privacy && (
        <div className="camera-card-privacy">
          <CapabilityField pendingScope={pendingScope} spec={privacy} reading={reading(privacy)} now={now} local={false} immediatePower booleanButton
            powerIcon={<Icon name="shield" className="parameter-icon" />}
            booleanActions={renderPreview} disabled={disabled} onSend={value => toggle(privacy, value)}
          />
        </div>
)}
        {!!switches.length && (
        <div className="camera-card-switches">
          {switches.map(spec => <ChannelControl key={spec.key} spec={spec} renderField={field} />)}
        </div>
)}
        <button
          type="button"
          className="secondary card-refresh"
          aria-label={t(MSG.REFRESH_CONTROLS)}
          title={t(MSG.REFRESH_CONTROLS)}
          disabled={paused || busy || sending}
          onClick={() => void refresh()}
        >
          <IconGlyph name="refresh" />
        </button>
      </div>
      {!privacy && renderPreview(privacyStatus)}
      {(busy || notice.error) && <ControlFeedback busy={busy} notice={notice} />}
    </>
  );
}
