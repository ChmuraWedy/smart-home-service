import { MSG, localizeMessages, t, translateText } from "../i18n";
import { useState } from 'react';
import type { JsonValue } from '../api';
import type { ControlSpec } from '../controls';
import { validateControlValue } from '../controls';
import { defaultObject } from '../lighting';
import type { JsonSchema } from '../lighting';
import { decodeRawSchedule, defaultSchedule, encodeRawSchedule, rawNodeLimits, rawSchemas } from '../raw-lighting';
import { JsonFields } from './LightingFields';
import { WizardDialog } from './WizardDialog';

const descriptions: Record<string, string> = localizeMessages({
  rhythm_mode: MSG.SCHEDULE_HELP_RHYTHM_MODE,
  random_timing: MSG.SCHEDULE_HELP_RANDOM_TIMING,
  wakeup_mode: MSG.SCHEDULE_HELP_WAKEUP_MODE,
  sleep_mode: MSG.SCHEDULE_HELP_SLEEP_MODE,
});
export const hasScheduleWizard = (spec: ControlSpec) => spec.kind === 'raw' && !!rawSchemas[spec.key];
export function scheduleSummary(code: string, value: string) {
  const model = decodeRawSchedule(code, value);
  return model ? t(MSG.POINT_COUNT, [(model.nodes as JsonValue[]).length]) : t(MSG.NOT_CONFIGURED_OR_ANOTHER_FORMAT);
}

export function ScheduleWizard({ spec, value, onDone, onClose }: { spec: ControlSpec; value: string; onDone: (value: string) => void; onClose: () => void }) {
  const [model, setModel] = useState(() => decodeRawSchedule(spec.key, value));
  const [step, setStep] = useState(0), [selected, setSelected] = useState(0), [error, setError] = useState('');
  const [raw, setRaw] = useState(value);
  const schema = rawSchemas[spec.key];
  const nodes = (model?.nodes || []) as Record<string, JsonValue>[];
  const general = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'nodes')) as JsonSchema;
  const update = (next: Record<string, JsonValue>) => { setModel(next); setError(''); };
  const validate = () => { try { if (!model) throw new Error(t(MSG.CREATE_A_SCHEDULE_OR_KEEP_THE_ORIGINAL_DATA)); return encodeRawSchedule(spec.key, model); } catch (failure) { setError(failure instanceof Error ? failure.message : t(MSG.CHECK_THE_SCHEDULE)); } };
  return <WizardDialog title={spec.label} description={descriptions[spec.key]} onClose={onClose} actions={model && <>
    {step > 0 && <button className="secondary" type="button" onClick={() => { setStep(step - 1); setError(''); }}>{t(MSG.BACK)}</button>}
    <button type="button" onClick={() => { const encoded = validate(); if (encoded === undefined) return; if (step < 2) setStep(step + 1); else onDone(encoded); }}>{step < 2 ? t(MSG.NEXT) : t(MSG.DONE)}</button>
  </>}>
    <ol className="wizard-steps" aria-label={t(MSG.SETUP_STEPS)}>{[t(MSG.REPEAT), t(MSG.SCHEDULE_POINTS), t(MSG.REVIEW)].map((title, index) => <li key={title} aria-current={step === index ? 'step' : undefined}>{index + 1}. {title}</li>)}</ol>
    {!model ? <div className="empty-state"><p>{t(MSG.THE_CURRENT_VALUE_WAS_NOT_RECOGNIZED_AS_A)}</p><button type="button" onClick={() => update(defaultSchedule(spec.key))}>{t(MSG.NEW_SCHEDULE)}</button></div> : <>
      {step === 0 && <div><h3>{t(MSG.WHEN_TO_RUN)}</h3><p className="help">{t(MSG.WITH_NO_SELECTED_DAYS_A_POINT_RUNS_ONCE)}</p>{Object.keys(general).length ? <JsonFields schema={general} value={model} prefix={spec.key + '.'} disabled={false} onChange={update} /> : <p>{t(MSG.SET_WEEKDAYS_AND_ENABLED_STATUS_SEPARATELY_FOR_EACH)}</p>}</div>}
      {step === 1 && <div className="wizard-node-layout"><nav aria-label={t(MSG.SCHEDULE_POINTS)}>{nodes.map((node, index) => <button className="secondary compact" type="button" key={index} aria-pressed={selected === index} onClick={() => setSelected(index)}>{t(MSG.POINT) + " "}{index + 1}{typeof node.hour === 'number' ? ` · ${String(node.hour).padStart(2, '0')}:${String(node.minute).padStart(2, '0')}` : ''}</button>)}<button className="secondary compact" type="button" disabled={nodes.length >= rawNodeLimits[spec.key]} onClick={() => { update({ ...model, nodes: [...nodes, defaultObject(schema.nodes as JsonSchema)] }); setSelected(nodes.length); }}>{t(MSG.ADD_POINT)}</button></nav>
        <section aria-label={t(MSG.POINT_SETTINGS)}>{nodes[selected] ? <><h3>{t(MSG.POINT) + " "}{selected + 1}</h3><JsonFields schema={schema.nodes as JsonSchema} value={nodes[selected]} prefix={spec.key + '.nodes.' + selected + '.'} disabled={false} onChange={node => update({ ...model, nodes: nodes.map((current, index) => index === selected ? node : current) })} /><button className="secondary compact" type="button" onClick={() => { update({ ...model, nodes: nodes.filter((_, index) => index !== selected) }); setSelected(Math.max(0, selected - 1)); }}>{t(MSG.DELETE_POINT)}</button></> : <p>{t(MSG.ADD_A_POINT_TO_SET_THE_TIME_AND)}</p>}</section>
      </div>}
      {step === 2 && <section><h3>{t(MSG.REVIEW_SCHEDULE)}</h3><p>{t(MSG.POINTS) + " "}{nodes.length}{t(MSG.ENABLED) + " "}{nodes.filter(node => node.enabled === 'on').length}.</p><ul>{nodes.map((node, index) => <li key={index}>{t(MSG.POINT) + " "}{index + 1} · {node.enabled === 'on' ? t(MSG.ON_FEMININE) : t(MSG.OFF_FEMININE)} · {typeof node.hour === 'number' ? `${String(node.hour).padStart(2, '0')}:${String(node.minute).padStart(2, '0')}` : `${Math.floor(Number(node.start) / 60)}:${String(Number(node.start) % 60).padStart(2, '0')}–${Math.floor(Number(node.end) / 60)}:${String(Number(node.end) % 60).padStart(2, '0')}`}</li>)}</ul><p className="help">{t(MSG.DONE_SENDS_THE_CHANGES_TO_THE_DEVICE)}</p></section>}

    </>}
    <details><summary>{t(MSG.DEVICE_DATA)}</summary><label>{t(MSG.MANUFACTURER_DATA_BASE64)}<textarea value={raw} onChange={event => setRaw(event.target.value)} rows={3} maxLength={22000} /></label><button className="secondary compact" type="button" onClick={() => { try { const next = decodeRawSchedule(spec.key, raw); if (!next) throw new Error(t(MSG.FORMAT_NOT_RECOGNIZED)); update(next); } catch (failure) { setError((failure as Error).message); } }}>{t(MSG.READ_SCHEDULE)}</button><button type="button" className="secondary compact" onClick={() => { try { validateControlValue(spec,raw); onDone(raw); } catch (failure) { setError((failure as Error).message); } }}>{t(MSG.USE_ORIGINAL_DATA)}</button></details>
    {error && <p className="field-error" role="alert">{translateText(error)}</p>}
  </WizardDialog>;
}
