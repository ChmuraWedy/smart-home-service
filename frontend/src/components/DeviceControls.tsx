import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api';
import type { JsonValue } from '../api';
import { displayReading, hexToHsv, hsvToHex, isStale, motionState, optionLabel, sameValue, validateControlValue } from '../controls';
import type { ControlSpec, HSV } from '../controls';
import type { Reading } from '../home-api';
import { defaultObject } from '../lighting';
import { JsonFields, PowerMemoryFields, RawScheduleFields } from './LightingFields';

export type ControlNotice = { text: string; error?: boolean };
export type Receipt = ControlNotice;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить запрос.';

export function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}

export function useControlSession<T>(load: (refresh: boolean, signal?: AbortSignal) => Promise<T>, onAuthError: () => void, poll?: (current:T, signal:AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [busy, setBusy] = useState(true);
  const [readOK, setReadOK] = useState(false);
  const [notice, setNotice] = useState<ControlNotice>({ text: '' });
  const lock = useRef(true), alive = useRef(false), authError = useRef(onAuthError);
  authError.current = onAuthError;
  const abort = useRef<AbortController | null>(null);
  const pollAbort = useRef<AbortController | null>(null), epoch = useRef(0), current = useRef(data);
  current.current = data;
  const cancelPoll = () => { epoch.current++; pollAbort.current?.abort(); pollAbort.current = null; };
  const unauthorized = (error: unknown) => { if (error instanceof ApiError && error.status === 401) authError.current(); };

  useEffect(() => {
    alive.current = true; lock.current = true;
    setData(null); setBusy(true); setReadOK(false); setNotice({ text: '' });
    const controller = new AbortController(); abort.current = controller;
    void load(false, controller.signal).then(value => {
      if (alive.current && !controller.signal.aborted) { setData(value); setReadOK(true); }
    }).catch(error => {
      if (alive.current && !controller.signal.aborted) { setNotice({ text: errorText(error), error: true }); unauthorized(error); }
    }).finally(() => {
      if (alive.current && !controller.signal.aborted) { lock.current = false; setBusy(false); }
    });
    return () => { alive.current = false; controller.abort(); abort.current?.abort(); cancelPoll(); };
  }, [load]);

  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => {
      if (!alive.current || lock.current || current.current === null || pollAbort.current || document.visibilityState === 'hidden') return;
      const controller = new AbortController(), version = epoch.current;
      pollAbort.current = controller;
      void poll(current.current,controller.signal).then(value => {
        if (alive.current && !controller.signal.aborted && version === epoch.current && !lock.current) { setData(value); setNotice(previous => previous.text.startsWith('Автообновление недоступно:') ? {text:''} : previous); }
      }).catch(error => {
        if (alive.current && !controller.signal.aborted && version === epoch.current) { setNotice({text:'Автообновление недоступно: '+errorText(error),error:true}); unauthorized(error); }
      }).finally(() => { if (pollAbort.current === controller) pollAbort.current = null; });
    },3000);
    return () => { clearInterval(timer); cancelPoll(); };
  }, [poll]);

  async function read() {
    const controller = new AbortController(); abort.current = controller;
    const value = await load(true, controller.signal);
    if (alive.current && !controller.signal.aborted) { setData(value); setReadOK(true); }
  }
  async function refresh() {
    if (lock.current) return;
    cancelPoll();
    lock.current = true; setBusy(true); setNotice({ text: '' });
    try { await read(); if (alive.current) setNotice({ text: 'Статус запрошен заново.' }); }
    catch (error) { if (alive.current) { setReadOK(false); setNotice({ text: errorText(error), error: true }); unauthorized(error); } }
    finally { if (alive.current) { lock.current = false; setBusy(false); } }
  }
  async function execute(send: () => Promise<Receipt>) {
    if (lock.current || !readOK) return false;
    cancelPoll();
    lock.current = true; setBusy(true); setNotice({ text: '' });
    try {
      const receipt = await send();
      if (!alive.current) return;
      setNotice({ ...receipt, text: receipt.text + ' Запрашиваем статус…' });
      try { await read(); if (alive.current) setNotice({ ...receipt, text: receipt.text + ' Статус запрошен заново; показания отображаются отдельно.' }); }
      catch (error) {
        if (alive.current) { setReadOK(false); setNotice({ text: receipt.text + ' Обновить статус не удалось: ' + errorText(error), error: true }); unauthorized(error); }
      }
    } catch (error) {
      if (alive.current) {
        const rejected = error instanceof ApiError && [401, 403, 404, 409, 422].includes(error.status);
        setNotice({ text: (rejected ? 'Команда отклонена. ' : 'Подтверждение не получено; результат команды неизвестен. ') + errorText(error), error: true });
        unauthorized(error);
      }
      return false;
    } finally { if (alive.current) { lock.current = false; setBusy(false); } }
    return true;
  }
  return { data, busy, readOK, notice, refresh, execute };
}

export function ControlDialog({ title, subtitle, busy, onClose, children, closeLabel = 'Закрыть', titleContent, className = '' }: {
  title: string; subtitle: string; busy: boolean; onClose: () => void; children: ReactNode; closeLabel?: string; titleContent?: ReactNode; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className={'control-dialog ' + className} aria-label={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}>
    <header className="control-header"><div><p className="eyebrow">{subtitle}</p>{titleContent || <h2>{title}</h2>}</div><button className="secondary compact" disabled={busy} onClick={onClose}>{closeLabel}</button></header>
    {children}
  </dialog>;
}

export function ControlFeedback({ busy, notice }: { busy: boolean; notice: ControlNotice }) {
  return <div className={'control-feedback' + (notice.error ? ' error' : '')} role={notice.error ? 'alert' : 'status'} aria-live="polite">
    {busy && <span className="spinner" aria-hidden="true" />}{notice.text || (busy ? 'Загружаем…' : '')}
  </div>;
}

export function CapabilityField({ spec, reading, now, local, disabled, onSend, onRefresh, aliasEditor }: {
  spec: ControlSpec; reading?: Reading; now: number; local: boolean; disabled: boolean; onSend: (value: JsonValue) => Promise<boolean | void>; onRefresh?: () => Promise<void>; aliasEditor?: ReactNode;
}) {
  const fresh = reading?.known && !isStale(reading, now, local);
  const motion = motionState(spec, reading);
  const [draft, setDraft] = useState('');
  const [color, setColor] = useState<HSV>({ h: 0, s: 1000, v: 1000 });
  const pendingTarget = useRef<{ value: JsonValue; baseline: JsonValue | undefined; sentAt: number } | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const [dirty, setDirty] = useState(false), [error, setError] = useState('');
  const fingerprint = JSON.stringify([reading?.value, reading?.known, reading?.stale, reading?.observed_at]);
  useEffect(() => {
    if (dirty) return; // A new report must not erase an unapplied user draft.
    const target = pendingTarget.current;
    if (target) {
      const received = Date.parse(reading?.received_at || reading?.observed_at || '');
      const confirmed = reading?.known && sameValue(reading.value, target.value);
      const newerReport = reading?.known && Number.isFinite(received) && received >= target.sentAt;
      const changedLater = now - target.sentAt >= 15000 && reading?.known && !sameValue(reading.value, target.baseline ?? null);
      if (!confirmed && !newerReport && !changedLater) return;
      pendingTarget.current = null; setAwaiting(false);
    }
    // Keep a selected target when Tuya has no fresh reading.
    if (!fresh && draft !== '') return;
    const value = fresh ? reading!.value : null;
    setDraft(value === null ? '' : spec.kind === 'enum' ? String(spec.choices?.findIndex(option => sameValue(option, value)) ?? -1) : spec.kind === 'json' ? JSON.stringify(value, null, 2) : String(value));
    if (spec.kind === 'color' && value && typeof value === 'object' && !Array.isArray(value)) setColor(value as HSV);
    setDirty(false); setError('');
  }, [fingerprint, spec.key, dirty, now, awaiting]);

  const change = (value: string) => { setDraft(value); setDirty(true); setError(''); };
  const changeColor = (value: HSV) => { setColor(value); setDirty(true); setError(''); };
  async function send(value?: JsonValue) {
    try {
      let parsed = value;
      if (parsed === undefined) {
        if (spec.kind === 'number') { if (!draft.trim()) throw new Error('Введите значение.'); parsed = Number(draft); }
        else if (spec.kind === 'enum') parsed = spec.choices?.[Number(draft)] ?? null;
        else if (spec.kind === 'color') parsed = color;
      else if (spec.kind === 'json') { try { parsed = JSON.parse(draft); } catch { throw new Error('Введите корректный JSON-объект.'); } }
        else parsed = draft;
      }
      validateControlValue(spec, parsed!);
      const sentAt = Date.now();
      const accepted = await onSend(parsed!);
      if (accepted === false) return;
      pendingTarget.current = { value: parsed!, baseline: reading?.value, sentAt };
      setAwaiting(true); setDirty(false);
    } catch (failure) { setError(errorText(failure)); }
  }
  return <section className={'capability' + (spec.kind === 'color' ? ' color-control' : '')} aria-label={spec.label}>
    <div className="capability-heading"><h3>{spec.label}</h3><div className="reading-meta">
      {spec.readable && !reading?.known && <span>Нет показания</span>}
      {reading?.known && (reading.observed_at || reading.received_at) && <span title={new Date(reading.observed_at || reading.received_at!).toLocaleString('ru-RU')}>{Math.max(0, Math.floor((now - Date.parse(reading.observed_at || reading.received_at!)) / 1000))} с назад</span>}
      {!spec.writable ? <span className="read-only">Только чтение</span> : !spec.readable && <span className="read-only">Команда</span>}
      {onRefresh && <button type="button" className="reading-refresh" aria-label={'Обновить показание ' + spec.label} title="Обновить показание" disabled={disabled} onClick={() => void onRefresh()}>↻</button>}
    </div></div>
    {aliasEditor}
    {spec.readable && (!spec.writable || !['number', 'enum', 'color'].includes(spec.kind)) && <p className={'reading' + (!fresh ? ' unknown' : '')}>{motion !== undefined && <span className={'sensor-indicator ' + (!fresh || motion === null ? 'unknown' : motion ? 'active' : 'clear')} aria-hidden="true" />}{displayReading(spec, reading)}{reading?.known && isStale(reading, now, local) && <span className="stale-tag">Устарело</span>}</p>}
    {awaiting && <p className="help pending-reading">Ожидаем новое показание</p>}
    {spec.reason && <p className="help">{spec.reason}</p>}
    {spec.help && <p className="help">{spec.help}</p>}
    {spec.writable && (spec.kind === 'boolean' ? <div className="power-actions">
      <button disabled={disabled} aria-pressed={Boolean(fresh && reading?.value === true)} onClick={() => void send(true)}>Включить</button>
      <button className="secondary" disabled={disabled} aria-pressed={Boolean(fresh && reading?.value === false)} onClick={() => void send(false)}>Выключить</button>
    </div> : <form onSubmit={event => { event.preventDefault(); if (!disabled && dirty && !(spec.kind === 'raw' && error)) void send(); }}>
      {spec.kind === 'number' && <div className="range-input-row">
        {spec.minimum !== undefined && spec.maximum !== undefined && <input aria-label={spec.label + ' — ползунок'} type="range" min={spec.minimum} max={spec.maximum} step={spec.step || 'any'} value={draft || spec.minimum} disabled={disabled} onChange={event => change(event.target.value)} />}
        <label className="range-value"><span className="sr-only">{spec.label}{spec.unit ? ' (' + spec.unit + ')' : ''}</span><input aria-label={spec.label + (spec.unit ? ' (' + spec.unit + ')' : '')} type="number" value={draft} min={spec.minimum} max={spec.maximum} step={spec.step || 'any'} disabled={disabled} onChange={event => change(event.target.value)} placeholder="Значение" />{spec.unit && <span>{spec.unit}</span>}</label>
      </div>}
      {spec.kind === 'enum' && <label>{spec.label}<select aria-label={spec.label} value={draft} disabled={disabled} onChange={event => change(event.target.value)}><option value="">Выберите значение</option>{spec.choices?.map((value, index) => <option key={index} value={index}>{optionLabel(value, spec.key)}</option>)}</select></label>}
      {spec.kind === 'color' && <div className="color-editor">
        <label className="color-picker">Выбор цвета<input type="color" value={hsvToHex(color)} disabled={disabled} onChange={event => changeColor(hexToHsv(event.target.value))} /></label>
        <div className="color-sliders">{(['h', 's', 'v'] as const).map(axis => <label key={axis}>{axis === 'h' ? 'Тон' : axis === 's' ? 'Насыщенность' : 'Яркость цвета'}<input aria-label={axis === 'h' ? 'Тон' : axis === 's' ? 'Насыщенность' : 'Яркость цвета'} type="range" min={0} max={axis === 'h' ? 360 : 1000} step={1} value={color[axis]} disabled={disabled} onChange={event => changeColor({ ...color, [axis]: Number(event.target.value) })} /></label>)}</div>
      </div>}
      {spec.kind === 'text' && <label>{spec.label}<input value={draft} disabled={disabled} maxLength={4096} onChange={event => change(event.target.value)} /></label>}
      {spec.kind === 'json' && (spec.schema ? <JsonFields schema={spec.schema} value={draft ? JSON.parse(draft) : defaultObject(spec.schema)} prefix={spec.key + '.'} disabled={disabled} onChange={v => change(JSON.stringify(v))} /> : <label>{spec.label} — JSON<textarea value={draft} disabled={disabled} maxLength={16384} rows={4} onChange={event => change(event.target.value)} /></label>)}
      {spec.kind === 'raw' && <>
        {spec.key === 'power_memory' && <PowerMemoryFields value={draft} disabled={disabled} onChange={change} />}
        <RawScheduleFields code={spec.key} value={draft} disabled={disabled} onChange={change} onInvalid={setError} />
        <label>Данные производителя (base64)<textarea value={draft} disabled={disabled} maxLength={22000} rows={2} onChange={event => change(event.target.value)} /></label>
        <p className="help">Размер после декодирования: до {spec.maximumBytes} байт. Изменение отправляется только кнопкой «Применить».</p>
      </>}
      <button className="compact apply-control" disabled={disabled || !dirty || (spec.kind === 'raw' && Boolean(error)) || ((spec.kind === 'number' || spec.kind === 'enum') && !draft)} type="submit">Применить</button>
    </form>)}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
