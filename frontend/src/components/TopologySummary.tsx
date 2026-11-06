import { dateLocale, MSG, t } from '../i18n';
import type { Topology } from '../home-api';

export function TopologySummary({ data, error, busy, onSync }: {
  data?: Topology;
  error?: string;
  busy: boolean;
  onSync: () => void;
}) {
  const job = data?.job;
  const message = error || job?.message;
  const warnings = data?.warnings ?? 0;
  let description = t(MSG.BUILDINGS_AND_ROOMS_WILL_BE_USED_IN_DEVICE);

  if (busy) {
    description = t(MSG.LOADING_HOME_STRUCTURE, [job?.processed ?? 0, job?.total || '…']);
  } else if (data?.synced_at) {
    description = t(MSG.SYNCED) + new Date(data.synced_at).toLocaleString(dateLocale());
  }

  return (
    <div className="topology-summary">
      <div>
        <h3>{t(MSG.ROOMS_FROM_SMART_LIFE)}</h3>
        <p className={busy ? 'help' : 'help topology-note'}>{description}</p>
      </div>
      <button className="secondary compact" disabled={busy} onClick={onSync}>
        {t(MSG.SYNC_SMART_LIFE)}
      </button>
      {busy && <p role="status" className="help">{t(MSG.SYNCHRONIZATION_RUNS_IN_THE_BACKGROUND)}</p>}
      {message && <p role="alert" className="field-error">{message}</p>}
      {warnings !== 0 && (
      <p className="help">
        {t(MSG.MANUAL_SETTINGS_WERE_PRESERVED_OR_PLACEMENT_LIMITATIONS_WERE) + ' '}
        {warnings}
        {t(MSG.CHECK_THE_RELEVANT_DEVICES_ROOMS)}
      </p>
)}
      <p className="help topology-note">{t(MSG.SMART_LIFE_DOES_NOT_RETURN_EMPTY_ROOMS_IN)}</p>
    </div>
  );
}
