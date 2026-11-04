import { localizeMessages, t } from "../i18n";
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
  rhythm_mode: 'Меняйте свет в течение дня: задайте дни недели и точки с нужным временем, цветом и яркостью. Лампа выполняет сохранённое расписание.',
  random_timing: 'Задайте интервалы, в которых свет будет включаться и выключаться случайным образом. Это помогает создать видимость присутствия дома.',
  wakeup_mode: 'Свет постепенно усиливается к пробуждению. Выберите дни, время, длительность перехода и конечную яркость.',
  sleep_mode: 'Свет постепенно приглушается перед сном. Выберите дни, время начала и длительность перехода.',
});
export const hasScheduleWizard = (spec: ControlSpec) => spec.kind === 'raw' && !!rawSchemas[spec.key];
export function scheduleSummary(code: string, value: string) {
  const model = decodeRawSchedule(code, value);
  return model ? t("Точек: {0}", [(model.nodes as JsonValue[]).length]) : t("Не настроено или иной формат");
}

export function ScheduleWizard({ spec, value, onDone, onClose }: { spec: ControlSpec; value: string; onDone: (value: string) => void; onClose: () => void }) {
  const [model, setModel] = useState(() => decodeRawSchedule(spec.key, value));
  const [step, setStep] = useState(0), [selected, setSelected] = useState(0), [error, setError] = useState('');
  const [raw, setRaw] = useState(value);
  const schema = rawSchemas[spec.key];
  const nodes = (model?.nodes || []) as Record<string, JsonValue>[];
  const general = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'nodes')) as JsonSchema;
  const update = (next: Record<string, JsonValue>) => { setModel(next); setError(''); };
  const validate = () => { try { if (!model) throw new Error(t("Создайте расписание или оставьте исходные данные без изменений.")); return encodeRawSchedule(spec.key, model); } catch (failure) { setError(failure instanceof Error ? failure.message : t("Проверьте расписание.")); } };
  return <WizardDialog title={spec.label} description={descriptions[spec.key]} onClose={onClose} actions={model && <>
    {step > 0 && <button className="secondary" type="button" onClick={() => { setStep(step - 1); setError(''); }}>{t("Назад")}</button>}
    <button type="button" onClick={() => { const encoded = validate(); if (encoded === undefined) return; if (step < 2) setStep(step + 1); else onDone(encoded); }}>{step < 2 ? t("Далее") : t("Готово")}</button>
  </>}>
    <ol className="wizard-steps" aria-label={t("Этапы настройки")}>{[t("Повторение"), t("Точки расписания"), t("Проверка")].map((title, index) => <li key={title} aria-current={step === index ? 'step' : undefined}>{index + 1}. {title}</li>)}</ol>
    {!model ? <div className="empty-state"><p>{t("Текущее значение не распознано как расписание стандартного формата. Исходные данные сохранены.")}</p><button type="button" onClick={() => update(defaultSchedule(spec.key))}>{t("Новое расписание")}</button></div> : <>
      {step === 0 && <div><h3>{t("Когда выполнять")}</h3><p className="help">{t("Без выбранных дней точка выполняется однократно. Отключённые точки сохраняются, но не выполняются.")}</p>{Object.keys(general).length ? <JsonFields schema={general} value={model} prefix={spec.key + '.'} disabled={false} onChange={update} /> : <p>{t("Дни недели и включение задаются отдельно для каждой точки на следующем этапе.")}</p>}</div>}
      {step === 1 && <div className="wizard-node-layout"><nav aria-label={t("Точки расписания")}>{nodes.map((node, index) => <button className="secondary compact" type="button" key={index} aria-pressed={selected === index} onClick={() => setSelected(index)}>{t("Точка") + " "}{index + 1}{typeof node.hour === 'number' ? ` · ${String(node.hour).padStart(2, '0')}:${String(node.minute).padStart(2, '0')}` : ''}</button>)}<button className="secondary compact" type="button" disabled={nodes.length >= rawNodeLimits[spec.key]} onClick={() => { update({ ...model, nodes: [...nodes, defaultObject(schema.nodes as JsonSchema)] }); setSelected(nodes.length); }}>{t("Добавить точку")}</button></nav>
        <section aria-label={t("Настройки точки")}>{nodes[selected] ? <><h3>{t("Точка") + " "}{selected + 1}</h3><JsonFields schema={schema.nodes as JsonSchema} value={nodes[selected]} prefix={spec.key + '.nodes.' + selected + '.'} disabled={false} onChange={node => update({ ...model, nodes: nodes.map((current, index) => index === selected ? node : current) })} /><button className="secondary compact" type="button" onClick={() => { update({ ...model, nodes: nodes.filter((_, index) => index !== selected) }); setSelected(Math.max(0, selected - 1)); }}>{t("Удалить точку")}</button></> : <p>{t("Добавьте точку, чтобы задать время и свет.")}</p>}</section>
      </div>}
      {step === 2 && <section><h3>{t("Проверьте расписание")}</h3><p>{t("Точек:") + " "}{nodes.length}{t(". Включено:") + " "}{nodes.filter(node => node.enabled === 'on').length}.</p><ul>{nodes.map((node, index) => <li key={index}>{t("Точка") + " "}{index + 1} · {node.enabled === 'on' ? t("Включена") : t("Выключена")} · {typeof node.hour === 'number' ? `${String(node.hour).padStart(2, '0')}:${String(node.minute).padStart(2, '0')}` : `${Math.floor(Number(node.start) / 60)}:${String(Number(node.start) % 60).padStart(2, '0')}–${Math.floor(Number(node.end) / 60)}:${String(Number(node.end) % 60).padStart(2, '0')}`}</li>)}</ul><p className="help">{t("«Готово» отправит изменения устройству. «Отмена» сохранит прежние настройки.")}</p></section>}

    </>}
    <details><summary>{t("Данные устройства")}</summary><label>{t("Данные производителя (base64)")}<textarea value={raw} onChange={event => setRaw(event.target.value)} rows={3} maxLength={22000} /></label><button className="secondary compact" type="button" onClick={() => { try { const next = decodeRawSchedule(spec.key, raw); if (!next) throw new Error(t("Формат не распознан. Исходные данные не изменены.")); update(next); } catch (failure) { setError((failure as Error).message); } }}>{t("Прочитать расписание")}</button><button type="button" className="secondary compact" onClick={() => { try { validateControlValue(spec,raw); onDone(raw); } catch (failure) { setError((failure as Error).message); } }}>{t("Использовать исходные данные")}</button></details>
    {error && <p className="field-error" role="alert">{t(error)}</p>}
  </WizardDialog>;
}
