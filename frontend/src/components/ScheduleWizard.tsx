import { useEffect, useRef, useState } from 'react';
import type { JsonValue } from '../api';
import type { ControlSpec } from '../controls';
import { validateControlValue } from '../controls';
import { defaultObject } from '../lighting';
import type { JsonSchema } from '../lighting';
import { decodeRawSchedule, defaultSchedule, encodeRawSchedule, rawNodeLimits, rawSchemas } from '../raw-lighting';
import { JsonFields } from './LightingFields';

const descriptions: Record<string, string> = {
  rhythm_mode: 'Меняйте свет в течение дня: задайте дни недели и точки с нужным временем, цветом и яркостью. Лампа выполняет сохранённое расписание.',
  random_timing: 'Задайте интервалы, в которых свет будет включаться и выключаться случайным образом. Это помогает создать видимость присутствия дома.',
  wakeup_mode: 'Свет постепенно усиливается к пробуждению. Выберите дни, время, длительность перехода и конечную яркость.',
  sleep_mode: 'Свет постепенно приглушается перед сном. Выберите дни, время начала и длительность перехода.',
};
export const hasScheduleWizard = (spec: ControlSpec) => spec.kind === 'raw' && !!rawSchemas[spec.key];
export function scheduleSummary(code: string, value: string) {
  const model = decodeRawSchedule(code, value);
  return model ? `Точек: ${(model.nodes as JsonValue[]).length}` : 'Не настроено или иной формат';
}

export function ScheduleWizard({ spec, value, onDone, onClose }: { spec: ControlSpec; value: string; onDone: (value: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [model, setModel] = useState(() => decodeRawSchedule(spec.key, value));
  const [step, setStep] = useState(0), [selected, setSelected] = useState(0), [error, setError] = useState('');
  const [raw, setRaw] = useState(value);
  const schema = rawSchemas[spec.key];
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current!.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
  const nodes = (model?.nodes || []) as Record<string, JsonValue>[];
  const general = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'nodes')) as JsonSchema;
  const update = (next: Record<string, JsonValue>) => { setModel(next); setError(''); };
  const validate = () => { try { if (!model) throw new Error('Создайте расписание или оставьте исходные данные без изменений.'); return encodeRawSchedule(spec.key, model); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Проверьте расписание.'); } };
  return <dialog ref={dialog} className="schedule-wizard control-dialog" aria-label={'Настройка: ' + spec.label} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header className="control-header"><h2>{spec.label}</h2><button type="button" className="secondary compact" onClick={onClose}>Отмена</button></header>
    <p className="wizard-description">{descriptions[spec.key]}</p>
    <ol className="wizard-steps" aria-label="Этапы настройки">{['Повторение', 'Точки расписания', 'Проверка'].map((title, index) => <li key={title} aria-current={step === index ? 'step' : undefined}>{index + 1}. {title}</li>)}</ol>
    {!model ? <div className="empty-state"><p>Текущее значение не распознано как расписание стандартного формата. Исходные данные сохранены.</p><button type="button" onClick={() => update(defaultSchedule(spec.key))}>Новое расписание</button></div> : <>
      {step === 0 && <div><h3>Когда выполнять</h3><p className="help">Без выбранных дней точка выполняется однократно. Отключённые точки сохраняются, но не выполняются.</p>{Object.keys(general).length ? <JsonFields schema={general} value={model} prefix={spec.key + '.'} disabled={false} onChange={update} /> : <p>Дни недели и включение задаются отдельно для каждой точки на следующем этапе.</p>}</div>}
      {step === 1 && <div className="wizard-node-layout"><nav aria-label="Точки расписания">{nodes.map((node, index) => <button className="secondary compact" type="button" key={index} aria-pressed={selected === index} onClick={() => setSelected(index)}>Точка {index + 1}{typeof node.hour === 'number' ? ` · ${String(node.hour).padStart(2, '0')}:${String(node.minute).padStart(2, '0')}` : ''}</button>)}<button className="secondary compact" type="button" disabled={nodes.length >= rawNodeLimits[spec.key]} onClick={() => { update({ ...model, nodes: [...nodes, defaultObject(schema.nodes as JsonSchema)] }); setSelected(nodes.length); }}>Добавить точку</button></nav>
        <section aria-label="Настройки точки">{nodes[selected] ? <><h3>Точка {selected + 1}</h3><JsonFields schema={schema.nodes as JsonSchema} value={nodes[selected]} prefix={spec.key + '.nodes.' + selected + '.'} disabled={false} onChange={node => update({ ...model, nodes: nodes.map((current, index) => index === selected ? node : current) })} /><button className="secondary compact" type="button" onClick={() => { update({ ...model, nodes: nodes.filter((_, index) => index !== selected) }); setSelected(Math.max(0, selected - 1)); }}>Удалить точку</button></> : <p>Добавьте точку, чтобы задать время и свет.</p>}</section>
      </div>}
      {step === 2 && <section><h3>Проверьте расписание</h3><p>Точек: {nodes.length}. Включено: {nodes.filter(node => node.enabled === 'on').length}.</p><ul>{nodes.map((node, index) => <li key={index}>Точка {index + 1} · {node.enabled === 'on' ? 'Включена' : 'Выключена'} · {typeof node.hour === 'number' ? `${String(node.hour).padStart(2, '0')}:${String(node.minute).padStart(2, '0')}` : `${Math.floor(Number(node.start) / 60)}:${String(Number(node.start) % 60).padStart(2, '0')}–${Math.floor(Number(node.end) / 60)}:${String(Number(node.end) % 60).padStart(2, '0')}`}</li>)}</ul><p className="help">«Готово» вернёт изменения в карточку. Чтобы отправить их устройству, нажмите общую кнопку «Применить».</p></section>}
      <footer className="wizard-actions">{step > 0 && <button className="secondary" type="button" onClick={() => { setStep(step - 1); setError(''); }}>Назад</button>}<button type="button" onClick={() => { const encoded = validate(); if (encoded === undefined) return; if (step < 2) setStep(step + 1); else onDone(encoded); }}>{step < 2 ? 'Далее' : 'Готово'}</button></footer>
    </>}
    <details><summary>Данные устройства</summary><label>Данные производителя (base64)<textarea value={raw} onChange={event => setRaw(event.target.value)} rows={3} maxLength={22000} /></label><button className="secondary compact" type="button" onClick={() => { try { const next = decodeRawSchedule(spec.key, raw); if (!next) throw new Error('Формат не распознан. Исходные данные не изменены.'); update(next); } catch (failure) { setError((failure as Error).message); } }}>Прочитать расписание</button><button type="button" className="secondary compact" onClick={() => { try { validateControlValue(spec,raw); onDone(raw); } catch (failure) { setError((failure as Error).message); } }}>Использовать исходные данные</button></details>
    {error && <p className="field-error" role="alert">{error}</p>}
  </dialog>;
}
