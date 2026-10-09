import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CloudDevice, CloudFunctions, CloudSnapshot, JsonValue, Provider } from '../api';
import { cloudBatchCommands, cloudReading, cloudSpecs, localSpec, validateControlValue } from '../controls';
import type { ControlSpec } from '../controls';
import { useControlDrafts } from '../control-drafts';
import type { DeviceRoute, UnifiedDevice } from '../devices';
import type { DeviceState, HomeApi, Reading } from '../home-api';
import { CapabilityField, ControlApply, ControlFeedback, useControlSession } from './DeviceControls';
import { isBattery } from './DevicePresentation';

function mainControl(spec: ControlSpec) {
  return !isBattery(spec.key) && !spec.advanced && !/^(relay_status(?:_[1-9][0-9]*)?|switch_backlight|switch_inching)$/.test(spec.key) &&
    (spec.writable ? ['boolean','number','enum','color'].includes(spec.kind) : spec.readable && !['json','raw','color','unsupported'].includes(spec.kind));
}

type CardProps = { api: HomeApi; device: UnifiedDevice; route: DeviceRoute; state?: DeviceState; now: number; paused: boolean; onAuthError: () => void; onBusy: (busy: boolean) => void };

// Only cards entering the viewport request missing metadata. Keep an activated
// card mounted when it scrolls away so an unapplied draft is not discarded.
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
  return <div className="card-quick-controls" ref={container} role="group" aria-label={'Основные параметры: ' + props.device.name}>
    {active ? props.route === 'local' ? <LocalCardControls {...props} visible={visible && !props.paused} /> : cloud && <CloudCardControls {...props} cloud={cloud} provider={props.route} visible={visible && !props.paused} /> : <button className="secondary compact full-width" disabled={props.paused} onClick={() => setActivated(true)}>Показать параметры</button>}
  </div>;
}

function QuickFields({ specs, reading, now, local, busy, readOK, refresh, execute, send, onBusy, notice }: {
  specs: ControlSpec[]; reading: (spec: ControlSpec) => Reading | undefined; now: number; local: boolean; busy: boolean; readOK: boolean;
  refresh: () => Promise<void>; execute: (send: () => Promise<{text:string}>) => Promise<boolean | undefined>;
  send: (changes: {spec:ControlSpec;value:JsonValue}[]) => Promise<void>; onBusy: (busy:boolean) => void; notice: {text:string;error?:boolean};
}) {
  const drafts = useControlDrafts(), [sending,setSending] = useState(false);
  useEffect(() => { onBusy(sending); return () => onBusy(false); },[sending,onBusy]);
  async function apply() {
    if (sending) return;
    setSending(true);
    try { await drafts.apply(changes => execute(async () => {
      const values = changes.map(change => ({spec:change.spec,value:change.value!}));
      for (const change of values) validateControlValue(change.spec,change.value);
      await send(values);
      return {text:'Команда принята.'};
    })); } finally { setSending(false); }
  }
  const basic = specs.filter(mainControl);
  return <>
    <div className="card-control-toolbar"><button className="secondary card-refresh" aria-label="Обновить параметры" title="Обновить параметры" disabled={busy} onClick={() => void refresh()}>↻</button>{basic.some(spec => spec.writable) && <ControlApply count={drafts.count} invalid={drafts.invalid} disabled={busy || !readOK || sending} onApply={() => void apply()} />}</div>
    <div className="capability-grid">{basic.map(spec => <CapabilityField key={spec.key} spec={spec} reading={reading(spec)} stage={drafts.stage} now={now} local={local} disabled={busy || !readOK || sending} onSend={async () => false} aliasEditor={spec.aliases?.length ? <div className="capability-aliases"><span className="alias-row-label">Алиасы:</span>{spec.aliases.map(alias => <span className="alias-tag" key={alias}>{alias}</span>)}</div> : undefined} />)}</div>
    {!busy && readOK && !basic.length && <p className="help">Основных параметров нет. Подробности — в карточке устройства.</p>}
    {(busy || notice.text) && <ControlFeedback busy={busy} notice={notice} />}
  </>;
}

function CloudCardControls({api,cloud,provider,now,visible,onAuthError,onBusy}: CardProps & {cloud:CloudDevice;provider:Provider;visible:boolean}) {
  const metadata = useMemo(() => ({value:cloud.controls?.ready ? cloud.controls.definitions : null as CloudFunctions | null}),[api,cloud.id,provider]);
  const initial = useRef(cloud.controls?.snapshot);
  const checked = (snapshot:CloudSnapshot) => {
    if (snapshot.device_id !== cloud.id || !snapshot.status || typeof snapshot.status !== 'object' || Array.isArray(snapshot.status)) throw new Error('Сервис вернул неожиданные данные устройства.');
    return snapshot;
  };
  const load = useCallback(async (refresh:boolean,signal?:AbortSignal) => {
    const definitions = metadata.value || await api.deviceFunctions(cloud.id,provider,signal);
    if (definitions.device_id !== cloud.id || !Array.isArray(definitions.functions)) throw new Error('Сервис вернул возможности другого устройства.');
    if (!signal?.aborted) metadata.value = definitions;
    const snapshot = !refresh && initial.current ? initial.current : await api.deviceSnapshot(cloud.id,provider,signal,refresh);
    return {definitions,snapshot:checked(snapshot)};
  },[api,cloud.id,provider,metadata]);
  const poll = useCallback(async (current:{definitions:CloudFunctions;snapshot:CloudSnapshot},signal:AbortSignal) => ({...current,snapshot:checked(await api.deviceSnapshot(cloud.id,provider,signal,false))}),[api,cloud.id,provider]);
  const session = useControlSession(load,onAuthError,provider === 'sharing' && visible ? poll : undefined);
  const specs = session.data ? cloudSpecs(session.data.definitions,session.data.snapshot) : [];
  return <QuickFields specs={specs} reading={spec => session.data ? cloudReading(spec,session.data.snapshot.status[spec.key],session.data.snapshot.status_observations?.[spec.key]) : undefined} now={now} local={false} busy={session.busy} readOK={session.readOK} refresh={session.refresh} execute={session.execute} notice={session.notice} onBusy={onBusy} send={async changes => {
    const data = session.data!;
    const result = await api.sendDeviceCommands(cloud.id,provider,cloudBatchCommands(changes,data.definitions,data.snapshot.status));
    if (result.acknowledged !== true) throw new Error('Сервис не подтвердил команду.');
  }} />;
}

function LocalCardControls({api,device,state,now,visible,onAuthError,onBusy}: CardProps & {visible:boolean}) {
  const item = device.local!;
  const initial = useRef(state);
  const load = useCallback(async (refresh:boolean,signal?:AbortSignal) => {
    const result = !refresh && initial.current ? initial.current : await api.state(item.id,refresh,signal);
    if (result.device_id !== item.id) throw new Error('Сервис вернул другое устройство.');
    return result;
  },[api,item.id]);
  const poll = useCallback(async (_current:DeviceState,signal:AbortSignal) => {
    const result = await api.state(item.id,false,signal);
    if (result.device_id !== item.id) throw new Error('Сервис вернул другое устройство.');
    return result;
  },[api,item.id]);
  const session = useControlSession(load,onAuthError,visible ? poll : undefined);
  const specs = Object.entries(item.capabilities).map(([key,cap]) => localSpec(key,cap));
  return <QuickFields specs={specs} reading={spec => session.data?.values[spec.key]} now={now} local busy={session.busy} readOK={session.readOK && !!session.data?.enabled} refresh={session.refresh} execute={session.execute} notice={session.notice} onBusy={onBusy} send={async changes => {
    const result = await api.setCapabilities(item.id,Object.fromEntries(changes.map(change => [change.spec.key,change.value])));
    if (result.acknowledged !== true) throw new Error('Сервис не подтвердил команду.');
  }} />;
}
