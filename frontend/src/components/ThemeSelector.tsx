import { t } from '../i18n';
import { setTheme, useTheme } from '../theme';
import type { Theme } from '../theme';

export function ThemeSelector() {
  const theme = useTheme();
  return <label className="theme-selector"><span>{t('Тема')}</span><select aria-label={t('Тема')} value={theme} onChange={event => setTheme(event.target.value as Theme)}>
    <option value="system">{t('Системная')}</option><option value="dark">{t('Тёмная')}</option><option value="day">{t('Дневная')}</option>
  </select></label>;
}
