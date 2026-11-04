import { getLocale, LANGUAGES, setLocale, t, useLocale } from '../i18n';
import type { Locale } from '../i18n';

export function LanguageSelector() {
  useLocale();
  return <label className="language-selector"><span>{t('Язык')}</span><select aria-label={t('Язык')} value={getLocale()} onChange={event => setLocale(event.target.value as Locale)}>
    {LANGUAGES.map(language => <option key={language.value} value={language.value} lang={language.value}>{language.label}</option>)}
  </select></label>;
}
