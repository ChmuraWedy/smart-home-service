import { MSG, dateLocale, t, translateText } from "../i18n";
import { useEffect, useRef, useState } from 'react';
import { ApiError, type CloudApi, type DeviceEvent, type Provider } from '../api';
import { cloudReading, displayReading, labelFor, optionLabel } from '../controls';
import type { ControlSpec } from '../controls';
import { ParameterIcon } from './DevicePresentation';

function eventText(event: DeviceEvent, specs: ControlSpec[]) {
  if (event.kind === 'command') {
    const labels = event.value && typeof event.value === 'object' && !Array.isArray(event.value) ? Object.keys(event.value).map(labelFor).join(', ') : '';
    return ({sent:t(MSG.COMMAND_REQUESTED),accepted:t(MSG.COMMAND_ACCEPTED),rejected:t(MSG.COMMAND_REJECTED),unknown:t(MSG.COMMAND_RESULT_UNKNOWN)}[event.outcome || ''] || t(MSG.COMMAND)) + (labels ? ' · ' + labels : '');
  }
  if (event.code === 'online') return event.value ? t(MSG.DEVICE_ONLINE) : t(MSG.DEVICE_OFFLINE);
  const spec = specs.find(item => item.key === event.code);
  const value = spec ? displayReading(spec, event.kind === 'local' ? {value:event.value,known:true,stale:false} : cloudReading(spec,event.value)) : optionLabel(event.value);
  return labelFor(event.code) + ': ' + value;
}
export function DeviceActivity({ api, deviceId, provider, specs, primary = false, onAuthError }: { api: CloudApi; deviceId: string; provider: Provider | 'local'; specs: ControlSpec[]; primary?: boolean; onAuthError: () => void }) {
  const [open, setOpen] = useState(primary), [events, setEvents] = useState<DeviceEvent[]>([]), [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [filter, setFilter] = useState('all');
  const cursorLoaded = useRef(false);
  const pagingAbort = useRef<AbortController | null>(null);
  const hasMotion = primary || specs.some(spec => spec.indicator === 'motion');
  const hasCommands = specs.some(spec => spec.writable) || events.some(event => event.kind === 'command');
  const effectiveFilter = filter === 'motion' && !hasMotion || filter === 'commands' && !hasCommands ? 'all' : filter;
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    const controller = new AbortController(); let pending = false;
    const load = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const result = await api.deviceActivity(deviceId,provider,undefined,controller.signal);
        if (!Array.isArray(result.events)) throw new Error(t(MSG.THE_ACTIVITY_LOG_IS_CURRENTLY_UNAVAILABLE));
        if (!controller.signal.aborted) { setEvents(previous => [...new Map([...result.events,...previous].map(event => [event.id,event])).values()].sort((a,b) => b.id-a.id).slice(0,2000)); if (!cursorLoaded.current) { setNext(result.next_before); cursorLoaded.current = true; } setError(''); }
      } catch (failure) { if (!controller.signal.aborted) { setError((failure as Error).message); if (failure instanceof ApiError && failure.status === 401) onAuthError(); } }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => void load(),3000);
    return () => { controller.abort(); pagingAbort.current?.abort(); clearInterval(timer); };
  },[api,deviceId,provider,open]);
  async function older() {
    if (!next || busy) return;
    const controller = new AbortController(); pagingAbort.current = controller;
    setBusy(true);
    try { const result = await api.deviceActivity(deviceId,provider,next,controller.signal); if (controller.signal.aborted) return; setEvents(previous => [...new Map([...previous,...result.events].map(event => [event.id,event])).values()].sort((a,b) => b.id-a.id)); setNext(result.next_before); setError(''); }
    catch (failure) { if (!controller.signal.aborted) { setError((failure as Error).message); if (failure instanceof ApiError && failure.status === 401) onAuthError(); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const visible = events.filter(event => effectiveFilter === 'all' || (effectiveFilter === 'commands' ? event.kind === 'command' : specs.some(spec => spec.key === event.code && spec.indicator === 'motion')));
  return <details className={'device-activity' + (primary ? ' primary-activity' : '')} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{primary ? t(MSG.ACTIVITY_LOG) : t(MSG.DEVICE_LOG)}</summary>
    <div className="activity-toolbar">{(hasMotion || hasCommands) && <label>{t(MSG.SHOW)}<select value={effectiveFilter} onChange={event => setFilter(event.target.value)}><option value="all">{t(MSG.ALL_EVENTS)}</option>{hasMotion && <option value="motion">{t(MSG.MOTION)}</option>}{hasCommands && <option value="commands">{t(MSG.COMMANDS)}</option>}</select></label>}<span className="help">{t(MSG.LAST_2_000_EVENTS_NEW_REPORTS_APPEAR_AUTOMATICALLY)}</span></div>
    {error && <p className="field-error" role="alert">{translateText(error)}</p>}
    {!visible.length && <p className="help">{t(MSG.NO_EVENTS_YET)}</p>}
    <ol className="activity-events">{visible.map(event => <li key={event.id}><ParameterIcon code={event.code} /><div><strong>{eventText(event,specs)}</strong><span>{event.kind === 'snapshot' ? t(MSG.SAVED_SNAPSHOT_RECORDED) : event.kind === 'report' ? t(MSG.DEVICE_REPORT) : event.kind === 'local' ? t(MSG.LOCAL_READING) : ''}<time dateTime={event.observed_at || event.at}>{new Date(event.observed_at || event.at).toLocaleString(dateLocale())}</time>{event.observed_at && <span title={new Date(event.at).toLocaleString(dateLocale())}>{" " + t(MSG.RECEIVED) + " "}{new Date(event.at).toLocaleTimeString(dateLocale())}</span>}</span></div></li>)}</ol>
    {next && <button className="secondary compact" disabled={busy} onClick={() => void older()}>{t(MSG.EARLIER_EVENTS)}</button>}
    <p className="help">{t(MSG.AN_ACCEPTED_COMMAND_DOES_NOT_CONFIRM_A_DEVICE)}</p>
  </details>;
}
