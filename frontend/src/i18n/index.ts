import { useSyncExternalStore } from 'react';
import english from './en.json';

export type Locale = 'en' | 'ru';
export const LANGUAGE_STORAGE_KEY = 'smart-home.ui.language.v1';
const catalog: Record<string, string> = english;
const listeners = new Set<() => void>();
const rawTables = new WeakMap<object, object>();
export const rawMessages = <T extends object>(table: T): T => (rawTables.get(table) || table) as T;

export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    if (/^ru(?:-|$)/i.test(language)) return 'ru';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}
export function savedLocale(): Locale {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'en' || stored === 'ru') return stored;
  } catch { /* Language switching still works when storage is unavailable. */ }
  return detectLocale(navigator.languages || [navigator.language]);
}
let locale: Locale = savedLocale();
export const getLocale = () => locale;
export const dateLocale = () => locale === 'ru' ? 'ru-RU' : 'en-GB';
export function setLocale(next: Locale, persist = true): void {
  if (next !== 'en' && next !== 'ru') return;
  if (persist) { try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Keep the in-memory preference. */ } }
  document.documentElement.lang = next;
  if (locale === next) return;
  locale = next;
  for (const listener of listeners) listener();
}
window.addEventListener('storage', event => {
  if (event.key === LANGUAGE_STORAGE_KEY && (event.newValue === 'en' || event.newValue === 'ru')) setLocale(event.newValue, false);
});
export function useLocale(): Locale {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, getLocale);
}
const reverse = new Map(Object.entries(catalog).map(([source, value]) => [value, source]));
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
  .map(([source, value]) => ({source, variants:[messagePattern(source), messagePattern(value)]}));
/** Source-language message IDs keep Russian complete; unknown external text is preserved. */
export function t(message: string, values: readonly unknown[] = []): string {
  let source = reverse.get(message) || message;
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
  const translated = locale === 'en' && Object.hasOwn(catalog, source) ? catalog[source] : source;
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
