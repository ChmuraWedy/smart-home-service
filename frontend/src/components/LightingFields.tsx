import { useEffect, useState } from 'react';
import type { JsonValue } from '../api';
import { defaultObject, decodePowerMemory, encodePowerMemory } from '../lighting';
import type { JsonSchema } from '../lighting';
import { hexToHsv, hsvToHex } from '../controls';
import { decodeRawSchedule, defaultSchedule, encodeRawSchedule, rawSchemas, rawNodeLimits } from '../raw-lighting';

const labels: Record<string,string> = { change_mode:'Переход', h:'Тон', s:'Насыщенность', v:'Яркость цвета', bright:'Яркость белого света', temperature:'Температура белого света', scene_num:'Номер эффекта', unit_change_mode:'Переход', unit_switch_duration:'Длительность шага', unit_gradient_duration:'Длительность перехода', enabled:'Включено',hour:'Час',minute:'Минута',mode:'Переход (минуты; 0 — авто)' };
const choices: Record<string,string> = { direct:'Сразу', gradient:'Плавно', static:'Без перехода', jump:'Сразу',on:'Вкл',off:'Выкл' };

export function JsonFields({ schema, value, disabled, onChange, prefix = '', nodeLimit = 32 }: { schema: JsonSchema; value: Record<string,JsonValue>; disabled: boolean; onChange: (value: Record<string,JsonValue>) => void; prefix?: string; nodeLimit?: number }) {
  value = { ...defaultObject(schema), ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) };
  const set = (key: string, v: JsonValue) => onChange({ ...value, [key]: v });
  const hsv = ['h','s','v'].every(k => typeof value[k] === 'number' && typeof schema[k]?.max === 'number');
  return <div className="structured-fields">
    {hsv && <label>Выбор цвета<input type="color" disabled={disabled} value={hsvToHex({ h:Number(value.h), s:Number(value.s)*1000/Number(schema.s.max), v:Number(value.v)*1000/Number(schema.v.max) })} onChange={e => {
      const color = hexToHsv(e.target.value);
      onChange({ ...value, h:color.h, s:Math.round(color.s*Number(schema.s.max)/1000), v:Math.round(color.v*Number(schema.v.max)/1000) });
    }} /></label>}
    {Object.entries(schema).map(([key, rule]) => {
      const label = labels[key] || key.replaceAll('_',' '), id = prefix + key;
      if (key === 'days' || key === 'channels') {
        const names = key === 'days' ? ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'] : ['1','2','3','4','5','6','7'];
        return <fieldset key={key}><legend>{key === 'days' ? 'Дни недели' : 'Каналы'}</legend><div className="mask-choices">{names.map((name,index) => <label key={name}><input type="checkbox" disabled={disabled} checked={Boolean(Number(value[key]) & (1<<index))} onChange={e => set(key,e.target.checked ? Number(value[key])|(1<<index) : Number(value[key])&~(1<<index))} />{name}</label>)}</div>{key === 'days' && <p className="help">Без выбранных дней — однократно.</p>}</fieldset>;
      }
      if (key === 'start' || key === 'end') return <label key={key}>{key === 'start' ? 'Начало' : 'Конец'}<input type="time" required disabled={disabled} value={value[key] === null ? '' : `${String(Math.floor(Number(value[key])/60)).padStart(2,'0')}:${String(Number(value[key])%60).padStart(2,'0')}`} onChange={e => { const [h,m]=e.target.value.split(':').map(Number); set(key,e.target.value ? h*60+m : null); }} /></label>;
      if (key === 'duration' || key === 'hold') return <label key={key}>{key === 'duration' ? 'Переход, минуты' : 'Светить после пробуждения, минуты'}<input type="number" min={Number(rule.min)*5} max={Number(rule.max)*5} step={5} disabled={disabled} value={value[key] === null ? '' : Number(value[key])*5} onChange={e => set(key,e.target.value === '' ? null : Number(e.target.value)/5)} />{key === 'hold' && <span className="help">0 — оставить свет включённым.</span>}</label>;
      if (Array.isArray(rule.range)) return <label key={key}>{label}<select aria-label={id} disabled={disabled} value={String(value[key])} onChange={e => set(key,e.target.value)}>{rule.range.map(v => <option key={v} value={v}>{choices[v] || v}</option>)}</select></label>;
      if (typeof rule.min === 'number' && typeof rule.max === 'number') return <label key={key}>{label}<input aria-label={id} type="number" min={rule.min} max={rule.max} step={Number(rule.step || 1)} disabled={disabled} value={value[key] === null ? '' : Number(value[key])} onChange={e => set(key,e.target.value === '' ? null : Number(e.target.value))} /><span className="help">{rule.min}–{rule.max}</span></label>;
      if (key === 'scene_units' || key === 'nodes') {
        const units = Array.isArray(value[key]) ? value[key] : [];
        return <fieldset key={key}><legend>{key === 'nodes' ? 'Точки расписания' : 'Шаги эффекта'}</legend>{units.map((unit,index) => <fieldset key={index}><legend>Шаг {index+1}</legend>
          <JsonFields schema={rule as JsonSchema} value={unit as Record<string,JsonValue>} disabled={disabled} prefix={id + '.' + index + '.'} onChange={v => set(key,units.map((u,i) => i === index ? v : u))} />
          <button type="button" className="secondary compact" disabled={disabled || (key === 'scene_units' && units.length <= 1)} onClick={() => set(key,units.filter((_,i) => i !== index))}>Удалить шаг {index+1}</button>
        </fieldset>)}<button type="button" className="secondary compact" disabled={disabled || units.length >= nodeLimit} onClick={() => set(key,[...units,defaultObject(rule as JsonSchema)])}>Добавить шаг</button></fieldset>;
      }
      return <fieldset key={key}><legend>{label}</legend><JsonFields schema={rule as JsonSchema} value={value[key] as Record<string,JsonValue>} disabled={disabled} prefix={id+'.'} onChange={v => set(key,v)} /></fieldset>;
    })}
  </div>;
}

export function RawScheduleFields({ code, value, disabled, onChange, onInvalid }: { code:string; value:string; disabled:boolean; onChange:(v:string)=>void; onInvalid:(v:string)=>void }) {
  const [model,setModel] = useState(() => decodeRawSchedule(code,value));
  useEffect(() => { setModel(decodeRawSchedule(code,value)); }, [code,value]);
  if(!rawSchemas[code]) return null;
  const change = (next:Record<string,JsonValue>) => {
    setModel(next);
    try { onChange(encodeRawSchedule(code,next)); }
    catch(error) { onInvalid(error instanceof Error ? error.message : 'Некорректное расписание.'); }
  };
  return <div>
    <p className="help">Редактор стандартного формата Tuya v0. Другие версии сохраняются исходными данными; новое расписание заменяет значение этого параметра.</p>
    {model ? <JsonFields schema={rawSchemas[code]} value={model} prefix={code+'.'} disabled={disabled} onChange={change} nodeLimit={rawNodeLimits[code]} /> : <p className="help">Для текущего значения составной редактор недоступен. Можно подготовить новое расписание стандартного формата.</p>}
    <button className="secondary compact" type="button" disabled={disabled} onClick={() => change(defaultSchedule(code))}>Новое расписание</button>
  </div>;
}

export function PowerMemoryFields({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v:string) => void }) {
  const memory = decodePowerMemory(value);
  if (!memory) return null;
  return <div className="structured-fields"><label>После включения питания<select disabled={disabled} value={memory.mode} onChange={e => onChange(encodePowerMemory({ ...memory, mode:Number(e.target.value) }))}>
    <option value={0}>Настройки производителя</option><option value={1}>Последнее состояние</option><option value={2}>Заданное состояние</option>
  </select></label>{memory.mode === 2 && <JsonFields schema={{h:{min:0,max:360},s:{min:0,max:1000},v:{min:0,max:1000},bright:{min:0,max:1000},temperature:{min:0,max:1000}}} value={memory} disabled={disabled} onChange={v => {
    const bounded = Object.fromEntries(['h','s','v','bright','temperature'].map(key => [key,Math.min(key === 'h' ? 360 : 1000,Math.max(0,Math.round(Number(v[key]) || 0)))]));
    onChange(encodePowerMemory({ ...memory, ...bounded }));
  }} />}</div>;
}
