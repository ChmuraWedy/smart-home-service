import { MSG, t } from '../i18n';

export default function StaleTag() {
  const explanation = t(MSG.STALE_READING_HELP);
  return (
    <span className="stale-tag" title={explanation} aria-label={explanation}>
      {t(MSG.STALE)}
    </span>
  );
}
