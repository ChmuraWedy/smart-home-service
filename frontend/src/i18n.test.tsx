import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { CloudApi } from './api';
import { cloudCommands, cloudSpec, labelFor, optionLabel } from './controls';
import { LANGUAGE_STORAGE_KEY, LANGUAGES, dateLocale, detectLocale, getLocale, localizeMessages, savedLocale, setLocale, t } from './i18n';
import english from './i18n/en.json';
import polish from './i18n/pl.json';
import belarusian from './i18n/be.json';
import { STORAGE_KEY } from './connection';
import { encodePowerMemory } from './lighting';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});

describe('Interface localization', () => {
  it('chooses a supported browser language, honors saved preference and falls back to English', () => {
    expect(detectLocale(['pl-PL','en-US','ru'])).toBe('pl');
    expect(detectLocale(['de-DE','PL-pl','ru'])).toBe('pl');
    expect(detectLocale(['be-BY','ru-RU','en'])).toBe('be');
    expect(detectLocale(['de-DE','BE-by','en'])).toBe('be');
    expect(detectLocale(['de-DE'])).toBe('en');
    for (const {value} of LANGUAGES) {
      localStorage.setItem(LANGUAGE_STORAGE_KEY,value); expect(savedLocale()).toBe(value);
    }
    localStorage.setItem(LANGUAGE_STORAGE_KEY,'unsupported');
    expect(LANGUAGES.map(language=>language.value)).toContain(savedLocale());
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
    for(const {value: locale} of LANGUAGES){
      setLocale(locale);
      outputs.push(cloudCommands(cloudSpec(definition,true),'white',definitions));
      expect(encodePowerMemory(memory)).toBe(original);
      await new CloudApi({baseUrl:'http://api.test',token:'existing-test-token'}).sendDeviceCommands('Устройство-Łąka', 'sharing', outputs.at(-1)!);
    }
    for (const output of outputs) expect(output).toEqual(outputs[0]);
    const calls=vi.mocked(fetch).mock.calls;
    for (const call of calls) {
      expect(call[0]).toBe(calls[0][0]); expect(call[1]?.body).toBe(calls[0][1]?.body);
      expect(call[1]?.headers).toEqual(calls[0][1]?.headers);
    }
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

  it.each([['English',english],['Polish',polish],['Belarusian',belarusian]])('has a complete %s catalog and preserves every interpolation placeholder', (_language,messages) => {
    expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort());
    for(const [source,value] of Object.entries(messages)){
      expect(value.trim(),source).not.toBe('');
      if (_language === 'Belarusian') expect(value,source).not.toMatch(/[ИиЩщЪъ]/);
      else expect(value,source).not.toMatch(/[А-Яа-яЁё]/);
      expect([...value.matchAll(/\{\d+\}/g)].map(x=>x[0]).sort(),source).toEqual([...source.matchAll(/\{\d+\}/g)].map(x=>x[0]).sort());
    }
  });

  it('retranslates formatted notices and timers between every supported language', () => {
    const source='Tuya Developer подключён. Найдено устройств: {0}.';
    for(const origin of LANGUAGES){
      setLocale(origin.value);
      const notice=t(source,[3]);
      const timer=t('Таймер канала {0}',[2]);
      for(const target of LANGUAGES){
        setLocale(target.value);
        expect(t(notice)).toBe(t(source,[3]));
        expect(t(timer)).toBe(t('Таймер канала {0}',[2]));
      }
    }
  });

  it.each([
    {locale:'pl', language:'Polish', heading:'Połącz Tuya', address:'Adres API', key:'Klucz dostępu do usługi',
      channel:'Kanał 2', timer:'Timer kanału 2', privacy:'Tryb prywatności', on:'Włączone', temperature:'Temperatura',
      error:'Wybrana sieć nie jest już dostępna. Odśwież listę sieci.', date:'pl-PL'},
    {locale:'be', language:'Belarusian', heading:'Падключыць Tuya', address:'Адрас API', key:'Ключ доступу да сэрвісу',
      channel:'Канал 2', timer:'Таймер канала 2', privacy:'Рэжым прыватнасці', on:'Уключана', temperature:'Тэмпература',
      error:'Выбраная сетка больш недаступная. Абнавіце спіс сетак.', date:'be-BY'},
  ] as const)('supports $language preferences, dates, controls and service errors', async (language) => {
    render(<App/>);
    fireEvent.change(screen.getByLabelText('Адрес API'),{target:{value:'http://localization-api.test:8080'}});
    fireEvent.change(screen.getByLabelText('Ключ доступа к сервису'),{target:{value:'незахаваны-Łąka'}});
    fireEvent.change(screen.getByLabelText('Язык'),{target:{value:language.locale}});
    expect(screen.getByRole('heading',{name:language.heading})).toBeInTheDocument();
    expect(screen.getByLabelText(language.address)).toHaveValue('http://localization-api.test:8080');
    expect(screen.getByLabelText(language.key)).toHaveValue('незахаваны-Łąka');
    expect(document.documentElement.lang).toBe(language.locale);
    expect(dateLocale()).toBe(language.date);
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe(language.locale);
    expect(labelFor('switch_2')).toBe(language.channel);
    expect(labelFor('countdown_2')).toBe(language.timer);
    expect(labelFor('basic_private')).toBe(language.privacy);
    expect(optionLabel('on','relay_status')).toBe(language.on);
    expect(t('Температура')).toBe(language.temperature);
    expect(t('Firmware-specific response X7')).toBe('Firmware-specific response X7');
    expect(fetch).not.toHaveBeenCalled();
    const api=new CloudApi({baseUrl:'http://api.test',token:'test-token'});
    vi.mocked(fetch).mockImplementation(async()=>json({detail:'Выбранная сеть больше недоступна. Обновите список сетей.'},409));
    await expect(api.status()).rejects.toThrow(language.error);
    act(()=>window.dispatchEvent(new StorageEvent('storage',{key:LANGUAGE_STORAGE_KEY,newValue:'en'})));
    expect(screen.getByLabelText('Service access key')).toHaveValue('незахаваны-Łąka');
    act(()=>window.dispatchEvent(new StorageEvent('storage',{key:LANGUAGE_STORAGE_KEY,newValue:language.locale})));
    expect(screen.getByRole('heading',{name:language.heading})).toBeInTheDocument();
  });
});
