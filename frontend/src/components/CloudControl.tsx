import { MSG, dateLocale, t } from "../i18n";
import { useCallback, useMemo, useState } from 'react';
import { CloudApi } from '../api';
import type { CloudDevice, CloudFunctions, JsonValue, Provider } from '../api';
import { cloudBatchCommands, cloudCommands, cloudReading, cloudSpecs, displayReading, withChannelLabels } from '../controls';
import type { ControlSpec } from '../controls';
import { CapabilityField, ControlDialog, ControlFeedback, useClock, useControlSession } from './DeviceControls';
import { DeviceMappings } from './DeviceMappings';
import { ChannelAliases } from './ChannelAliases';
import { DeviceNetwork } from './DeviceNetwork';
import { useAutomaticControls } from '../control-drafts';
import { DeviceAliases } from './DeviceAliases';
import { BatteryBadge, batteryFromSpecs, isBattery, isCamera } from './DevicePresentation';
import { DeviceActivity } from './DeviceActivity';
import { connectionLabel, DeviceConnectionDescription, DeviceConnectionSummary } from './DeviceConnection';
import { hasLightEffectWizard } from './LightEffectWizard';
import { hasScheduleWizard } from './ScheduleWizard';
import { ChannelControl, channelTimer } from './ChannelControl';
import type { ReactNode } from 'react';
import { CameraLive } from './CameraLive';
import { CameraSettings } from './CameraSettings';
import { CameraFormat } from './CameraFormat';
import { FieldInfo } from './FieldInfo';
import { cameraStorage, isStorageSetting, cameraPrivacyBlock } from '../camera-controls';
import { CameraArea } from './CameraArea';
import { useCloudDeviceSnapshot } from '../use-cloud-device-snapshot';

export function CloudControl({ api, device, provider, devices, room, localTransport, onClose, onAuthError }: {
  api: CloudApi; device: CloudDevice; provider: Provider; devices?: CloudDevice[]; room?: string; localTransport?: 'wifi' | 'zigbee'; onClose: () => void; onAuthError: () => void;
}) {
  const [privacyState,setPrivacyState] = useState<boolean | null | undefined>();
  const [mappingBusy,setMappingBusy] = useState(false);
  const [aliasBusy, setAliasBusy] = useState(false);
  const [labelBusy, setLabelBusy] = useState(false), [labels, setLabels] = useState<Record<string, string> | null>(null);
  const editingBusy = mappingBusy || labelBusy || aliasBusy;
  const { snapshot, read } = useCloudDeviceSnapshot(api, device.id, provider);
  const metadata = useMemo(() => ({value:null as CloudFunctions|null}),[read]);
  const load = useCallback(async (_refresh: boolean, signal?: AbortSignal) => {
    const [definitions] = await Promise.all([
      metadata.value ?? api.deviceFunctions(device.id, provider, signal),
      read(true, signal),
    ]);
    if (definitions.device_id !== device.id || !Array.isArray(definitions.functions)) throw new Error(t(MSG.THE_SERVICE_RETURNED_UNEXPECTED_DEVICE_DATA));
    if (!signal?.aborted) metadata.value = definitions;
    return { definitions, metadata, fetchedAt: Date.now() };
  }, [api, device.id, provider,metadata,read]);
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
  const camera = isCamera(device.category);
  const storage = cameraStorage(data?.snapshot.status || {});
  const privacy = camera ? specs.find(spec=>spec.key==='basic_private' && spec.writable && spec.kind==='boolean') : undefined;
  const privacyBlock = cameraPrivacyBlock(privacyState === undefined ? (typeof data?.snapshot.status.basic_private === 'boolean' ? data.snapshot.status.basic_private : privacy ? null : undefined) : privacyState);
  const regularSpecs = camera ? [] : specs;
  const settings = regularSpecs.filter(spec => /^(relay_status(?:_[1-9][0-9]*)?|switch_backlight|switch_inching)$/.test(spec.key));
  const basic = regularSpecs.filter(spec => !spec.advanced && !hasLightEffectWizard(spec) && !settings.includes(spec) && !isBattery(spec.key)), schedules = regularSpecs.filter(hasScheduleWizard), effects = regularSpecs.filter(hasLightEffectWizard), advanced = regularSpecs.filter(spec => spec.advanced && !settings.includes(spec) && !hasScheduleWizard(spec) && !hasLightEffectWizard(spec));
  const ensureStorage = (spec:ControlSpec) => {if (camera && isStorageSetting(spec.key) && !(spec.key==='sd_format' ? storage.canFormat : storage.ready)) throw new Error(storage.label+t(MSG.COMMAND_UNAVAILABLE));};
  const sendValue = (spec:ControlSpec,value:JsonValue) => session.execute(async () => {
    ensureStorage(spec);
    const result = await api.sendDeviceCommands(device.id, provider, cloudCommands(spec, value, data!.definitions));
    if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
    return { text: t(MSG.COMMAND_ACCEPTED_NOTICE) };
  });
  const drafts = useAutomaticControls(changes => session.execute(async () => {
    changes.forEach(change => ensureStorage(change.spec));
    const commands = cloudBatchCommands(changes.map(change => ({spec:change.spec,value:change.value!})), data!.definitions, data!.snapshot.status);
    const result = await api.sendDeviceCommands(device.id, provider, commands);
    if (result.acknowledged !== true) throw new Error(t(MSG.THE_SERVICE_DID_NOT_ACKNOWLEDGE_THE_COMMAND));
    return {text:t(MSG.COMMAND_ACCEPTED_NOTICE)};
  }), !session.busy && !editingBusy && session.readOK);
  const field = (spec: ControlSpec, headingActions?: ReactNode) => {
    const info = camera && spec.help;
    const helpIcon = info ? <FieldInfo label={spec.label} text={info} /> : undefined;
    const disabled = editingBusy || session.busy || !session.readOK || (camera && isStorageSetting(spec.key) && !(spec.key==='sd_format' ? storage.canFormat : storage.ready));
    if (camera && spec.key==='record_switch' && !storage.ready) return <section className="capability camera-record-unavailable" key={spec.key} aria-label={spec.label}><div className="capability-row"><div className="capability-heading"><div className="capability-label-line"><h3>{spec.label}</h3>{helpIcon}</div></div><span>{t(MSG.UNAVAILABLE)}</span></div><p className="help">{storage.label}. {data?.snapshot.status.record_switch===true ? t(MSG.THE_SAVED_RECORDING_SETTING_IS_ON_BUT_THIS) : t(MSG.RECORDING_BECOMES_AVAILABLE_AFTER_INSERTING_A_WORKING_MEMORY)}</p></section>;
    if (camera && spec.key === 'sd_format' && spec.writable && spec.kind === 'boolean') return <CameraFormat key={spec.key} information={helpIcon} disabled={disabled} onFormat={()=>sendValue(spec,true)} />;
    const privacyButton = camera && spec.key === 'basic_private' && spec.writable && spec.kind === 'boolean';
    return <CapabilityField headingActions={info ? <>{headingActions}{helpIcon}</> : headingActions} key={spec.key} spec={info || privacyButton ? {...spec,help:undefined} : spec} valueEditor={camera && spec.key==='motion_area' && ['text','json'].includes(spec.kind) ? (value,change)=><CameraArea viewingBlocked={privacyBlock} value={value} onChange={change} disabled={disabled} api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} /> : undefined} stage={spec.kind === 'boolean' ? undefined : drafts.stage} immediatePower booleanButton={privacyButton} buttonText={privacyButton ? value=>value===null ? t(MSG.NO_DATA) : value ? t(MSG.ON_FEMININE) : t(MSG.OFF_FEMININE) : undefined} onBooleanStateChange={privacyButton ? setPrivacyState : undefined} reading={camera && spec.key==='sd_status' ? {...cloudReading(spec,data!.snapshot.status[spec.key],data!.snapshot.status_observations?.[spec.key]),value:storage.label} : cloudReading(spec, data!.snapshot.status[spec.key], data!.snapshot.status_observations?.[spec.key])} now={now} local={false} aliasEditor={/^switch_[1-9][0-9]*$/.test(spec.key) ? <ChannelAliases api={api} deviceId={device.id} provider={provider} code={spec.key} alias={spec.aliases?.[0]} disabled={session.busy || mappingBusy || aliasBusy || labelBusy} onBusy={setLabelBusy} onSaved={setLabels} onAuthError={onAuthError} /> : undefined} disabled={disabled} onSend={value=>sendValue(spec,value)} />;
  };
  const pairedTimers = new Set(basic.flatMap(spec => { const timer = channelTimer(spec,basic); return timer ? [timer.key] : []; }));
  const basicField = (spec:ControlSpec) => <ChannelControl key={spec.key} spec={spec} timer={channelTimer(spec,basic)} renderField={field} />;
  const primaryActivity = specs.some(spec => spec.indicator === 'motion');
  const signal = specs.find(spec => ['wifi_signal','signal_strength','rssi'].includes(spec.key) && spec.readable && spec.kind === 'number');
  const networkSignal = signal && data ? displayReading(signal,cloudReading(signal,data.snapshot.status[signal.key])) : undefined;
  return <ControlDialog onRefresh={session.refresh} information={<DeviceConnectionDescription room={room} route={provider} throughGateway={device.sub} localTransport={localTransport} />} statusContent={<BatteryBadge reading={data ? batteryFromSpecs(specs,data.snapshot.status) : device.battery} />} className={camera ? 'camera-controls' : device.category === 'dj' || specs.some(spec => spec.kind === 'color') ? 'bulb-controls' : ''} title={device.name || t(MSG.TUYA_DEVICE)} busy={session.busy || editingBusy} onClose={onClose} titleContent={<DeviceAliases api={api} deviceId={device.id} name={device.name} initialAliases={device.aliases} provider={provider} disabled={session.busy || mappingBusy || labelBusy} onBusy={setAliasBusy} onAuthError={onAuthError} />} connectionContent={<DeviceConnectionSummary room={room} route={provider} throughGateway={device.sub} localTransport={localTransport} status={data ? (data.snapshot.online ? t(MSG.ONLINE) : t(MSG.OFFLINE)) : t(MSG.CHECKING_CONNECTION)} online={data?.snapshot.online} />}>
    {camera && <CameraLive key={device.id + provider} api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} networkSignal={networkSignal} viewingBlocked={privacyBlock} headingActions={privacy ? <div className="camera-header-privacy">{field(privacy)}</div> : undefined} />}
    <div className="control-toolbar"><span className={'presence' + (data?.snapshot.online ? ' online' : '')}>{data ? (data.snapshot.online ? t(MSG.ONLINE) : t(MSG.OFFLINE)) : t(MSG.CHECKING_CONNECTION)}</span></div>
    <details className="status-details"><summary>{t(MSG.ABOUT_READINGS)}</summary>
    <p className="help">{specs.some(spec => spec.writable) ? t(MSG.CLOUD_STATE_SNAPSHOT) : t(MSG.LAST_KNOWN_CLOUD_STATE)}</p>
    {data && <p className="help">{t(MSG.SNAPSHOT_RECEIVED) + " "}{new Date(data.fetchedAt).toLocaleString(dateLocale())}</p>}
    {provider === 'sharing' && data && <p className="help">{data.snapshot.event_stream_connected ? t(MSG.DEVICE_REPORTS_ARE_CONNECTED) : t(MSG.NO_FRESH_REPORTS_YET_OR_THE_CONNECTION_IS)}</p>}
    </details>
    {data && !data.snapshot.online && <p className="saved-summary">{t(MSG.TUYA_REPORTS_THIS_DEVICE_OFFLINE)}</p>}
    {primaryActivity && <DeviceActivity api={api} deviceId={device.id} provider={provider} specs={specs} primary onAuthError={onAuthError} />}
    {camera && <CameraSettings specs={specs.filter(spec => !isBattery(spec.key) && spec!==privacy)} renderField={field} />}
    {basic.length > 0 && <div className={"capability-grid" + (basic.every(spec => !spec.writable) ? " sensor-grid" : "")}>{basic.filter(spec => !pairedTimers.has(spec.key)).map(basicField)}</div>}
    {settings.length > 0 && <details className="cloud-properties additional-settings"><summary>{t(MSG.ADDITIONAL_SETTINGS)}</summary><div className="capability-grid">{settings.map(spec => field(spec))}</div></details>}
    {schedules.length > 0 && <section className="light-schedules" aria-label={t(MSG.LIGHTING_SCHEDULES)}><h3>{t(MSG.LIGHTING_SCHEDULES)}</h3><div className="capability-grid">{schedules.map(spec => field(spec))}</div></section>}
    {effects.length > 0 && <section className="light-schedules" aria-label={t(MSG.LIGHTING_EFFECTS)}><h3>{t(MSG.LIGHTING_EFFECTS)}</h3><div className="capability-grid">{effects.map(spec => field(spec))}</div></section>}
    {advanced.length > 0 && <details className="cloud-properties advanced-controls"><summary>{t(MSG.EFFECTS_AND_ADVANCED_CONTROLS)}</summary>
      <p className="help">{t(MSG.COMPOUND_COMMANDS_AND_MANUFACTURER_PARAMETERS_REQUIRE_VALUES_IN)}</p>
      <div className="capability-grid">{advanced.map(spec => field(spec))}</div>
    </details>}
    {data && !specs.length && <p className="empty-state">{t(MSG.THE_DEVICE_PROVIDED_NO_READINGS_OR_CONTROLS)}</p>}
    {!primaryActivity && <DeviceActivity api={api} deviceId={device.id} provider={provider} specs={specs} onAuthError={onAuthError} />}
    <DeviceNetwork api={api} deviceId={device.id} provider={provider} onAuthError={onAuthError} />
    {data && <details className="cloud-properties"><summary>{t(MSG.DEVICE_PROPERTIES)}</summary><dl>
      <div><dt>{t(MSG.DEVICE_ID)}</dt><dd><code>{device.id}</code></dd></div>
      <div><dt>{t(MSG.TYPE)}</dt><dd>{isCamera(device.category) ? t(MSG.CAMERA) : device.category === 'pir' ? t(MSG.MOTION_SENSOR) : device.category === 'dj' ? t(MSG.LIGHT_BULB) : device.category || t(MSG.NOT_SPECIFIED)}</dd></div>
      <div><dt>{t(MSG.CONNECTION)}</dt><dd>{connectionLabel({route:provider,throughGateway:device.sub,localTransport})}</dd></div>
      <div><dt>{t(MSG.CONTROL)}</dt><dd>{data.definitions.functions.length ? t(MSG.VIA_TUYA) : t(MSG.READINGS_ONLY)}</dd></div>
    </dl></details>}
    {data && <details className="cloud-properties"><summary>{t(MSG.TECHNICAL_DATA_FOR_DEVICE_MAPPINGS)}</summary>
      <p className="help">{t(MSG.PARAMETER_CODES_AND_KNOWN_DP_NUMBERS_FOR_DEVICE)}</p>
      <ul>{[...data.definitions.functions,...(data.definitions.status_range || [])].filter((spec,index,all) => all.findIndex(s => s.code === spec.code) === index).map(spec => <li key={spec.code}><strong>{specs.find(control => control.key === spec.code)?.label || spec.code}</strong> · <code>{spec.code}</code> · {spec.type}{spec.dp_ids?.length ? ' · DP '+spec.dp_ids.join(', ') : spec.dp_id ? ' · DP '+spec.dp_id : ''}</li>)}</ul>
    {definitions && <DeviceMappings api={api} device={device} devices={devices} provider={provider} definitions={definitions} disabled={session.busy || labelBusy || aliasBusy} onBusy={setMappingBusy} onAuthError={onAuthError} />}
    </details>}
    <ControlFeedback busy={session.busy} notice={session.notice} />
  </ControlDialog>;
}
