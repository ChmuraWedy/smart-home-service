import { MSG, t } from "./i18n";
import type { JsonValue } from './api';
import { defaultObject, rawBytes, validateObject } from './lighting';
import type { JsonSchema } from './lighting';

const number = (min:number,max:number) => ({min,max,step:1});
const on = {range:['off','on']};
const color = { h:number(0,360),s:number(0,100),v:number(1,100),bright:number(0,100),temperature:number(0,100) };
const clock = { hour:number(0,23),minute:number(0,59) };
const days = number(0,127);
const sleep = {enabled:on,days,duration:number(1,24),...clock,...color};
export const rawSchemas:Record<string,JsonSchema> = {
  rhythm_mode:{enabled:on,mode:number(0,255),days,nodes:{enabled:on,...clock,...color}},
  sleep_mode:{nodes:sleep}, wakeup_mode:{nodes:{...sleep,hold:number(0,24)}},
  random_timing:{nodes:{enabled:on,channels:number(1,127),days,start:number(0,1439),end:number(0,1439),...color,v:number(0,100)}},
};
export const rawNodeLimits:Record<string,number> = {rhythm_mode:8,sleep_mode:4,wakeup_mode:4,random_timing:21};
type Model = Record<string,JsonValue>;
const enabled = (v:JsonValue) => v === 'on' ? 1 : 0;

export function decodeRawSchedule(code:string,value:string):Model|undefined {
  try {
    const bytes = rawBytes(value), schema = rawSchemas[code];
    if (!schema || bytes[0] !== 0) return;
    let i=1;
    const u8 = () => { if (i >= bytes.length) throw new Error(); return bytes[i++]; };
    const u16 = () => (u8()<<8)|u8();
    const flag = () => { const v=u8(); if (v>1) throw new Error(); return v ? 'on' : 'off'; };
    const colors = () => ({h:u16(),s:u8(),v:u8(),bright:u8(),temperature:u8()});
    const model:Model={nodes:[]}, nodes:Model[]=[];
    let count:number;
    if (code === 'rhythm_mode') {
      model.enabled=flag(); model.mode=u8(); model.days=u8(); count=u8();
    } else if (code === 'random_timing') {
      if (u8() !== 12 || (bytes.length-2)%12) return;
      count=(bytes.length-2)/12;
    } else count=u8();
    if (count>rawNodeLimits[code]) return;
    for(let n=0;n<count;n++) {
      if (code === 'rhythm_mode') nodes.push({enabled:flag(),hour:u8(),minute:u8(),...colors()});
      else if(code === 'random_timing') {
        const mask=u8(); nodes.push({enabled:mask&1?'on':'off',channels:mask>>1,days:u8(),start:u16(),end:u16(),...colors()});
      } else {
        const node:Model={enabled:flag(),days:u8(),duration:u8(),hour:u8(),minute:u8(),...colors()};
        if(code === 'wakeup_mode') node.hold=u8();
        nodes.push(node);
      }
    }
    if(i !== bytes.length) return;
    model.nodes=nodes; validateSchedule(code,model);
    return model;
  } catch { return; }
}

export function defaultSchedule(code:string):Model {
  const schema=rawSchemas[code];
  if(!schema) throw new Error(t(MSG.UNKNOWN_SCHEDULE_FORMAT));
  const model=defaultObject(schema);
  if(code === 'random_timing') (model.nodes as Model[])[0].end=1439;
  return model;
}
function validateSchedule(code:string,value:Model) {
  const schema=rawSchemas[code];
  if(!schema) throw new Error(t(MSG.UNKNOWN_SCHEDULE_FORMAT));
  validateObject(value,schema);
  if((value.nodes as JsonValue[]).length>rawNodeLimits[code]) throw new Error(t(MSG.TOO_MANY_SCHEDULE_POINTS));
  if(code==='rhythm_mode' && Number(value.mode)>0 && Number(value.mode)<15) throw new Error(t(MSG.TRANSITION_0_AUTO_OR_AT_LEAST_15_MINUTES));
}
export function encodeRawSchedule(code:string,value:Model):string {
  validateSchedule(code,value);
  const bytes:number[]=[0], nodes=value.nodes as Model[];
  const u8 = (v:JsonValue) => bytes.push(Number(v));
  const u16 = (v:JsonValue) => bytes.push(Number(v)>>8,Number(v)&255);
  const colors = (v:Model) => {u16(v.h); u8(v.s); u8(v.v);u8(v.bright);u8(v.temperature);};
  if(code==='rhythm_mode') bytes.push(enabled(value.enabled),Number(value.mode),Number(value.days),nodes.length);
  else bytes.push(code==='random_timing'?12:nodes.length);
  for(const node of nodes) {
    if(code==='rhythm_mode') {bytes.push(enabled(node.enabled),Number(node.hour),Number(node.minute));colors(node);}
    else if(code==='random_timing') {bytes.push((Number(node.channels)<<1)|enabled(node.enabled),Number(node.days));u16(node.start);u16(node.end);colors(node);}
    else {bytes.push(enabled(node.enabled),Number(node.days),Number(node.duration),Number(node.hour),Number(node.minute));colors(node);if(code==='wakeup_mode')u8(node.hold);}
  }
  return btoa(String.fromCharCode(...bytes));
}
