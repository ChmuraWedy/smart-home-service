import { dateLocale, MSG, t } from '../i18n';
import type { HomeApi } from '../home-api';
import { useTopology } from '../use-topology';

export default function SmartLifeRoomsPage({ api, ready, onAuthError }: {
  api: HomeApi;
  ready: boolean;
  onAuthError: () => void;
}) {
  const {
    data, error, busy, sync,
  } = useTopology(api, ready, () => {}, onAuthError);
  const homes = data?.homes ?? [];
  const rooms = data?.rooms ?? [];
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
    <section className="card settings-page smart-life-rooms-page" aria-labelledby="smart-life-rooms-heading">
      <h1 id="smart-life-rooms-heading">{t(MSG.ROOMS_FROM_SMART_LIFE)}</h1>
      <div className="topology-summary">
        <div>
          <p className={busy ? 'help' : 'help topology-note'}>{description}</p>
        </div>
        <button type="button" className="secondary compact" disabled={!ready || busy} onClick={sync}>
          {t(MSG.SYNC_SMART_LIFE)}
        </button>
        {busy && <p role="status" className="help">{t(MSG.SYNCHRONIZATION_RUNS_IN_THE_BACKGROUND)}</p>}
        {message && <p role="alert" className="field-error">{message}</p>}
        {warnings !== 0 && (
        <p className="help">
          {`${t(MSG.MANUAL_SETTINGS_WERE_PRESERVED_OR_PLACEMENT_LIMITATIONS_WERE)} `}
          {warnings}
          {t(MSG.CHECK_THE_RELEVANT_DEVICES_ROOMS)}
        </p>
        )}
        {data?.synced_at && !data.empty_rooms_available && (
        <p className="help topology-note">{t(MSG.SMART_LIFE_DOES_NOT_RETURN_EMPTY_ROOMS_IN)}</p>
        )}
      </div>
      {!ready && <p className="help">{t(MSG.CONNECT_YOUR_ACCOUNT_TO_ACCESS_YOUR_DEVICES)}</p>}
      {ready && data && !busy && !rooms.length && <p className="help">{t(MSG.SMART_LIFE_NO_LOADED_ROOMS)}</p>}
      {homes.map((home) => {
        const homeRooms = rooms.filter((room) => room.home_id === home.home_id);
        if (!homeRooms.length) return null;
        return (
          <div className="smart-life-room-group" key={home.home_id}>
            <h2>{home.name}</h2>
            <ul>
              {homeRooms.map((room) => <li key={room.room_id}>{room.name}</li>)}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
