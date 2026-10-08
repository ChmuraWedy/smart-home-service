import { describe,expect,it } from 'vitest';
import { decodePowerMemory,encodePowerMemory,rawBytes } from './lighting';
import { cloudCommands,cloudSpec } from './controls';
import { decodeRawSchedule,encodeRawSchedule } from './raw-lighting';

const base64 = (bytes:number[]) => btoa(String.fromCharCode(...bytes));
const colors = {h:120,s:100,v:50,bright:60,temperature:70};

describe('Tuya lighting payloads', () => {
  it.each([
    ['sleep_mode',[0,1,1,62,6,21,30,0,120,100,50,60,70],{nodes:[{enabled:'on',days:62,duration:6,hour:21,minute:30,...colors}]}],
    ['wakeup_mode',[0,1,1,62,6,21,30,0,120,100,50,60,70,4],{nodes:[{enabled:'on',days:62,duration:6,hour:21,minute:30,...colors,hold:4}]}],
    ['rhythm_mode',[0,1,15,62,1,1,7,30,0,180,75,100,80,25],{enabled:'on',mode:15,days:62,nodes:[{enabled:'on',hour:7,minute:30,h:180,s:75,v:100,bright:80,temperature:25}]}],
    ['random_timing',[0,12,3,62,1,224,4,236,0,240,100,100,0,0],{nodes:[{enabled:'on',channels:1,days:62,start:480,end:1260,h:240,s:100,v:100,bright:0,temperature:0}]}],
  ] as const)('uses the documented v0 byte layout for %s', (code,bytes,model) => {
    const payload=base64([...bytes]);
    expect(decodeRawSchedule(code,payload)).toEqual(model);
    expect(encodeRawSchedule(code,JSON.parse(JSON.stringify(model)))).toBe(payload);
  });
  it('preserves captured empty formats and declines padding, unknown versions and malformed values', () => {
    for(const [code,payload] of [['rhythm_mode','AAAAAAA='],['random_timing','AAw='],['sleep_mode','AAA='],['wakeup_mode','AAA=']]) {
      const model=decodeRawSchedule(code,payload)!;
      expect(model.nodes).toEqual([]);
      expect(encodeRawSchedule(code,model)).toBe(payload);
    }
    expect(decodeRawSchedule('sleep_mode','AAAA')).toBeUndefined();
    expect(decodeRawSchedule('wakeup_mode','AAAA')).toBeUndefined();
    expect(decodeRawSchedule('rhythm_mode',base64([1,0,0,0,0]))).toBeUndefined();
    expect(decodeRawSchedule('random_timing',base64([0,11]))).toBeUndefined();
    expect(() => rawBytes('invalid!')).toThrow();
    expect(() => rawBytes('AAAA',2)).toThrow();
  });
  it('decodes captured power memory and uses big-endian custom HSV fields', () => {
    expect(decodePowerMemory('AAEAAAAAAAAAAAAA')).toEqual({mode:1,h:0,s:0,v:0,bright:0,temperature:0});
    const custom={mode:2,h:300,s:1000,v:500,bright:700,temperature:800};
    const bytes=[0,2,1,44,3,232,1,244,2,188,3,32];
    expect(encodePowerMemory(custom)).toBe(base64(bytes));
    expect(decodePowerMemory(base64(bytes))).toEqual(custom);
    expect(decodePowerMemory(base64([1,...bytes.slice(1)]))).toBeUndefined();
  });
  it('validates advertised effect ranges and enters music mode only when supported', () => {
    const schema={change_mode:{range:['direct','gradient']},bright:{min:0,max:1000},temperature:{min:0,max:1000},h:{min:0,max:360},s:{min:0,max:255},v:{min:0,max:255}};
    const effect={code:'music_data',type:'Json',values:schema}, spec=cloudSpec(effect,true);
    const payload={change_mode:'gradient',bright:0,temperature:0,h:120,s:255,v:255};
    expect(cloudCommands(spec,payload,{device_id:'lamp',functions:[effect,{code:'work_mode',type:'Enum',values:{range:['white','music']}}]})).toEqual([{code:'work_mode',value:'music'},{code:'music_data',value:payload}]);
    expect(() => cloudCommands(spec,{...payload,s:1000},{device_id:'lamp',functions:[effect]})).toThrow('диапазона');
    expect(cloudCommands(spec,payload,{device_id:'lamp',functions:[effect]})).toEqual([{code:'music_data',value:payload}]);
  });
});
