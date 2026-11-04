import { t } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CloudDevice, CloudFunctions, CloudSnapshot, JsonValue, Provider } from '../api';
import { cloudBatchCommands, cloudReading, cloudSpecs, displayReading, isStale, localSpec, validateControlValue } from '../controls';
import type { ControlSpec } from '../controls';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import type { DeviceState, HomeApi, Reading } from '../home-api';
import { CapabilityField, ControlFeedback, useControlSession } from './DeviceControls';
import { isBattery, isCamera, ParameterIcon } from './DevicePresentation';
import { ChannelControl } from './ChannelControl';
import { CAMERA_QUICK_LABELS } from '../camera-controls';

function powerControl(spec: ControlSpec) {
  return spec.writable && spec.kind === 'boolean' && /^(switch|switch_led|switch_[1-9][0-9]*)$/.test(spec.key);
}
function sensorReading(spec: ControlSpec) {
  return spec.readable && !spec.writable && !spec.advanced && !/^switch_mode/.test(spec.key) && !isBattery(spec.key) && ['number','boolean','enum','text'].includes(spec.kind);
}

type CardProps = { api: HomeApi; device: UnifiedDevice; route: DeviceRoute; state?: DeviceState; now: number; paused: boolean; onAuthError: () => void; onBusy: (busy: boolean) => void; cameraAction?:ReactNode; onPrivacyStateChange?:(value:boolean | null | undefined)=>void };

// Only cards entering the viewport request missing metadata. Keep an activated
// card mounted when it scrolls away so an accepted target is not discarded.
export function CardControls(props: CardProps) {
  const container = useRef<HTMLDivElement>(null);
  const [activated, setActivated] = useState(false), [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!window.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => {
      const inView = entries.some(entry => entry.isIntersecting);
      setVisible(inView);
      if (inView && !props.paused) setActivated(true);
    });
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, [props.paused]);
  const cloud = props.route !== 'local' ? props.device.cloud[props.route] : undefined;
  const cached = props.route === 'local' || cloud?.controls?.ready;
  const active = activated || cached;
  return <div className={'card-quick-controls' + (isCamera(cloud?.category) ? ' camera-quick-controls' : '')} ref={container} role="group" aria-label={t("Основные параметры: ") + props.device.name}>
    {active ? props.route === 'local' ? <LocalCardControls {...props} visible={visible && !props.paused} /> : cloud && <CloudCardControls {...props} cloud={cloud} provider={props.route} visible={visible && !props.paused} /> : <><button className="secondary compact full-width" disabled={props.paused} onClick={() => setActivated(true)}>{t("Показать состояние")}</button>{props.cameraAction && <div className="camera-card-actions">{props.cameraAction}</div>}</>}
  </div>;
}

function QuickFields({ specs, reading, now, local, busy, readOK, refresh, execute, send, onBusy, notice, camera = false, cameraAction, onPrivacyStateChange }: {
  specs: ControlSpec[]; reading: (spec: ControlSpec) => Reading | undefined; now: number; local: boolean; busy: boolean; readOK: boolean;
  refresh: () => Promise<void>; execute: (send: () => Promise<{text:string}>) => Promise<boolean | undefined>;
  send: (changes: {spec:ControlSpec;value:JsonValue}[]) => Promise<void>; onBusy: (busy:boolean) => void; notice: {text:string;error?:boolean}; camera?: boolean; cameraAction?:ReactNode; onPrivacyStateChange?:(value:boolean | null | undefined)=>void;
}) {
  const [sending,setSending] = useState(false);
  useEffect(() => { onBusy(sending); return () => onBusy(false); },[sending,onBusy]);
  async function toggle(spec:ControlSpec,value:JsonValue) {
    if (sending) return false;
    setSending(true);
    try { return await execute(async () => {
      validateControlValue(spec,value);
      await send([{spec,value}]);
      return {text:t("Команда принята.")};
    }) === true; } finally { setSending(false); }
  }
  const powers = camera ? Object.entries(CAMERA_QUICK_LABELS).flatMap(([key,label]) => specs.filter(spec => spec.key === key && spec.kind === 'boolean' && spec.writable).map(spec => ({...spec,label,help:undefined}))) : specs.filter(powerControl), sensors = camera ? [] : specs.filter(sensorReading);
  const privacy=camera ? powers.find(spec=>spec.key==='basic_private') : undefined;
  useEffect(()=>{if (camera && readOK && !privacy) onPrivacyStateChange?.(undefined);},[camera,readOK,!!privacy,onPrivacyStateChange]);
  if (!busy && readOK && !powers.length && !sensors.length && !notice.error && !cameraAction) return null;
  const field = (spec:ControlSpec, headingActions?:ReactNode) => <CapabilityField headingActions={headingActions} key={spec.key} spec={spec} reading={reading(spec)} now={now} local={local} immediatePower booleanButton={camera && spec.key==='basic_private'} buttonText={camera && spec.key==='basic_private' ? t("Приватность") : undefined} onBooleanStateChange={camera && spec.key==='basic_private' ? onPrivacyStateChange : undefined} disabled={busy || !readOK || sending} onSend={value => toggle(spec,value)} aliasEditor={spec.aliases?.length ? <div className="capability-aliases">{spec.aliases.map(alias => <span className="alias-tag" key={alias}>{alias}</span>)}</div> : undefined} />;
  return <>
    <div className={"card-primary-controls" + (powers.length === 1 && /^(switch|switch_led)$/.test(powers[0].key) ? " single-power" : "")}>{powers.filter(spec=>spec!==privacy).map(spec => <ChannelControl key={spec.key} spec={spec} renderField={field} />)}
      {!!sensors.length && <div className="card-sensor-values">{sensors.map(spec => {
        const value = reading(spec), stale = !!value?.known && isStale(value,now,local);
        const label = spec.label + ': ' + displayReading(spec,value) + (stale ? t(" · Устарело") : '');
        return <span key={spec.key} className={'card-sensor-value' + (stale || !value?.known ? ' unknown' : '')} aria-label={label} title={label}><ParameterIcon code={spec.key} /><span>{displayReading(spec,value)}</span>{stale && <span className="sr-only">{t("Устарело")}</span>}</span>;
      })}</div>}
      <button className="secondary card-refresh" aria-label={t("Обновить параметры")} title={t("Обновить параметры")} disabled={busy || sending} onClick={() => void refresh()}>↻</button>
    </div>
    {camera && <div className="camera-card-actions">{privacy && <div className="camera-card-privacy">{field(privacy)}</div>}{cameraAction}</div>}
    {(busy || notice.error) && <ControlFeedback busy={busy} notice={notice} />}
  </>;
}

function CloudCardControls({api,cloud,provider,now,visible,onAuthError,onBusy,cameraAction,onPrivacyStateChange}: CardProps & {cloud:CloudDevice;provider:Provider;visible:boolean}) {
  const metadata = useMemo(() => ({value:cloud.controls?.ready ? cloud.controls.definitions : null as CloudFunctions | null}),[api,cloud.id,provider]);
  const initial = useRef(cloud.controls?.snapshot);
  const checked = (snapshot:CloudSnapshot) => {
    if (snapshot.device_id !== cloud.id || !snapshot.status || typeof snapshot.status !== 'object' || Array.isArray(snapshot.status)) throw new Error(t("Сервис вернул неожиданные данные устройства."));
    return snapshot;
  };
  const load = useCallback(async (refresh:boolean,signal?:AbortSignal) => {
    const definitions = metadata.value || await api.deviceFunctions(cloud.id,provider,signal);
    if (definitions.device_id !== cloud.id || !Array.isArray(definitions.functions)) throw new Error(t("Сервис вернул возможности другого устройства."));
    if (!signal?.aborted) metadata.value = definitions;
    const snapshot = !refresh && initial.current ? initial.current : await api.deviceSnapshot(cloud.id,provider,signal,refresh);
    return {definitions,snapshot:checked(snapshot)};
  },[api,cloud.id,provider,metadata]);
  const poll = useCallback(async (current:{definitions:CloudFunctions;snapshot:CloudSnapshot},signal:AbortSignal) => ({...current,snapshot:checked(await api.deviceSnapshot(cloud.id,provider,signal,false))}),[api,cloud.id,provider]);
  const session = useControlSession(load,onAuthError,provider === 'sharing' && visible ? poll : undefined);
  const specs = session.data ? cloudSpecs(session.data.definitions,session.data.snapshot) : [];
  return <QuickFields specs={specs} camera={isCamera(cloud.category)} cameraAction={cameraAction} onPrivacyStateChange={onPrivacyStateChange} reading={spec => session.data ? cloudReading(spec,session.data.snapshot.status[spec.key],session.data.snapshot.status_observations?.[spec.key]) : undefined} now={now} local={false} busy={session.busy} readOK={session.readOK} refresh={session.refresh} execute={session.execute} notice={session.notice} onBusy={onBusy} send={async changes => {
    const data = session.data!;
    const result = await api.sendDeviceCommands(cloud.id,provider,cloudBatchCommands(changes,data.definitions,data.snapshot.status));
    if (result.acknowledged !== true) throw new Error(t("Сервис не подтвердил команду."));
  }} />;
}

function LocalCardControls({api,device,state,now,visible,onAuthError,onBusy}: CardProps & {visible:boolean}) {
  const item = device.local!;
  const initial = useRef(state);
  const load = useCallback(async (refresh:boolean,signal?:AbortSignal) => {
    const result = !refresh && initial.current ? initial.current : await api.state(item.id,refresh,signal);
    if (result.device_id !== item.id) throw new Error(t("Сервис вернул другое устройство."));
    return result;
  },[api,item.id]);
  const poll = useCallback(async (_current:DeviceState,signal:AbortSignal) => {
    const result = await api.state(item.id,false,signal);
    if (result.device_id !== item.id) throw new Error(t("Сервис вернул другое устройство."));
    return result;
  },[api,item.id]);
  const session = useControlSession(load,onAuthError,visible ? poll : undefined);
  const specs = Object.entries(item.capabilities).map(([key,cap]) => localSpec(key,cap));
  return <QuickFields specs={specs} reading={spec => session.data?.values[spec.key]} now={now} local busy={session.busy} readOK={session.readOK && !!session.data?.enabled} refresh={session.refresh} execute={session.execute} notice={session.notice} onBusy={onBusy} send={async changes => {
    const result = await api.setCapabilities(item.id,Object.fromEntries(changes.map(change => [change.spec.key,change.value])));
    if (result.acknowledged !== true) throw new Error(t("Сервис не подтвердил команду."));
  }} />;
}
