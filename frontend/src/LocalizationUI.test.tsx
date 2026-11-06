import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloudControl } from './components/CloudControl';
import { CloudApi } from './api';
import { LanguageSelector } from './components/LanguageSelector';
import { MSG, LANGUAGES, setLocale, t, useLocale } from './i18n';
import { setTheme } from './theme';

const device={id:'room-lamp',name:'Лампа Łąka',online:true,has_local_key:false};
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200});
function Harness(){
  useLocale();
  return <><LanguageSelector/><CloudControl api={api} device={device} provider="sharing" onClose={vi.fn()} onAuthError={vi.fn()}/></>;
}
const api=new CloudApi({baseUrl:'http://localization-api.test',token:'fixture-key'});

describe('localized device controls',()=>{
  it('switches language and theme without resetting an edit or changing its automatic command',async()=>{
    const writes:unknown[]=[];
    const functions=[{code:'switch_led',type:'Boolean',values:'{}'},{code:'bright_value_v2',type:'Integer',values:{min:10,max:1000,step:1}}];
    vi.mocked(fetch).mockImplementation(async(input,init)=>{
      if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return json({acknowledged:true});}
      if(String(input).includes('/functions'))return json({device_id:device.id,functions});
      return json({device_id:device.id,online:true,source:'cloud',status:{switch_led:true,bright_value_v2:500}});
    });
    setLocale('en');render(<Harness/>);
    const brightness=await screen.findByRole('spinbutton',{name:'Brightness (%)'});
    await waitFor(()=>expect(brightness).toBeEnabled());
    await waitFor(()=>expect(brightness).toHaveValue(50));
    fireEvent.change(brightness,{target:{value:'78'}});
    expect(screen.getByRole('dialog',{name:'Лампа Łąka'})).toBeInTheDocument();
    for (const choice of ['dark','day','system'] as const) {
      act(()=>setTheme(choice));
      expect(brightness).toHaveValue(78);
      expect(writes).toEqual([]);
    }
    for (const language of LANGUAGES) {
      act(()=>setLocale(language.value));
      expect(screen.getByRole('spinbutton',{name:t(MSG.BRIGHTNESS)+' (%)'})).toBe(brightness);
      expect(brightness).toHaveValue(78);
      expect(screen.getByRole('dialog',{name:'Лампа Łąka'})).toBeInTheDocument();
      expect(writes).toEqual([]);
    }
    act(()=>setLocale('en'));
    expect(screen.getByRole('spinbutton',{name:'Brightness (%)'})).toHaveValue(78);
    expect(screen.queryByRole('button',{name:'Apply'})).toBeNull();
    await waitFor(()=>expect(writes).toEqual([{commands:[{code:'bright_value_v2',value:780}]}]));
  });
});
