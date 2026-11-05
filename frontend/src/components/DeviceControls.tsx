import { dateLocale, t } from "../i18n";
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api';
import type { JsonValue } from '../api';
import { displayReading, hexToHsv, hsvToHex, isStale, motionState, optionLabel, sameValue, validateControlValue } from '../controls';
import type { ControlSpec, HSV } from '../controls';
import type { Reading } from '../home-api';
import type { DraftStage } from '../control-drafts';
import { defaultObject } from '../lighting';
import { JsonFields, PowerMemoryFields, RawScheduleFields } from './LightingFields';
import { hasScheduleWizard, ScheduleWizard, scheduleSummary } from './ScheduleWizard';
import { hasLightEffectWizard, LightEffectWizard } from './LightEffectWizard';
import { ParameterIcon } from './DevicePresentation';
import { Switch } from './ui/switch';

export type ControlNotice = { text: string; error?: boolean };
export type Receipt = ControlNotice;
const errorText = (error: unknown) => error instanceof Error ? error.message : t("Не удалось выполнить запрос.");

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
        if (alive.current && !controller.signal.aborted && version === epoch.current && !lock.current) { setData(value); setReadOK(true); setNotice(previous => previous.text.startsWith(t("Автообновление недоступно:")) ? {text:''} : previous); }
      }).catch(error => {
        if (alive.current && !controller.signal.aborted && version === epoch.current) { setNotice({text:t("Автообновление недоступно: ")+errorText(error),error:true}); unauthorized(error); }
      }).finally(() => { if (pollAbort.current === controller) pollAbort.current = null; });
    },1000);
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
    try { await read(); if (alive.current) setNotice({ text: t("Статус запрошен заново.") }); }
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
      if (poll) {
        setNotice({...receipt, text: receipt.text + t(" Ожидаем отчёт устройства.")});
        return true;
      }
      setNotice({ ...receipt, text: receipt.text + t(" Запрашиваем статус…") });
      try { await read(); if (alive.current) setNotice({ ...receipt, text: receipt.text + t(" Статус запрошен заново; показания отображаются отдельно.") }); }
      catch (error) {
        if (alive.current) { setReadOK(false); setNotice({ text: receipt.text + t(" Обновить статус не удалось: ") + errorText(error), error: true }); unauthorized(error); }
      }
    } catch (error) {
      if (alive.current) {
        const rejected = error instanceof ApiError && [401, 403, 404, 409, 422].includes(error.status);
        setNotice({ text: (rejected ? t("Команда отклонена. ") : t("Подтверждение не получено; результат команды неизвестен. ")) + errorText(error), error: true });
        unauthorized(error);
      }
      return false;
    } finally { if (alive.current) { lock.current = false; setBusy(false); } }
    return true;
  }
  return { data, busy, readOK, notice, refresh, execute };
}

let bodyScrollLocks = 0, savedBodyOverflow = '';
function lockBodyScroll() {
  if (bodyScrollLocks++ === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  return () => { if (--bodyScrollLocks === 0) document.body.style.overflow = savedBodyOverflow; };
}

export function ControlDialog({ title, subtitle, busy, onClose, children, closeLabel = t("Закрыть"), titleContent, connectionContent, statusContent, information, onRefresh, className = '' }: {
  title: string; subtitle?: string; busy: boolean; onClose: () => void; children: ReactNode; closeLabel?: string; titleContent?: ReactNode; connectionContent?: ReactNode; statusContent?: ReactNode; information?: ReactNode; onRefresh?: () => Promise<void>; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [infoOpen,setInfoOpen] = useState(false);
  const infoId = useId();
  const infoPanel = useRef<HTMLElement>(null), infoButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!infoOpen) return;
    const outside = (event:PointerEvent) => { if (!infoPanel.current?.contains(event.target as Node) && !infoButton.current?.contains(event.target as Node)) setInfoOpen(false); };
    const escape = (event:KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setInfoOpen(false); infoButton.current?.focus(); } };
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape,true);
    return () => { document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',escape,true); };
  },[infoOpen]);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const unlockBody = lockBodyScroll();
    element.showModal();
    return () => { element.close(); unlockBody(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className={'control-dialog ' + className} aria-label={title} aria-busy={busy} onClick={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (infoOpen) setInfoOpen(false); else if (!busy) onClose(); }}>
    <header className={"control-header" + (connectionContent ? " device-control-header" : "")}><div className="control-header-title">{subtitle && <p className="eyebrow">{subtitle}</p>}{titleContent || <h2>{title}</h2>}</div>{connectionContent}<div className="control-header-actions"><div className="control-header-buttons">{onRefresh && <button type="button" className="header-icon control-refresh" aria-label={t("Обновить статус")} title={t("Обновить статус")} disabled={busy} onClick={() => void onRefresh()}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 1-2.4-5.7L20 9" /></svg></button>}{information && <button type="button" ref={infoButton} className="header-icon control-information" aria-label={t("О подключении устройства")} title={t("О подключении устройства")} aria-expanded={infoOpen} aria-controls={infoId} onClick={() => setInfoOpen(value => !value)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg></button>}<button className="header-icon control-dismiss" aria-label={closeLabel} title={closeLabel} disabled={busy} onClick={onClose}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{closeLabel === t("Закрыть") ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="m14 5-7 7 7 7M7 12h14" />}</svg></button></div>{statusContent}{information && infoOpen && <section ref={infoPanel} id={infoId} className="connection-information connection-balloon" aria-label={t("О подключении устройства")}><button type="button" className="secondary balloon-close" aria-label={t("Закрыть справку")} onClick={() => { setInfoOpen(false); infoButton.current?.focus(); }}>×</button>{information}</section>}</div></header>
    <div className="control-dialog-body">{children}</div>
  </dialog>;
}

export function ControlFeedback({ busy, notice }: { busy: boolean; notice: ControlNotice }) {
  return <div className={'control-feedback' + (notice.error ? ' error' : '')} role={notice.error ? 'alert' : 'status'} aria-live="polite">
    {busy && <span className="spinner" aria-hidden="true" />}{t(notice.text) || (busy ? t("Загружаем…") : '')}
  </div>;
}

export function CapabilityField({ spec, reading, now, local, disabled, onSend, aliasEditor, headingActions, stage, immediatePower = false, dashboardSwitch = false, powerIcon, powerOnText, booleanButton = false, buttonText, onBooleanStateChange, valueEditor }: {
  spec: ControlSpec; reading?: Reading; now: number; local: boolean; disabled: boolean; onSend: (value: JsonValue) => Promise<boolean | void>; aliasEditor?: ReactNode; headingActions?: ReactNode; stage?: DraftStage; immediatePower?: boolean; dashboardSwitch?: boolean; powerIcon?:ReactNode; powerOnText?:string; booleanButton?: boolean; buttonText?:string | ((value:boolean | null)=>string); onBooleanStateChange?:(value:boolean | null)=>void; valueEditor?:(draft:string,change:(value:string)=>void)=>ReactNode;
}) {
  const powerId = useId();
  const fresh = reading?.known && !isStale(reading, now, local);
  const motion = motionState(spec, reading);
  const [draft, setDraft] = useState('');
  const initial = useRef<JsonValue | undefined>(undefined);
  const [preciseColor, setPreciseColor] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false), [effectOpen, setEffectOpen] = useState(false);
  const effectWizard = hasLightEffectWizard(spec);
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
    const value = reading?.known ? reading.value : null;
    setDraft(value === null ? '' : spec.kind === 'enum' ? String(spec.choices?.findIndex(option => sameValue(option, value)) ?? -1) : spec.kind === 'json' ? JSON.stringify(value, null, 2) : String(value));
    if (spec.kind === 'color' && value && typeof value === 'object' && !Array.isArray(value)) setColor(value as HSV);
    setDirty(false); setError('');
  }, [fingerprint, spec.key, dirty, now, awaiting]);

  function beginEdit() {
    if (!dirty) initial.current = pendingTarget.current?.value ?? (reading?.known ? reading.value : undefined);
  }
  const change = (value: string) => { beginEdit(); setDraft(value); setDirty(true); setError(''); };
  const changeColor = (value: HSV) => { beginEdit(); setColor(value); setDirty(true); setError(''); };
  function parsedDraft(): JsonValue {
    let value: JsonValue;
    if (spec.kind === 'number') { if (!draft.trim()) throw new Error(t("Введите значение.")); value = Number(draft); }
    else if (spec.kind === 'enum') { if (!draft) throw new Error(t("Выберите значение.")); value = spec.choices?.[Number(draft)] ?? null; }
    else if (spec.kind === 'boolean') value = draft === 'true';
    else if (spec.kind === 'color') value = color;
    else if (spec.kind === 'json') { try { value = JSON.parse(draft); } catch { throw new Error(t("Введите корректный JSON-объект.")); } }
    else value = draft;
    validateControlValue(spec, value);
    return value;
  }
  let draftError = '';
  try { if (stage && dirty) parsedDraft(); } catch (failure) { draftError = errorText(failure); }
  useEffect(() => {
    if (!stage) return;
    if (!dirty) { stage(spec.key, null); return; }
    let value: JsonValue | undefined, invalid = error;
    try { value = parsedDraft(); } catch (failure) { invalid = errorText(failure); }
    if (!invalid && value !== undefined && initial.current !== undefined && sameValue(value, initial.current)) {
      stage(spec.key, null); setDirty(false); return;
    }
    stage(spec.key, { spec, value, error: invalid, accept: sentAt => {
      pendingTarget.current = { value: value!, baseline: initial.current, sentAt };
      setAwaiting(true); setDirty(false);
    } });
  }, [stage, spec.key, draft, color, dirty, error]);
  useEffect(() => () => { stage?.(spec.key, null); }, [stage, spec.key]);
  const selectedPower = (stage || immediatePower) && (dirty || awaiting) ? draft === 'true' : Boolean(reading?.known && reading.value === true);
  // A pending off command is not a confirmed off report. Consumers can keep
  // dependent actions blocked until the device confirms the new state.
  useEffect(()=>{
    if (spec.kind==='boolean') onBooleanStateChange?.(awaiting ? (selectedPower ? true : null) : reading?.known && typeof reading.value==='boolean' ? reading.value : null);
  },[onBooleanStateChange,spec.kind,awaiting,selectedPower,reading?.known,reading?.value]);
  async function send(value?: JsonValue) {
    try {
      let parsed = value;
      if (parsed === undefined) {
        if (spec.kind === 'number') { if (!draft.trim()) throw new Error(t("Введите значение.")); parsed = Number(draft); }
        else if (spec.kind === 'enum') parsed = spec.choices?.[Number(draft)] ?? null;
        else if (spec.kind === 'color') parsed = color;
      else if (spec.kind === 'json') { try { parsed = JSON.parse(draft); } catch { throw new Error(t("Введите корректный JSON-объект.")); } }
        else parsed = draft;
      }
      validateControlValue(spec, parsed!);
      const sentAt = Date.now();
      const accepted = await onSend(parsed!);
      if (accepted === false) return;
      pendingTarget.current = { value: parsed!, baseline: reading?.value, sentAt };
      if (immediatePower) setDraft(String(parsed));
      setAwaiting(true); setDirty(false);
    } catch (failure) { setError(errorText(failure)); }
  }
  function changePower(checked: boolean) {
    if (immediatePower) void send(checked);
    else change(String(checked));
  }
  const powerKnown = awaiting || (reading?.known && typeof reading.value === 'boolean');
  return <section className={'capability capability-' + spec.kind + (spec.kind === 'color' ? ' color-control' : '')} aria-label={spec.label}>
    <div className="capability-row"><div className="capability-heading"><div className="capability-label"><div className="capability-label-line"><h3>{!spec.writable && <ParameterIcon code={spec.key} />}{spec.writable && spec.kind === 'boolean' && (stage || immediatePower) && !powerIcon ? <label htmlFor={powerId}>{spec.label}</label> : spec.label}</h3>{headingActions}</div>{aliasEditor && <div className="capability-alias-editor">{aliasEditor}</div>}</div>
    </div>
    {powerIcon && <span className="dashboard-power-state">
      {powerKnown ? selectedPower ? powerOnText || t("Включено") : t("Выключено") : t("Нет данных")}
      {powerKnown && !fresh && !awaiting && <span className="stale-tag">{t("Устарело")}</span>}
      {awaiting && <span className="help pending-reading">{t("Ожидаем новое показание")}</span>}
    </span>}
    {spec.kind === 'color' && <div className="color-tools">
      {spec.kind === 'color' && spec.writable && <input aria-label={t("Выбор цвета")} title={t("Выбор цвета")} className="color-picker" type="color" value={hsvToHex(color)} disabled={disabled} onChange={event => changeColor(hexToHsv(event.target.value))} />}
      {spec.kind === 'color' && spec.writable && <button type="button" className="secondary color-details-toggle" aria-label={t("Точная настройка цвета")} title={t("Тон, насыщенность и яркость")} aria-expanded={preciseColor} onClick={() => setPreciseColor(value => !value)}>···</button>}
    </div>}
    {spec.readable && !spec.writable && <p className={'reading' + (!fresh ? ' unknown' : '')}>{motion !== undefined && <span className={'sensor-indicator ' + (!fresh || motion === null ? 'unknown' : motion ? 'active' : 'clear')} aria-hidden="true" />}{displayReading(spec, reading)}{reading?.known && isStale(reading, now, local) && <span className="stale-tag">{t("Устарело")}</span>}</p>}
    {spec.writable && (spec.kind === 'boolean' ? <div className="power-actions">
      {stage || immediatePower ? <>{booleanButton ? <button id={powerId} type="button" className="secondary compact mode-button" title={reading?.known || awaiting ? (selectedPower ? t("Выключить: ") : t("Включить: "))+spec.label : undefined} aria-label={spec.label} aria-pressed={selectedPower} disabled={disabled || (!reading?.known && !awaiting)} onClick={() => changePower(!selectedPower)}>{typeof buttonText==='function' ? buttonText(reading?.known || awaiting ? selectedPower : null) : buttonText || (selectedPower ? t("Выключить") : t("Включить"))}</button>
        : dashboardSwitch ? <Switch id={powerId} aria-label={spec.label} powerIcon={powerIcon} checked={selectedPower} disabled={disabled} onChange={changePower} />
        : <button id={powerId} type="button" className="power-toggle" role="switch" aria-label={spec.label} aria-checked={selectedPower} disabled={disabled} onClick={() => changePower(!selectedPower)}><span /></button>}{!powerIcon && !dirty && !awaiting && !reading?.known && <span className="power-selection">{t("Нет данных")}</span>}{!powerIcon && reading?.known && !fresh && !dirty && !awaiting && <span className="stale-tag">{t("Устарело")}</span>}{(dirty || awaiting) && <span className="help">{dirty ? t("Изменено") : t("Ожидаем показание")}{spec.readable && <>{" " + t("· сейчас:") + " "}<span>{displayReading(spec,reading)}</span></>}</span>}</> : <>
      {spec.readable && <span className={'power-reading' + (!fresh ? ' unknown' : '')}>{displayReading(spec, reading)}</span>}
      <button disabled={disabled} aria-pressed={selectedPower} onClick={() => stage ? change('true') : void send(true)}>{t("Включить")}</button>
      <button className="secondary" disabled={disabled} aria-pressed={stage && (dirty || awaiting) ? !selectedPower : Boolean(fresh && reading?.value === false)} onClick={() => stage ? change('false') : void send(false)}>{t("Выключить")}</button>
      </>}
    </div> : <form className="capability-form" onSubmit={event => { event.preventDefault(); if (!stage && !disabled && dirty && !(spec.kind === 'raw' && error)) void send(); }}>
      {valueEditor?.(draft,change)}
      {spec.kind === 'number' && <div className="range-input-row">
        <label className="range-value"><span className="sr-only">{spec.label}{spec.unit ? ' (' + spec.unit + ')' : ''}</span><input aria-label={spec.label + (spec.unit ? ' (' + spec.unit + ')' : '')} type="number" value={draft} style={{ width: Math.max(2, Math.min(14, draft.length + 1)) + 'ch' }} min={spec.minimum} max={spec.maximum} step={spec.step || 'any'} disabled={disabled} onChange={event => change(event.target.value)} placeholder={t("Значение")} />{spec.unit && <span>{spec.unit}</span>}</label>
        {spec.minimum !== undefined && spec.maximum !== undefined && <input aria-label={spec.label + t(" — ползунок")} type="range" min={spec.minimum} max={spec.maximum} step={spec.step || 'any'} value={draft || spec.minimum} disabled={disabled} onChange={event => change(event.target.value)} />}
      </div>}
      {spec.kind === 'enum' && <label className="enum-value"><span className="sr-only">{spec.label}</span><select aria-label={spec.label} value={draft} disabled={disabled} onChange={event => change(event.target.value)}><option value="">{t("Выберите значение")}</option>{spec.choices?.map((value, index) => <option key={index} value={index}>{optionLabel(value, spec.key)}</option>)}</select></label>}
      {spec.kind === 'color' && <div className="color-editor">
        {preciseColor && <div className="color-sliders">{(['h', 's', 'v'] as const).map(axis => <label key={axis}>{axis === 'h' ? t("Тон") : axis === 's' ? t("Насыщенность") : t("Яркость цвета")}<input aria-label={axis === 'h' ? t("Тон") : axis === 's' ? t("Насыщенность") : t("Яркость цвета")} type="range" min={0} max={axis === 'h' ? 360 : 1000} step={1} value={color[axis]} disabled={disabled} onChange={event => changeColor({ ...color, [axis]: Number(event.target.value) })} /></label>)}</div>}
      </div>}
      {spec.kind === 'text' && !effectWizard && !valueEditor && <label>{spec.label}<input value={draft} disabled={disabled} maxLength={4096} onChange={event => change(event.target.value)} /></label>}
      {spec.kind === 'json' && !effectWizard && !valueEditor && (spec.schema ? <JsonFields schema={spec.schema} value={draft ? JSON.parse(draft) : defaultObject(spec.schema)} prefix={spec.key + '.'} disabled={disabled} onChange={v => change(JSON.stringify(v))} /> : <label>{spec.label} — JSON<textarea value={draft} disabled={disabled} maxLength={16384} rows={4} onChange={event => change(event.target.value)} /></label>)}
      {effectWizard ? <div className="schedule-launch"><button type="button" className="secondary compact" disabled={disabled} onClick={() => setEffectOpen(true)}>{t("Настроить")}</button></div> : hasScheduleWizard(spec) ? <div className="schedule-launch"><span className="help">{scheduleSummary(spec.key,draft)}</span><button type="button" className="secondary compact" disabled={disabled} onClick={() => setScheduleOpen(true)}>{t("Настроить")}</button></div> : spec.kind === 'raw' && <>
        {spec.key === 'power_memory' && <PowerMemoryFields value={draft} disabled={disabled} onChange={change} />}
        <RawScheduleFields code={spec.key} value={draft} disabled={disabled} onChange={change} onInvalid={setError} />
        <label>{t("Данные производителя (base64)")}<textarea value={draft} disabled={disabled} maxLength={22000} rows={2} onChange={event => change(event.target.value)} /></label>
        <p className="help">{t("Размер после декодирования: до") + " "}{spec.maximumBytes}{" " + t("байт. Корректные изменения отправляются автоматически.")}</p>
      </>}
      {!stage && <button className="compact apply-control" disabled={disabled || !dirty || (spec.kind === 'raw' && Boolean(error)) || ((spec.kind === 'number' || spec.kind === 'enum') && !draft)} type="submit">{t("Применить")}</button>}
    </form>)}
    <div className="reading-meta">
      {spec.readable && !reading?.known && <span>{t("Нет показания")}</span>}
      {reading?.known && (reading.observed_at || reading.received_at) && <span title={new Date(reading.observed_at || reading.received_at!).toLocaleString(dateLocale())}>{Math.max(0, Math.floor((now - Date.parse(reading.observed_at || reading.received_at!)) / 1000))}{" " + t("с назад")}</span>}
      {!spec.writable ? <span className="read-only">{t("Только чтение")}</span> : !spec.readable && <span className="read-only">{t("Команда")}</span>}
    </div></div>
    {awaiting && !powerIcon && <p className="help pending-reading">{t("Ожидаем новое показание")}</p>}
    {spec.reason && <p className="help">{spec.reason}</p>}
    {spec.help && <p className="help">{spec.help}</p>}
    {(error || draftError) && <p className="field-error" role="alert">{error || draftError}</p>}
    {effectOpen && <LightEffectWizard spec={spec} value={draft} onClose={() => setEffectOpen(false)} onDone={value => { change(value); setEffectOpen(false); }} />}
    {scheduleOpen && <ScheduleWizard spec={spec} value={draft} onClose={() => setScheduleOpen(false)} onDone={value => { change(value); setScheduleOpen(false); }} />}
  </section>;
}
