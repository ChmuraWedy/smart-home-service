import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api';
import type { Room } from '../home-api';
import { MSG, t, translateText } from '../i18n';

export default function DeviceRoomEditor({
  rooms, roomId, onSave, onAuthError,
}: {
  rooms: Room[];
  roomId: number | null;
  onSave: (roomId: number | null) => Promise<void>;
  onAuthError: () => void;
}) {
  const selectId = useId();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [draft, setDraft] = useState<number | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = draft === undefined ? roomId : draft;
  const valid = selected === null || rooms.some(({ id }) => id === selected);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !valid || selected === roomId) return;
    setBusy(true);
    setError('');
    try {
      await onSave(selected);
      setDraft(undefined);
      disclosure.current?.removeAttribute('open');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      else setError(failure instanceof Error ? translateText(failure.message) : t(MSG.COULD_NOT_COMPLETE_THE_ACTION));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details ref={disclosure} className="status-details">
      <summary>{t(MSG.EDIT_DEVICE_ROOM)}</summary>
      <form className="device-room-form" onSubmit={save}>
        <label htmlFor={selectId}>{t(MSG.DEVICE_ROOM_IN_APP)}</label>
        <select id={selectId} value={selected ?? ''} disabled={busy} onChange={(event) => setDraft(Number(event.target.value) || null)}>
          <option value="">{t(MSG.NO_ROOM)}</option>
          {rooms.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button className="secondary compact" type="submit" disabled={busy || !valid || selected === roomId}>{t(MSG.SAVE_DEVICE_ROOM)}</button>
        {error && <p role="alert" className="field-error">{error}</p>}
      </form>
    </details>
  );
}
