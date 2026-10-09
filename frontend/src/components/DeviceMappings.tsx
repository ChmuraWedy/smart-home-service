import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { CloudApi, CloudDevice, CloudFunction, CloudFunctions, DeviceMapping, MappingInput, Provider } from '../api';
import { cloudLabel, labelFor } from '../controls';

const kinds = { remote:'Пульт / выключатель', zigbee_group:'Группа Zigbee', multi_control:'Multi-control' };
const preferred = (specs:CloudFunction[]) => specs.find(s => /^(switch(?:_led|_[1-9][0-9]*)?|press|button_[1-9][0-9]*)$/.test(s.code))?.code || specs[0]?.code || '';
const title = (spec:CloudFunction) => `${cloudLabel(spec)} · ${spec.code}${spec.dp_id ? ' · DP '+spec.dp_id : spec.dp_ids?.length ? ' · DP '+spec.dp_ids.join(', ') : ' · DP не указан'}`;

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
  const failure = (err:unknown) => { setError(err instanceof Error ? err.message : 'Не удалось загрузить сопоставления.'); if (err instanceof ApiError && err.status === 401) onAuthError(); };
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
      if(result.device_id !== targetId || !Array.isArray(result.functions)) throw new Error('Сервис вернул неожиданные данные связанного устройства.');
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
  return <details className="cloud-properties device-mappings" onToggle={e => setOpened(e.currentTarget.open)}><summary>Связанные устройства и сопоставления</summary>
    <p className="help">Привязки из Smart Life недоступны через это подключение. Здесь можно сохранить свою карту: ID устройства и кнопка/DP. Запись хранится в сервисе; она не меняет настройки Tuya и не запускает автоматизацию.</p>
    <p className="help">Текущее устройство: <code>{device.id}</code></p>
    {busy && <p role="status">Загружаем…</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
    {loaded && <>
      {entries.length ? <ul className="mapping-list">{entries.map(entry => <li key={entry.id}>
        <div><strong>{kinds[entry.kind]}</strong><p>{choices.find(d => d.id === entry.source_device_id)?.name || 'Источник'} · <code>{entry.source_device_id}</code></p><p>{labelFor(entry.source_code)} · {entry.source_code}{entry.source_dp_id ? ' · DP '+entry.source_dp_id : ''} → {choices.find(d => d.id === entry.target_device_id)?.name || 'Устройство'}</p>
          <p><code>{entry.target_device_id}</code> · {entry.target_code}{entry.target_dp_id ? ' · DP '+entry.target_dp_id : ''}</p><span className="help">Ручное сопоставление · не применено в Tuya</span></div>
        <button className="secondary compact" disabled={busy || disabled} onClick={() => void mutate(async () => { await api.deleteDeviceMapping(entry.source_device_id,provider,entry.id); if (alive.current) setEntries(v => v.filter(e => e.id !== entry.id)); })}>Удалить сопоставление</button>
      </li>)}</ul> : <p className="help">Сохранённых сопоставлений пока нет. Список привязок в Smart Life неизвестен.</p>}
      <form aria-label="Сопоставление устройств" onSubmit={e => { e.preventDefault(); if (!source || !target) return; void mutate(async () => {
        const entry = await api.saveDeviceMapping(reverse ? targetId : device.id,provider,{ kind, source_code:sourceCode, source_dp_id:toDP(source,sourceDP), target_device_id:reverse ? device.id : targetId, target_code:targetCode, target_dp_id:toDP(target,targetDP) });
        if (alive.current) setEntries(v => [...v,entry]);
      }); }}>
        <label>Тип связи<select value={kind} disabled={busy || disabled} onChange={e => setKind(e.target.value as MappingInput['kind'])}>{Object.entries(kinds).map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        <label>Направление<select value={reverse ? 'incoming' : 'outgoing'} disabled={busy || disabled} onChange={e => setReverse(e.target.value === 'incoming')}><option value="outgoing">Это устройство → другое</option><option value="incoming">Другое устройство → это</option></select></label>
        <label>Кнопка / параметр источника<select value={sourceCode} disabled={busy || disabled} onChange={e => { setSourceCode(e.target.value); setSourceDP(''); }}>{sourceSpecs.map(s => <option key={s.code} value={s.code}>{title(s)}</option>)}</select></label>
        <label>DP источника<input type="number" min={1} max={255} step={1} value={source?.dp_id ?? sourceDP} disabled={busy || disabled || Boolean(source?.dp_id)} placeholder="Неизвестен — можно указать вручную" onChange={e => setSourceDP(e.target.value)} /></label>
        <label>{reverse ? 'Устройство источника' : 'Устройство назначения'}<select required value={targetId} disabled={busy || disabled} onChange={e => setTargetId(e.target.value)}><option value="">Выберите устройство</option>{choices.filter(d => d.id !== device.id).map(d => <option key={d.id} value={d.id}>{d.name || 'Устройство'} · {d.id}</option>)}</select></label>
        <label>Кнопка / параметр назначения<select required value={targetCode} disabled={busy || disabled || !destinationSpecs.length} onChange={e => { setTargetCode(e.target.value); setTargetDP(''); }}><option value="">Выберите параметр</option>{destinationSpecs.map(s => <option key={s.code} value={s.code}>{title(s)}</option>)}</select></label>
        <label>DP назначения<input type="number" min={1} max={255} step={1} value={target?.dp_id ?? targetDP} disabled={busy || disabled || Boolean(target?.dp_id)} placeholder="Неизвестен — можно указать вручную" onChange={e => setTargetDP(e.target.value)} /></label>
        <button className="compact" disabled={busy || disabled || !source || !target} type="submit">Сохранить сопоставление</button>
      </form>
    </>}
  </details>;
}
