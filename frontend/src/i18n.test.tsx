import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { CloudApi } from './api';
import { cloudCommands, cloudSpec, labelFor, optionLabel } from './controls';
import { LANGUAGE_STORAGE_KEY, dateLocale, detectLocale, getLocale, localizeMessages, savedLocale, setLocale, t } from './i18n';
import english from './i18n/en.json';
import { STORAGE_KEY } from './connection';
import { encodePowerMemory } from './lighting';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});

describe('English and Russian localization', () => {
  it('chooses a supported browser language, honors saved preference and falls back to English', () => {
    expect(detectLocale(['pl-PL','en-US','ru'])).toBe('en');
    expect(detectLocale(['be-BY','ru-RU','en'])).toBe('ru');
    expect(detectLocale(['pl-PL'])).toBe('en');
    localStorage.setItem(LANGUAGE_STORAGE_KEY,'en'); expect(savedLocale()).toBe('en');
    localStorage.setItem(LANGUAGE_STORAGE_KEY,'ru'); expect(savedLocale()).toBe('ru');
    localStorage.setItem(LANGUAGE_STORAGE_KEY,'unsupported');
    expect(['en','ru']).toContain(savedLocale());
  });

  it('switches live without clearing credentials or an unfinished connection form', () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Адрес API'),{target:{value:'http://another-api.test:8080'}});
    fireEvent.change(screen.getByLabelText('Ключ доступа к сервису'),{target:{value:'unsaved-draft'}});
    fireEvent.change(screen.getByLabelText('Язык'),{target:{value:'en'}});
    expect(screen.getByRole('heading',{name:'Connect Tuya'})).toBeInTheDocument();
    expect(screen.getByLabelText('API address')).toHaveValue('http://another-api.test:8080');
    expect(screen.getByLabelText('Service access key')).toHaveValue('unsaved-draft');
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Language'),{target:{value:'ru'}});
    expect(screen.getByRole('heading',{name:'Подключить Tuya'})).toBeInTheDocument();
    expect(screen.getByLabelText('Ключ доступа к сервису')).toHaveValue('unsaved-draft');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('changes date locale, control names, parameterized channels and lazy tables after imports', () => {
    const labels=localizeMessages({title:'Температура',nested:{button:'Сохранить'}});
    act(()=>setLocale('en'));
    expect(dateLocale()).toBe('en-GB'); expect(labels.title).toBe('Temperature'); expect(labels.nested.button).toBe('Save');
    expect(labelFor('switch_2')).toBe('Channel 2');
    const timer=labelFor('countdown_2'); expect(timer).toBe('Channel 2 timer');
    expect(labelFor('basic_private')).toBe('Privacy mode'); expect(optionLabel('on','relay_status')).toBe('On');
    const notice=t('Tuya Developer подключён. Найдено устройств: {0}.',[3]);
    expect(notice).toBe('Tuya Developer connected. Devices found: 3.');
    act(()=>setLocale('ru'));
    expect(t(notice)).toBe('Tuya Developer подключён. Найдено устройств: 3.');
    expect(t(timer)).toBe('Таймер канала 2');
    expect(dateLocale()).toBe('ru-RU'); expect(labels.title).toBe('Температура'); expect(labelFor('basic_private')).toBe('Режим приватности');
    expect(optionLabel('on','relay_status')).toBe('Включено');
    expect(t('Unknown firmware message')).toBe('Unknown firmware message');
    setLocale('en');
    for(const text of ['constructor','toString','__proto__']) expect(t(text)).toBe(text);
  });

  it('never translates device identifiers, enum wire values, payloads or binary light settings', async () => {
    const definition={code:'work_mode',type:'Enum',values:{range:['white','colour','scene','music']}};
    const definitions={device_id:'Устройство-Łąka',functions:[definition]};
    const memory={mode:2,h:120,s:500,v:800,bright:650,temperature:200};
    const original=encodePowerMemory(memory);
    const outputs=[];
    vi.mocked(fetch).mockImplementation(async()=>json({acknowledged:true}));
    for(const locale of ['en','ru'] as const){
      setLocale(locale);
      outputs.push(cloudCommands(cloudSpec(definition,true),'white',definitions));
      expect(encodePowerMemory(memory)).toBe(original);
      await new CloudApi({baseUrl:'http://api.test',token:'existing-test-token'}).sendDeviceCommands('Устройство-Łąka', 'sharing', outputs.at(-1)!);
    }
    expect(outputs[0]).toEqual(outputs[1]);
    const calls=vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe(calls[1][0]); expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
    expect(calls[0][1]?.headers).toEqual(calls[1][1]?.headers);
  });

  it('translates known server errors and preserves unknown upstream messages', async () => {
    setLocale('en');
    const api=new CloudApi({baseUrl:'http://api.test',token:'test-token'});
    vi.mocked(fetch).mockImplementation(async()=>json({detail:'Выбранная сеть больше недоступна. Обновите список сетей.'},409));
    await expect(api.status()).rejects.toThrow('The selected network is no longer available. Refresh the network list.');
    vi.mocked(fetch).mockImplementation(async()=>json({detail:'Firmware-specific response X7'},502));
    await expect(api.status()).rejects.toThrow('Firmware-specific response X7');
  });

  it('keeps switching usable if preference storage is blocked', () => {
    const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked')});
    try { expect(()=>setLocale('en')).not.toThrow(); expect(getLocale()).toBe('en'); expect(t('Сохранить')).toBe('Save'); }
    finally {spy.mockRestore();}
  });

  it('updates another open tab from the saved language preference', () => {
    render(<App/>);
    act(()=>window.dispatchEvent(new StorageEvent('storage',{key:LANGUAGE_STORAGE_KEY,newValue:'en'})));
    expect(screen.getByRole('heading',{name:'Connect Tuya'})).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('covers source message keys in every application screen', () => {
    const files=import.meta.glob<string>(['./*.ts','./*.tsx','./components/*.tsx','!./*.test.ts','!./*.test.tsx'],{eager:true,query:'?raw',import:'default'});
    const catalog:Record<string,string>=english;
    for(const [file,source] of Object.entries(files)){
      for(const match of source.matchAll(/\bt\(("(?:\\.|[^"\\])*")/g)){
        if(!match[1])continue;
        const message=JSON.parse(match[1]) as string;
        if(/[А-Яа-яЁё]/.test(message))expect(catalog[message],file+': '+message).toBeTypeOf('string');
      }
    }
  });

  it('has complete nonempty English messages and preserves every interpolation placeholder', () => {
    for(const [source,value] of Object.entries(english)){
      expect(value.trim(),source).not.toBe('');
      expect(value,source).not.toMatch(/[А-Яа-яЁё]/);
      expect([...value.matchAll(/\{\d+\}/g)].map(x=>x[0]).sort(),source).toEqual([...source.matchAll(/\{\d+\}/g)].map(x=>x[0]).sort());
    }
  });
});
