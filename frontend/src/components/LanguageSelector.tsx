import { getLocale, setLocale, t, useLocale } from '../i18n';

export function LanguageSelector() {
  useLocale();
  return <label className="language-selector"><span>{t('Язык')}</span><select aria-label={t('Язык')} value={getLocale()} onChange={event => setLocale(event.target.value as 'en' | 'ru')}>
    <option value="en" lang="en">English</option><option value="ru" lang="ru">Русский</option>
  </select></label>;
}
