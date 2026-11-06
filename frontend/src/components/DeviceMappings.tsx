import { MSG, localizeMessages, t, translateText } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, CloudDevice, CloudFunction, CloudFunctions, DeviceMapping, MappingInput, Provider } from '../api';
import { cloudLabel, labelFor } from '../controls';

const kinds = localizeMessages({ remote:MSG.REMOTE_SWITCH, zigbee_group:MSG.ZIGBEE_GROUP, multi_control:'Multi-control' });
const preferred = (specs:CloudFunction[]) => specs.find(s => /^(switch(?:_led|_[1-9][0-9]*)?|press|button_[1-9][0-9]*)$/.test(s.code))?.code || specs[0]?.code || '';
const title = (spec:CloudFunction) => t(MSG.DEVICE_EVENT_SUMMARY, [cloudLabel(spec), spec.code, spec.dp_id ? ' · DP '+spec.dp_id : spec.dp_ids?.length ? ' · DP '+spec.dp_ids.join(', ') : t(MSG.DP_NOT_SPECIFIED)]);

export function DeviceMappings({ api, device, provider, definitions, devices, disabled, onBusy, onAuthError }: {
  api:CloudApi; device:CloudDevice; provider:Provider; definitions:CloudFunctions; devices?:CloudDevice[]; disabled:boolean; onBusy:(value:boolean)=>void; onAuthError:()=>void;
}) {
  const currentSpecs = [...new Map([...(definitions.status_range || []),...definitions.functions].map(s => [s.code,s])).values()];
  const [reverse,setReverse] = useState(false), [peerRanges,setPeerRanges] = useState<CloudFunction[]>([]);
  const [entries,setEntries] = useState<DeviceMapping[]>([]), [choices,setChoices] = useState<CloudDevice[]>(devices || []);
  const [opened,setOpened] = useState(false), [loaded,setLoaded] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [kind,setKind] = useState<MappingInput['kind']>('remote'), [sourceCode,setSourceCode] = useState(preferred(currentSpecs));
  const [targetId,setTargetId] = useState(''), [targetCode,setTargetCode] = useState(''), [targetSpecs,setTargetSpecs] = useState<CloudFunction[]>([]);
  const [sourceDP,setSourceDP] = useState(''), [targetDP,setTargetDP] = useState('');
  const sourceSpecs = reverse ? [...new Map([...peerRanges,...targetSpecs].map(s => [s.code,s])).values()] : currentSpecs;
  const destinationSpecs = reverse ? definitions.functions : targetSpecs;
  const lock = useRef(false), alive = useRef(true);
  const loadedRef = useRef(false);
  const source = sourceSpecs.find(s => s.code === sourceCode), target = destinationSpecs.find(s => s.code === targetCode);
  const failure = (err:unknown) => { setError(err instanceof Error ? err.message : t(MSG.COULD_NOT_LOAD_MAPPINGS)); if (err instanceof ApiError && err.status === 401) onAuthError(); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusy(false); }; }, [onBusy]);
  useEffect(() => {
    if (!opened || loadedRef.current) return;
    const controller = new AbortController();
    setBusy(true); onBusy(true);
    void Promise.all([api.deviceMappings(device.id,provider,controller.signal), devices ? Promise.resolve(devices) : api.devices(provider)]).then(([list,inventory]) => {
      if (!controller.signal.aborted && alive.current) { loadedRef.current = true; setEntries(list.mappings); setChoices(inventory); setLoaded(true); }
    }).catch(err => { if (!controller.signal.aborted && alive.current) failure(err); }).finally(() => {
      if (!controller.signal.aborted && alive.current) { setBusy(false); onBusy(false); }
    });
    return () => { controller.abort(); setBusy(false); onBusy(false); };
  }, [opened,api,device.id,provider,devices,onBusy]);
  useEffect(() => {
    setTargetSpecs([]); setPeerRanges([]); setTargetCode(reverse ? preferred(definitions.functions) : ''); setTargetDP(''); setSourceDP('');
    setSourceCode(reverse ? '' : preferred(currentSpecs));
    if (!targetId) return;
    const controller = new AbortController();
    setBusy(true); onBusy(true); setError('');
    void api.deviceFunctions(targetId,provider,controller.signal).then(result => {
      if(result.device_id !== targetId || !Array.isArray(result.functions)) throw new Error(t(MSG.THE_SERVICE_RETURNED_UNEXPECTED_LINKED_DEVICE_DATA));
      if (!controller.signal.aborted && alive.current) {
        setTargetSpecs(result.functions); setPeerRanges(result.status_range || []);
        if(reverse) setSourceCode(preferred([...(result.status_range || []),...result.functions])); else setTargetCode(preferred(result.functions));
      }
    }).catch(err => { if (!controller.signal.aborted && alive.current) failure(err); }).finally(() => {
      if (!controller.signal.aborted && alive.current) { setBusy(false); onBusy(false); }
    });
    return () => controller.abort();
  }, [api,targetId,provider,onBusy,reverse]);

  async function mutate(action:()=>Promise<void>) {
    if (lock.current || busy || disabled) return;
    lock.current = true; setBusy(true); onBusy(true); setError('');
    try { await action(); }
    catch(err) { if (alive.current) failure(err); }
    finally { lock.current = false; if (alive.current) { setBusy(false); onBusy(false); } }
  }
  const toDP = (known:CloudFunction|undefined, text:string) => known?.dp_id ?? (text ? Number(text) : null);
  return <details className="cloud-properties device-mappings" onToggle={e => setOpened(e.currentTarget.open)}><summary>{t(MSG.MANUAL_MAPPINGS_IN_OUR_DATABASE)}</summary>
    <p className="help">{t(MSG.SMART_LIFE_BINDINGS_ARE_UNAVAILABLE_THROUGH_THIS_CONNECTION)}</p>
    <p className="help">{t(MSG.CURRENT_DEVICE) + " "}<code>{device.id}</code></p>
    {busy && <p role="status">{t(MSG.LOADING)}</p>}
    {error && <p role="alert" className="field-error">{translateText(error)}</p>}
    {loaded && <>
      {entries.length ? <ul className="mapping-list">{entries.map(entry => <li key={entry.id}>
        <div><strong>{kinds[entry.kind]}</strong><p>{choices.find(d => d.id === entry.source_device_id)?.name || t(MSG.SOURCE)} · <code>{entry.source_device_id}</code></p><p>{labelFor(entry.source_code)} · {entry.source_code}{entry.source_dp_id ? ' · DP '+entry.source_dp_id : ''} → {choices.find(d => d.id === entry.target_device_id)?.name || t(MSG.DEVICE)}</p>
          <p><code>{entry.target_device_id}</code> · {entry.target_code}{entry.target_dp_id ? ' · DP '+entry.target_dp_id : ''}</p><span className="help">{t(MSG.MANUAL_MAPPING_NOT_APPLIED_IN_TUYA)}</span></div>
        <button className="secondary compact" disabled={busy || disabled} onClick={() => void mutate(async () => { await api.deleteDeviceMapping(entry.source_device_id,provider,entry.id); if (alive.current) setEntries(v => v.filter(e => e.id !== entry.id)); })}>{t(MSG.DELETE_MAPPING)}</button>
      </li>)}</ul> : <p className="help">{t(MSG.NO_SAVED_MAPPINGS_YET)}</p>}
      <form aria-label={t(MSG.DEVICE_MAPPING)} onSubmit={e => { e.preventDefault(); if (!source || !target) return; void mutate(async () => {
        const entry = await api.saveDeviceMapping(reverse ? targetId : device.id,provider,{ kind, source_code:sourceCode, source_dp_id:toDP(source,sourceDP), target_device_id:reverse ? device.id : targetId, target_code:targetCode, target_dp_id:toDP(target,targetDP) });
        if (alive.current) setEntries(v => [...v,entry]);
      }); }}>
        <label>{t(MSG.LINK_TYPE)}<select value={kind} disabled={busy || disabled} onChange={e => setKind(e.target.value as MappingInput['kind'])}>{Object.entries(kinds).map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        <label>{t(MSG.DIRECTION)}<select value={reverse ? 'incoming' : 'outgoing'} disabled={busy || disabled} onChange={e => setReverse(e.target.value === 'incoming')}><option value="outgoing">{t(MSG.THIS_DEVICE_ANOTHER)}</option><option value="incoming">{t(MSG.ANOTHER_DEVICE_THIS_ONE)}</option></select></label>
        <label>{t(MSG.SOURCE_BUTTON_PARAMETER)}<select value={sourceCode} disabled={busy || disabled} onChange={e => { setSourceCode(e.target.value); setSourceDP(''); }}>{sourceSpecs.map(s => <option key={s.code} value={s.code}>{title(s)}</option>)}</select></label>
        <label>{t(MSG.SOURCE_DP)}<input type="number" min={1} max={255} step={1} value={source?.dp_id ?? sourceDP} disabled={busy || disabled || Boolean(source?.dp_id)} placeholder={t(MSG.UNKNOWN_YOU_CAN_ENTER_IT_MANUALLY)} onChange={e => setSourceDP(e.target.value)} /></label>
        <label>{reverse ? t(MSG.SOURCE_DEVICE) : t(MSG.TARGET_DEVICE)}<select required value={targetId} disabled={busy || disabled} onChange={e => setTargetId(e.target.value)}><option value="">{t(MSG.SELECT_A_DEVICE)}</option>{choices.filter(d => d.id !== device.id).map(d => <option key={d.id} value={d.id}>{d.name || t(MSG.DEVICE)} · {d.id}</option>)}</select></label>
        <label>{t(MSG.TARGET_BUTTON_PARAMETER)}<select required value={targetCode} disabled={busy || disabled || !destinationSpecs.length} onChange={e => { setTargetCode(e.target.value); setTargetDP(''); }}><option value="">{t(MSG.SELECT_A_PARAMETER)}</option>{destinationSpecs.map(s => <option key={s.code} value={s.code}>{title(s)}</option>)}</select></label>
        <label>{t(MSG.TARGET_DP)}<input type="number" min={1} max={255} step={1} value={target?.dp_id ?? targetDP} disabled={busy || disabled || Boolean(target?.dp_id)} placeholder={t(MSG.UNKNOWN_YOU_CAN_ENTER_IT_MANUALLY)} onChange={e => setTargetDP(e.target.value)} /></label>
        <button className="compact" disabled={busy || disabled || !source || !target} type="submit">{t(MSG.SAVE_MAPPING)}</button>
      </form>
    </>}
  </details>;
}
