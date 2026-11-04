import { useSyncExternalStore } from 'react';
import english from './en.json';
import polish from './pl.json';

const catalogs: Record<string, Record<string, string>> = { en: english, pl: polish };
export const LANGUAGES = [
  { value: 'en', label: 'English', dateLocale: 'en-GB' },
  { value: 'ru', label: 'Русский', dateLocale: 'ru-RU' },
  { value: 'pl', label: 'Polski', dateLocale: 'pl-PL' },
] as const;
export type Locale = typeof LANGUAGES[number]['value'];
const isLocale = (value: unknown): value is Locale => LANGUAGES.some(language => language.value === value);
export const LANGUAGE_STORAGE_KEY = 'smart-home.ui.language.v1';
const catalog: Record<string, string> = english;
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
const reverse = new Map(Object.values(catalogs).flatMap(messages => Object.entries(messages).map(([source, value]) => [value, source] as const)));
function messagePattern(message: string) {
  const indexes: number[] = [];
  const pattern = message.split(/(\{\d+\})/).map(part => {
    if (/^\{\d+\}$/.test(part)) { indexes.push(Number(part.slice(1,-1))); return '(.+?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { expression: new RegExp('^'+pattern+'$', 's'), indexes };
}
const patterns = Object.entries(catalog).filter(([source, value]) => source !== value && /\{\d+\}/.test(source))
  .sort(([left], [right]) => right.replace(/\{\d+\}/g,'').length - left.replace(/\{\d+\}/g,'').length)
  .map(([source]) => ({source, variants:[source, ...Object.values(catalogs).map(messages => messages[source])].filter((value): value is string => typeof value === 'string').map(messagePattern)}));
/** Source-language message IDs keep Russian complete; unknown external text is preserved. */
export function t(message: string, values: readonly unknown[] = []): string {
  let source = Object.hasOwn(catalog, message) ? message : reverse.get(message) || message;
  let parameters = values;
  if (!Object.hasOwn(catalog, source)) {
    outer: for (const pattern of patterns) for (const variant of pattern.variants) {
      const match = variant.expression.exec(message);
      if (!match) continue;
      source = pattern.source;
      const extracted: string[] = [];
      variant.indexes.forEach((index, position) => { extracted[index] = match[position+1]; });
      parameters = extracted;
      break outer;
    }
  }
  const selected = catalogs[locale];
  const translated = selected && Object.hasOwn(selected, source) ? selected[source] : source;
  return translated.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < parameters.length ? String(parameters[Number(index)]) : placeholder);
}
/** Lazy message tables update on every lookup, including tables imported by other modules. */
export function localizeMessages<T extends object>(messages: T): T {
  const cache = new WeakMap<object, object>();
  function wrap<V extends object>(value: V): V {
    const cached = cache.get(value);
    if (cached) return cached as V;
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        const item = Reflect.get(target, key, receiver);
        return typeof item === 'string' ? t(item) : item && typeof item === 'object' ? wrap(item) : item;
      },
    });
    cache.set(value, proxy);
    rawTables.set(proxy, value);
    return proxy;
  }
  return wrap(messages);
}
