import { useEffect, useState } from 'react';
import useLocalCamera from '../use-local-camera';
import { localCameraOnline } from '../camera-status-cache';
import { cloudSpecs, cloudReading } from '../controls';
import { ApiError } from '../api';
import { MSG, t } from '../i18n';
import type { JsonValue, Provider } from '../api';
import { CAMERA_QUICK_LABELS, cameraPrivacyBlock } from '../camera-controls';
import { usePendingDeviceValue, usePendingPrivacyState } from '../use-pending-device-value';
import type { ControlSpec } from '../controls';
import type { HomeApi, Reading } from '../home-api';
import CameraViewer from './CameraViewer';
import CameraQuickActions from './CameraQuickActions';
import { ChannelControl } from './ChannelControl';
import { DashboardSheet } from './DashboardSheet';
import type { DashboardSheetState } from './DashboardSheet';
import { CapabilityField, ControlFeedback } from './DeviceControls';
import type { ControlNotice } from './DeviceControls';
import { IconGlyph } from './ui/icon';

export function CameraCardControls({
  api, deviceId, name, pendingScope, provider, online, onAuthError, paused, sheet, embeddedQuick, previewOnly,
  specs: remoteSpecs, reading: remoteReading, now, busy: remoteBusy, readOK: remoteReadOK, sending: remoteSending,
  refresh: remoteRefresh, toggle: remoteToggle, notice, onStatus, onOpenQuick,
}: {
  api: HomeApi; deviceId: string; name: string; pendingScope: string; provider: Provider; online: boolean; onAuthError: () => void;
  paused: boolean; sheet?: DashboardSheetState; embeddedQuick?: boolean; previewOnly?: boolean;
  specs: ControlSpec[]; reading: (spec: ControlSpec) => Reading | undefined;
  now: number; busy: boolean; readOK: boolean; sending: boolean; refresh: () => Promise<void>;
  toggle: (spec: ControlSpec, value: JsonValue) => Promise<boolean>; notice: ControlNotice;
  onStatus?:(value:{online:boolean;transport?:'local'|'cloud';checking?:boolean})=>void;
  onOpenQuick?:(button:HTMLButtonElement)=>void;
}) {
  const local = useLocalCamera(api, deviceId, onAuthError);
  const bound = Boolean(local.camera?.controls_available);
  const lan = local.camera?.lan.controls;
  const reachable = localCameraOnline(local.camera);
  const available = bound ? reachable === true : online;
  const [localSending, setLocalSending] = useState(false);
  const [localError, setLocalError] = useState('');
  const [frameOpen, setFrameOpen] = useState(false);
  useEffect(() => {
    onStatus?.({ online: available, transport: bound ? 'local' : 'cloud', checking: bound && reachable === undefined });
  }, [onStatus, available, bound, reachable]);
  const specs = bound && lan ? cloudSpecs(
    { device_id: deviceId, functions: Object.entries(lan.functions).map(([code, spec]) => ({ code, type: spec.type, values: spec.values })) },
    {
      device_id: deviceId, online: available, source: 'lan', status: lan.state,
    },
  ) : remoteSpecs;
  const reading = (spec:ControlSpec) => (bound ? { ...cloudReading(spec, lan?.state[spec.key]), stale: !available } : remoteReading(spec));
  const busy = bound ? false : remoteBusy;
  const readOK = bound ? Boolean(lan && available) : remoteReadOK;
  const sending = bound ? localSending : remoteSending;
  async function localToggle(spec:ControlSpec, value:JsonValue) {
    if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') return false;
    setLocalSending(true); setLocalError('');
    try {
      await local.command(spec.key, value);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onAuthError();
      setLocalError(error instanceof Error ? error.message : t(MSG.CAMERA_CONNECTION_FAILED));
      return false;
    } finally { setLocalSending(false); }
  }
  const toggle = bound ? localToggle : remoteToggle;
  async function refresh() {
    if (!bound || !local.camera) { await remoteRefresh(); return; }
    try {
      local.publish(await api.localCameraControls(local.camera.id));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : t(MSG.CAMERA_CONNECTION_FAILED));
    }
  }
  const controls = Object.entries(CAMERA_QUICK_LABELS).flatMap(([key, label]) =>
    specs.filter(spec => spec.key === key && spec.kind === 'boolean' && spec.writable)
      .map(spec => ({ ...spec, label, help: undefined })));
  const privacy = controls.find(spec => spec.key === 'basic_private');
  const switches = controls.filter(spec => spec !== privacy && (!bound || spec.key !== 'siren_switch'));
  const disabled = paused || busy || !readOK || sending || !available;
  const privacySpec = specs.find(spec => spec.key === 'basic_private');
  const reportedPrivacy = privacySpec && reading(privacySpec);
  let privacyReading:boolean|null|undefined;
  if (privacySpec) privacyReading = reportedPrivacy?.known && typeof reportedPrivacy.value === 'boolean' ? reportedPrivacy.value : null;
  const privacyStatus = usePendingPrivacyState(pendingScope, privacyReading);
  const { begin } = usePendingDeviceValue(pendingScope, 'basic_private', reportedPrivacy);
  const viewingBlocked = cameraPrivacyBlock(readOK ? privacyStatus : null);

  function renderPlayer(privacyState?: boolean | null, changePrivacy?: () => void) {
    return (
      <CameraViewer
        api={api}
        deviceId={deviceId}
        provider={provider}
        onAuthError={onAuthError}
        compact
        sheet
        autoStart={readOK && available && !viewingBlocked}
        extended={false}
        movement={!previewOnly}
        localCamera={local.camera}
        viewingBlocked={viewingBlocked}
        headingActions={!bound && changePrivacy && (
          <button
            type="button"
            className="secondary"
            disabled={disabled || privacyState === null}
            onClick={changePrivacy}
          >
            {privacyState ? t(MSG.TURN_OFF_PRIVACY) : t(MSG.TURN_ON_PRIVACY)}
          </button>
        )}
      />
    );
  }

  function closeFrame() { sheet?.close(); setFrameOpen(false); }
  function openFrame(button:HTMLButtonElement) {
    if (onOpenQuick) onOpenQuick(button);
    else if (sheet?.show) sheet.show();
    else setFrameOpen(true);
  }
  let presence = t(available ? MSG.ONLINE : MSG.OFFLINE);
  if (bound) {
    presence = t(MSG.CHECKING_CONNECTION);
    if (reachable !== undefined) presence = t(available ? MSG.AVAILABLE_LOCALLY : MSG.OFFLINE);
  }

  function renderPreview(privacyState?: boolean | null, changePrivacy?: () => void) {
    if ((!sheet?.open && !frameOpen) || paused) return null;
    return (
      <DashboardSheet title={name} onClose={() => closeFrame()} returnFocus={sheet?.trigger}>
        <span className={'presence ' + (available ? 'online' : '')}>{presence}</span>
        {renderPlayer(privacyState, changePrivacy)}
        {notice.error && <ControlFeedback busy={false} notice={notice} />}
      </DashboardSheet>
    );
  }

  if (previewOnly) {
    return (
      <>
        {renderPlayer()}
        {notice.error && <ControlFeedback busy={false} notice={notice} />}
      </>
    );
  }
  if (!busy && readOK && !controls.length && !notice.error && !sheet?.open && !embeddedQuick) return null;

  const field = (spec: ControlSpec) => (
    <CapabilityField pendingScope={pendingScope} spec={spec} reading={reading(spec)} now={now} local={false}
      immediatePower dashboardSwitch disabled={disabled} onSend={value => toggle(spec, value)}
    />
);

  const changePrivacy = privacy ? async () => {
    const value = privacyStatus !== true;
    const accepted = begin(value);
    if (await toggle(privacy, value)) accepted();
  } : undefined;
  return (
    <>
      {embeddedQuick && !paused && renderPlayer()}
      <div className="card-primary-controls tw:grid tw:grid-cols-1">
        <CameraQuickActions
          disabled={paused}
          privacyDisabled={disabled}
          privacy={privacyStatus}
          onOpen={(button) => openFrame(button)}
          onPrivacy={changePrivacy}
        >
          {!!switches.length && (
            <div className="camera-card-switches">
              {switches.map(spec => <ChannelControl key={spec.key} spec={spec} renderField={field} />)}
            </div>
          )}
        </CameraQuickActions>
        {renderPreview(privacyStatus, changePrivacy)}
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
      {localError && <p className="error" role="alert">{localError}</p>}
      {(busy || notice.error) && <ControlFeedback busy={busy} notice={notice} />}
    </>
  );
}
