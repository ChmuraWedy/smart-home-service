import { MSG, t } from '../i18n';
import { setTheme, useTheme } from '../theme';
import type { Theme } from '../theme';

export function ThemeSelector() {
  const theme = useTheme();
  return <label className="theme-selector"><span>{t(MSG.THEME)}</span><select aria-label={t(MSG.THEME)} value={theme} onChange={event => setTheme(event.target.value as Theme)}>
    <option value="system">{t(MSG.SYSTEM)}</option><option value="dark">{t(MSG.DARK)}</option><option value="day">{t(MSG.DAY)}</option>
  </select></label>;
}
