import { useSyncExternalStore } from 'react';
import { useLocale } from './i18n';
import type { Locale } from './i18n';

export type TranslatedText = Partial<Record<Locale, string>>;
export type TranslationKind = 'name' | 'alias';
export type DeviceTranslations = Record<TranslationKind, Record<string, TranslatedText>>;
export type TranslationEdit = { kind: TranslationKind; original: string; values: TranslatedText };
export type TranslationSaved = TranslationEdit & { shared: boolean };
type DisplayMode = 'localized' | 'original';

const storageKey = 'smart-home.ui.device-text.v1';
const subscribers = new Set<() => void>();
let mode: DisplayMode = 'original';
try {
  if (localStorage.getItem(storageKey) === 'localized') mode = 'localized';
} catch { /* Display preferences still work for the current tab. */ }

export function setDeviceTextMode(next: DisplayMode, persist = true) {
  if (persist) {
    try { localStorage.setItem(storageKey, next); } catch { /* Keep the in-memory preference. */ }
  }
  if (next === mode) return;
  mode = next;
  subscribers.forEach((notify) => notify());
}

window.addEventListener('storage', (event) => {
  if (event.key === storageKey) setDeviceTextMode(event.newValue === 'localized' ? 'localized' : 'original', false);
});

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

export function useDeviceTextMode() {
  return useSyncExternalStore(subscribe, () => mode);
}

export function translationFor(translations: DeviceTranslations | undefined, kind: TranslationKind, original: string) {
  const entries = translations?.[kind];
  return entries && Object.hasOwn(entries, original) ? entries[original] : undefined;
}

export function useDeviceText() {
  const locale = useLocale();
  const display = useDeviceTextMode();
  return (original: string, variants?: TranslatedText) => (display === 'localized' && variants?.[locale]) || original;
}

export function withTranslation(current: DeviceTranslations | undefined, edit: TranslationEdit): DeviceTranslations {
  const previous = current ?? { name: {}, alias: {} };
  if (Object.keys(edit.values).length) {
    return { ...previous, [edit.kind]: { ...previous[edit.kind], [edit.original]: edit.values } };
  }
  const entries = { ...previous[edit.kind] };
  delete entries[edit.original];
  return { ...previous, [edit.kind]: entries };
}

export function withoutRemovedAliases(current: DeviceTranslations, aliases: string[]): DeviceTranslations {
  return {
    name: current.name,
    alias: Object.fromEntries(Object.entries(current.alias).filter(([alias]) => aliases.includes(alias))),
  };
}
