import { useSyncExternalStore } from 'react';
import english from './en.json';
import polish from './pl.json';
import belarusian from './be.json';
import russian from './ru.json';

export const LANGUAGES = [
  { value: 'en', label: 'English', dateLocale: 'en-GB' },
  { value: 'ru', label: 'Русский', dateLocale: 'ru-RU' },
  { value: 'pl', label: 'Polski', dateLocale: 'pl-PL' },
  { value: 'be', label: 'Беларуская', dateLocale: 'be-BY' },
] as const;
export type Locale = typeof LANGUAGES[number]['value'];
export type MessageKey = keyof typeof russian;
export const MSG = Object.freeze(Object.fromEntries(Object.keys(russian).map(key => [key, key]))) as {
  readonly [Key in MessageKey]: Key;
};
const catalogs: Record<Locale, Record<MessageKey, string>> = { en: english, pl: polish, be: belarusian, ru: russian };
const isMessageKey = (value: string): value is MessageKey => Object.hasOwn(russian, value);
const isLocale = (value: unknown): value is Locale => LANGUAGES.some(language => language.value === value);
export const LANGUAGE_STORAGE_KEY = 'smart-home.ui.language.v1';
const listeners = new Set<() => void>();
const rawTables = new WeakMap<object, object>();
export const rawMessages = <T extends object>(table: T): T => (rawTables.get(table) || table) as T;

export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.split('-')[0]?.toLowerCase();
    if (isLocale(base)) return base;
  }
  return 'en';
}
export function savedLocale(): Locale {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch { /* Language switching still works when storage is unavailable. */ }
  return detectLocale(navigator.languages || [navigator.language]);
}
let locale: Locale = savedLocale();
export const getLocale = () => locale;
export const dateLocale = () => LANGUAGES.find(language => language.value === locale)!.dateLocale;
export function setLocale(next: Locale, persist = true): void {
  if (!isLocale(next)) return;
  if (persist) { try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Keep the in-memory preference. */ } }
  document.documentElement.lang = next;
  if (locale === next) return;
  locale = next;
  for (const listener of listeners) listener();
}
window.addEventListener('storage', event => {
  if (event.key === LANGUAGE_STORAGE_KEY && isLocale(event.newValue)) setLocale(event.newValue, false);
});
export function useLocale(): Locale {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, getLocale);
}
export function t(key: MessageKey, values: readonly unknown[] = []): string {
  return catalogs[locale][key].replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}

const messageKeys = Object.keys(MSG) as MessageKey[];
const sourceKeys = new Map(messageKeys.map(key => [russian[key], key] as const));
const translatedKeys = new Map([english, polish, belarusian].flatMap(messages =>
  messageKeys.map(key => [messages[key], key] as const)));
function messagePattern(message: string) {
  const indexes: number[] = [];
  const pattern = message.split(/(\{\d+\})/).map(part => {
    if (/^\{\d+\}$/.test(part)) { indexes.push(Number(part.slice(1,-1))); return '(.+?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { expression: new RegExp('^'+pattern+'$', 's'), indexes };
}
const patterns = messageKeys.filter(key => russian[key] !== english[key] && /\{\d+\}/.test(russian[key]))
  .sort((left, right) => russian[right].replace(/\{\d+\}/g, '').length - russian[left].replace(/\{\d+\}/g, '').length)
  .map(key => ({key, variants: [russian[key], english[key], polish[key], belarusian[key]].map(messagePattern)}));

/** Translate known service messages and previously formatted notices at the display boundary. */
export function translateText(message: string): string {
  const key = sourceKeys.get(message) ?? translatedKeys.get(message);
  if (key) return t(key);
  for (const pattern of patterns) for (const variant of pattern.variants) {
    const match = variant.expression.exec(message);
    if (!match) continue;
    const values: string[] = [];
    variant.indexes.forEach((index, position) => { values[index] = match[position + 1]; });
    return t(pattern.key, values);
  }
  return message;
}

type Localized<T> = T extends MessageKey ? string : T extends object ? { [Key in keyof T]: Localized<T[Key]> } : T;
/** Lazy message tables update on every lookup, including tables imported by other modules. */
export function localizeMessages<T extends object>(messages: T): Localized<T> {
  const cache = new WeakMap<object, object>();
  function wrap<V extends object>(value: V): V {
    const cached = cache.get(value);
    if (cached) return cached as V;
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        const item = Reflect.get(target, key, receiver);
        if (typeof item === 'string') return isMessageKey(item) ? t(item) : item;
        return item && typeof item === 'object' ? wrap(item) : item;
      },
    });
    cache.set(value, proxy);
    rawTables.set(proxy, value);
    return proxy;
  }
  return wrap(messages) as Localized<T>;
}
