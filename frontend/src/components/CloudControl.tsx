import useLocalCamera from '../use-local-camera';
import { localCameraOnline } from '../camera-status-cache';
import { sendCloudDeviceCommands } from '../cloud-device-cache';
import { MSG, dateLocale, t } from "../i18n";
import {
  useCallback, useId, useMemo, useState,
} from 'react';
import { CloudApi } from '../api';
import type { CloudDevice, CloudFunctions, JsonValue, Provider } from '../api';
import type { DeviceRoute } from '../devices';
import type { LocalDevice } from '../home-api';
import { cloudBatchCommands, cloudCommands, cloudReading, cloudSnapshotReading, cloudSpecs, displayReading, withChannelLabels } from '../controls';
import type { ControlSpec } from '../controls';
import { CapabilityField, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';
import { ChannelAliases } from './ChannelAliases';
import DeviceInformation from './DeviceInformation';
import { useAutomaticControls } from '../control-drafts';
import { cloudPendingScope } from '../pending-device-values';
import { usePendingPrivacyState } from '../use-pending-device-value';
import { DeviceAliases } from './DeviceAliases';
import DeviceTranslationEditor from './DeviceTranslationEditor';
import { translationFor, useDeviceText } from '../device-translations';
import { BatteryBadge, batteryFromSpecs, isBattery, isCamera } from './DevicePresentation';
import { DeviceActivity } from './DeviceActivity';
import { DeviceConnectionDescription, DeviceConnectionSummary } from './DeviceConnection';
import { hasLightEffectWizard } from './LightEffectWizard';
import { hasScheduleWizard } from './ScheduleWizard';
import { ChannelControl } from './ChannelControl';
import { InchingControl, SwitchTimers, switchTimerControls } from './SwitchTimers';
import type { ReactNode } from 'react';
import CameraViewer from './CameraViewer';
import { CameraSettings } from './CameraSettings';
import { CameraFormat } from './CameraFormat';
import { FieldInfo } from './FieldInfo';
import { cameraStorage, isStorageSetting, cameraPrivacyBlock } from '../camera-controls';
import { CameraArea } from './CameraArea';
import { useCloudDeviceSnapshot } from '../use-cloud-device-snapshot';
import { cloudAccountScope } from '../cloud-account-scope';
import { cacheDeviceMetadata, cloudMetadataKey, labelsFromCloudDefinitions, nextDeviceMetadataRevision } from '../device-metadata';
import { useAppDispatch, useAppSelector } from '../store';
import { Switch } from './ui/switch';

export function CloudControl({
  api, device, provider, room, displayName, localDevice, gateway, routes, closeLabel, onClose, onAuthError, roomEditor, localControl, roomPreview,
}: {
  api: CloudApi; device: CloudDevice; provider: Provider; room?: string; displayName?: string;
  localDevice?: LocalDevice; gateway?: LocalDevice; routes?: DeviceRoute[]; closeLabel?: string; onClose: () => void; onAuthError: () => void;
  roomEditor?: ReactNode;
  localControl?: ReactNode;
  roomPreview?: { enabled: boolean; available: boolean; toggle: (enabled: boolean) => void };
}) {
  const originalName = displayName || device.name || t(MSG.TUYA_DEVICE);
  const roomPreviewId = useId();
  const localize = useDeviceText();
  const localCamera = useLocalCamera(api, isCamera(device.category) ? device.id : '', onAuthError);
  const localCameraBound = Boolean(localCamera.camera?.controls_available);
  const cameraOnline = localCameraOnline(localCamera.camera);
  const localTransport = localCameraBound ? 'wifi' : localDevice?.transport;
  const [aliasBusy, setAliasBusy] = useState(false);
  const [labelBusy, setLabelBusy] = useState(false);
  const editingBusy = labelBusy || aliasBusy;
  const { snapshot, liveRequestAt, read } = useCloudDeviceSnapshot(api, device.id, provider);
  const dispatch = useAppDispatch();
  const labelKey = cloudMetadataKey(cloudAccountScope(api, provider), device.id);
  const labels = useAppSelector(state => state.deviceMetadata.channels[labelKey]?.value);
  const translations = useAppSelector((state) => state.deviceMetadata.devices[labelKey]?.translations?.value) ?? device.translations;
  const name = localize(originalName, translationFor(translations, 'name', originalName));
  const metadata = useMemo(() => ({value:null as CloudFunctions|null}),[read]);
  const load = useCallback(async (_refresh: boolean, signal?: AbortSignal) => {
    const cached = metadata.value;
    const revision = cached ? 0 : nextDeviceMetadataRevision();
    const [definitions] = await Promise.all([
      cached ?? api.deviceFunctions(device.id, provider, signal),
      read(true, signal),
    ]);
    if (definitions.device_id !== device.id || !Array.isArray(definitions.functions)) throw new Error(t(MSG.THE_SERVICE_RETURNED_UNEXPECTED_DEVICE_DATA));
    if (!signal?.aborted && !cached) {
      metadata.value = definitions;
      dispatch(cacheDeviceMetadata([{ key: labelKey, revision, channelLabels: labelsFromCloudDefinitions(definitions) }]));
    }
    return { definitions, metadata, fetchedAt: Date.now() };
  }, [api, device.id, provider, metadata, read, dispatch, labelKey]);
  type Data = Awaited<ReturnType<typeof load>>;
  const poll = useCallback(async (current:Data, signal:AbortSignal) => {
    await read(false, signal);
    return current;
  },[read]);
  const session = useControlSession<Data>(load, onAuthError, provider === 'sharing' && !editingBusy ? poll : undefined);
  const reportedAt = snapshot?.snapshot_received_at ? Date.parse(snapshot.snapshot_received_at) : NaN;
  const data = session.data?.metadata === metadata && snapshot
    ? { ...session.data, snapshot, fetchedAt: Number.isFinite(reportedAt) ? reportedAt : session.data.fetchedAt }
    : null;
  const now = useClock();
  const definitions = data ? labels ? withChannelLabels(data.definitions, labels) : data.definitions : null;
  const specs = data && definitions ? cloudSpecs(definitions, data.snapshot) : [];
  const camera = !api.isMember && isCamera(device.category);
  const storage = cameraStorage(data?.snapshot.status || {});
  const privacySpec = camera ? specs.find(spec => spec.key === 'basic_private') : undefined;
  const privacy = privacySpec?.writable && privacySpec.kind === 'boolean' ? privacySpec : undefined;
  const pendingScope = cloudPendingScope(api, provider, device.id);
  const privacyReading = data?.snapshot.status.basic_private;
  const privacyState = usePendingPrivacyState(pendingScope, !session.readOK || !data ? null : typeof privacyReading === 'boolean' ? privacyReading : privacySpec ? null : undefined);
  const privacyBlock = cameraPrivacyBlock(privacyState);
  const { countdowns, inching, channels } = switchTimerControls(camera ? [] : specs);
  const regularSpecs = camera ? [] : specs.filter((spec) => spec !== inching && !countdowns.includes(spec));
  const settings = regularSpecs.filter(spec => /^(relay_status(?:_[1-9][0-9]*)?|switch_backlight|switch_inching)$/.test(spec.key));
  const basic = regularSpecs.filter(spec => !spec.advanced && !hasLightEffectWizard(spec) && !settings.includes(spec) && !isBattery(spec.key)), schedules = regularSpecs.filter(hasScheduleWizard), effects = regularSpecs.filter(hasLightEffectWizard), advanced = regularSpecs.filter(spec => spec.advanced && !settings.includes(spec) && !hasScheduleWizard(spec) && !hasLightEffectWizard(spec));
  const ensureStorage = (spec:ControlSpec) => {if (camera && isStorageSetting(spec.key) && !(spec.key==='sd_format' ? storage.canFormat : storage.ready)) throw new Error(storage.label+t(MSG.COMMAND_UNAVAILABLE));};
  const sendValue = (spec:ControlSpec,value:JsonValue) => session.execute(async () => {
    ensureStorage(spec);
    const result = await dispatch(sendCloudDeviceCommands(api, device.id, provider, cloudCommands(spec, value, data!.definitions)));
    if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
    return { text: t(MSG.COMMAND_ACCEPTED_NOTICE) };
  });
  const drafts = useAutomaticControls(changes => session.execute(async () => {
    changes.forEach(change => ensureStorage(change.spec));
    const commands = cloudBatchCommands(changes.map(change => ({spec:change.spec,value:change.value!})), data!.definitions, data!.snapshot.status);
    const result = await dispatch(sendCloudDeviceCommands(api, device.id, provider, commands));
    if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
    return {text:t(MSG.COMMAND_ACCEPTED_NOTICE)};
  }), !session.busy && !editingBusy && session.readOK);
  const field = (spec: ControlSpec, headingActions?: ReactNode) => {
    const info = camera && spec.help;
    const helpIcon = info ? <FieldInfo label={spec.label} text={info} /> : undefined;
    const disabled = editingBusy || session.busy || !session.readOK || (localCameraBound && !data?.snapshot.online)
      || (camera && isStorageSetting(spec.key) && !(spec.key==='sd_format' ? storage.canFormat : storage.ready));
    if (camera && spec.key==='record_switch' && !storage.ready) return (
      <section className="capability camera-record-unavailable" key={spec.key} aria-label={spec.label}>
        <div className="capability-row">
          <div className="capability-heading">
            <div className="capability-label-line">
              <h3>{spec.label}</h3>{helpIcon}
            </div>
          </div>
          <span>{t(MSG.UNAVAILABLE)}</span>
        </div>
        <p className="help">{storage.label}. {data?.snapshot.status.record_switch===true ? t(MSG.THE_SAVED_RECORDING_SETTING_IS_ON_BUT_THIS) : t(MSG.RECORDING_BECOMES_AVAILABLE_AFTER_INSERTING_A_WORKING_MEMORY)}</p>
      </section>
    );
    if (camera && spec.key === 'sd_format' && spec.writable && spec.kind === 'boolean') return <CameraFormat key={spec.key} information={helpIcon} disabled={disabled} onFormat={()=>sendValue(spec,true)} />;
    const privacyButton = camera && spec.key === 'basic_private' && spec.writable && spec.kind === 'boolean';
    const reported = cloudSnapshotReading(spec, data!.snapshot);
    const reading = camera && spec.key === 'sd_status' ? { ...reported, value: storage.label } : { ...reported, liveRequestAt };
    return (
      <CapabilityField pendingScope={pendingScope}
        headingActions={info ? <>{headingActions}{helpIcon}</> : headingActions} key={spec.key} spec={info || privacyButton ? {...spec,help:undefined} : spec}
        valueEditor={camera && spec.key==='motion_area' && ['text','json'].includes(spec.kind) ? (value,change)=><CameraArea viewingBlocked={privacyBlock} value={value} onChange={change} disabled={disabled} api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} /> : undefined} stage={spec.kind === 'boolean' ? undefined : drafts.stage} immediatePower booleanButton={privacyButton} buttonText={privacyButton ? value=>value===null ? t(MSG.NO_DATA) : value ? t(MSG.ON_FEMININE) : t(MSG.OFF_FEMININE) : undefined} reading={reading} now={now} local={false}
        aliasEditor={!api.isMember && /^switch_[1-9][0-9]*$/.test(spec.key) ? <ChannelAliases api={api} deviceId={device.id} provider={provider} code={spec.key} alias={spec.aliases?.[0]} disabled={session.busy || aliasBusy || labelBusy} onBusy={setLabelBusy} onAuthError={onAuthError} /> : undefined} disabled={disabled} onSend={value=>sendValue(spec,value)}
      />
    );
  };
  const basicField = (spec: ControlSpec) => <ChannelControl key={spec.key} spec={spec} renderField={field} />;
  const inchingReading = inching && data ? {
    ...cloudSnapshotReading(inching, data.snapshot),
    liveRequestAt,
  } : undefined;
  const primaryActivity = specs.some(spec => spec.indicator === 'motion');
  const signal = specs.find(spec => ['wifi_signal','signal_strength','rssi'].includes(spec.key) && spec.readable && spec.kind === 'number');
  const networkSignal = signal && data ? displayReading(signal,cloudReading(signal,data.snapshot.status[signal.key])) : undefined;
  const cameraSettings = camera && (
    <CameraSettings
      specs={specs.filter(spec => !isBattery(spec.key) && spec !== privacy && !(localCameraBound && localCamera.camera?.lan.controls?.functions[spec.key]))}
      renderField={field}
    />
  );
  const connectionOnline = localCameraBound ? cameraOnline : data?.snapshot.online;
  let connectionStatus = t(MSG.CHECKING_CONNECTION);
  if (connectionOnline !== undefined) connectionStatus = t(connectionOnline ? MSG.ONLINE : MSG.OFFLINE);
  if (localCameraBound && connectionOnline) connectionStatus = t(MSG.AVAILABLE_LOCALLY);
  return (
    <ControlDialog onRefresh={session.refresh}
      readingAge={data && Number.isFinite(reportedAt) ? { at: reportedAt, now } : undefined}
      closeLabel={closeLabel}
      information={<DeviceConnectionDescription room={room} route={localCameraBound ? 'local' : provider} throughGateway={device.sub} localTransport={localTransport} />}
      statusContent={<BatteryBadge reading={data ? batteryFromSpecs(specs,data.snapshot.status) : device.battery} />} className={camera ? 'camera-controls' : device.category === 'dj' || specs.some(spec => spec.kind === 'color') ? 'bulb-controls' : ''} title={name} busy={session.busy || editingBusy} onClose={onClose}
      titleContent={<DeviceAliases api={api} deviceId={device.id} name={originalName} translations={translations} initialAliases={device.aliases} provider={provider} localId={localDevice?.id} disabled={session.busy || labelBusy} onBusy={setAliasBusy} onAuthError={onAuthError} />}
      connectionContent={(
        <DeviceConnectionSummary
          room={room}
          route={localCameraBound ? 'local' : provider}
          throughGateway={device.sub}
          localTransport={localTransport}
          status={connectionStatus}
          online={connectionOnline}
        />
      )}
    >
      {camera && (
      <CameraViewer fallbackLocalControl={localControl} key={device.id + provider} api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} networkSignal={networkSignal} viewingBlocked={privacyBlock}
        remoteHeadingActions={privacy && <div className="camera-header-privacy">{field(privacy)}</div>}
        headingActions={roomPreview && (
        <label htmlFor={roomPreviewId} className="camera-room-preview-setting" title={roomPreview.available ? undefined : t(MSG.COMBINED_SELECT_ROOM)}>
          <Switch
            id={roomPreviewId}
            checked={roomPreview.enabled}
            disabled={!roomPreview.available && !roomPreview.enabled}
            onChange={roomPreview.toggle}
          />
          <span>{t(MSG.SHOW_ROOM_PREVIEW)}</span>
        </label>
        )}
      />
)}
      {roomEditor}
      {!camera && localControl}
      <div className="control-toolbar">
        <span className={'presence' + (connectionOnline ? ' online' : '')}>{connectionStatus}</span>
      </div>
      {data && !data.snapshot.online && !localCameraBound && <p className="help" role="status">{t(MSG.CLOUD_OFFLINE_LAST_REPORTED)}</p>}
      <details className="status-details">
        <summary>{t(MSG.ABOUT_READINGS)}</summary>
        <p className="help">{specs.some(spec => spec.writable) ? t(MSG.CLOUD_STATE_SNAPSHOT) : t(MSG.LAST_KNOWN_CLOUD_STATE)}</p>
        {data && <p className="help">{t(MSG.SNAPSHOT_RECEIVED) + " "}{new Date(data.fetchedAt).toLocaleString(dateLocale())}</p>}
        {provider === 'sharing' && data && <p className="help">{data.snapshot.event_stream_connected ? t(MSG.DEVICE_REPORTS_ARE_CONNECTED) : t(MSG.NO_FRESH_REPORTS_YET_OR_THE_CONNECTION_IS)}</p>}
      </details>
      {data && !data.snapshot.online && !localCameraBound && <p className="saved-summary">{t(MSG.TUYA_REPORTS_THIS_DEVICE_OFFLINE)}</p>}
      {!api.isMember && primaryActivity && <DeviceActivity api={api} deviceId={device.id} provider={provider} specs={specs} primary onAuthError={onAuthError} />}
      {cameraSettings && (localCameraBound ? (
        <details className="additional-settings">
          <summary>{t(MSG.DEVICE_REMOTE_CONTROL)}</summary>
          {data && !data.snapshot.online && <p className="help">{t(MSG.CLOUD_OFFLINE_LAST_REPORTED)}</p>}
          {cameraSettings}
        </details>
      ) : cameraSettings)}
      {basic.length > 0 && <div className={"capability-grid" + (basic.every(spec => !spec.writable) ? " sensor-grid" : "")}>{basic.map(basicField)}</div>}
      <SwitchTimers
        countdowns={countdowns}
        renderCountdown={(spec) => field(spec)}
        inching={inching && (
        <InchingControl
          spec={inching}
          channels={channels}
          reading={inchingReading}
          pendingScope={pendingScope}
          disabled={session.busy || editingBusy || !session.readOK || !data?.snapshot.online}
          onSend={(value) => sendValue(inching, value)}
        />
        )}
      />
      {settings.length > 0 && (
      <details className="cloud-properties additional-settings">
        <summary>{t(MSG.ADDITIONAL_SETTINGS)}</summary>
        <div className="capability-grid">{settings.map(spec => field(spec))}</div>
      </details>
)}
      {schedules.length > 0 && (
      <section className="light-schedules" aria-label={t(MSG.LIGHTING_SCHEDULES)}>
        <h3>{t(MSG.LIGHTING_SCHEDULES)}</h3>
        <div className="capability-grid">{schedules.map(spec => field(spec))}</div>
      </section>
)}
      {effects.length > 0 && (
      <section className="light-schedules" aria-label={t(MSG.LIGHTING_EFFECTS)}>
        <h3>{t(MSG.LIGHTING_EFFECTS)}</h3>
        <div className="capability-grid">{effects.map(spec => field(spec))}</div>
      </section>
)}
      {advanced.length > 0 && (
      <details className="cloud-properties advanced-controls">
        <summary>{t(MSG.EFFECTS_AND_ADVANCED_CONTROLS)}</summary>
        <p className="help">{t(MSG.COMPOUND_COMMANDS_AND_MANUFACTURER_PARAMETERS_REQUIRE_VALUES_IN)}</p>
        <div className="capability-grid">{advanced.map(spec => field(spec))}</div>
      </details>
)}
      {data && !specs.length && <p className="empty-state">{t(MSG.THE_DEVICE_PROVIDED_NO_READINGS_OR_CONTROLS)}</p>}
      {!api.isMember && !primaryActivity && <DeviceActivity api={api} deviceId={device.id} provider={provider} specs={specs} onAuthError={onAuthError} />}
      {!api.isMember && (
      <DeviceTranslationEditor
        api={api}
        deviceId={device.id}
        originalName={originalName}
        initialAliases={device.aliases}
        translations={translations}
        provider={provider}
        localId={localDevice?.id}
        onAuthError={onAuthError}
      />
      )}
      {!api.isMember && (
      <DeviceInformation
        api={api}
        deviceId={device.id}
        displayName={name}
        route={provider}
        routes={routes ?? [provider]}
        local={localDevice}
        cloud={device}
        gateway={gateway}
        writable={data ? specs.some((spec) => spec.writable) : undefined}
        onAuthError={onAuthError}
      />
      )}
      {data && !api.isMember && (
      <details className="cloud-properties">
        <summary>{t(MSG.TECHNICAL_DATA_FOR_DEVICE_MAPPINGS)}</summary>
        <p className="help">{t(MSG.PARAMETER_CODES_AND_KNOWN_DP_NUMBERS_FOR_DEVICE)}</p>
        <ul>
          {[...data.definitions.functions,...(data.definitions.status_range || [])].filter((spec,index,all) => all.findIndex(s => s.code === spec.code) === index).map(spec => (
            <li key={spec.code}>
              <strong>{specs.find(control => control.key === spec.code)?.label || spec.code}</strong>{" · "}
              <code>{spec.code}</code> · {spec.type}{spec.dp_ids?.length ? ' · DP '+spec.dp_ids.join(', ') : spec.dp_id ? ' · DP '+spec.dp_id : ''}
            </li>
))}
        </ul>
      </details>
)}
      <ControlFeedback busy={session.busy} notice={session.notice} />
    </ControlDialog>
  );
}
