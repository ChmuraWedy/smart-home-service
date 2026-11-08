import {
  useCallback, useEffect, useId, useRef, useState,
} from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../api';
import type { Building, HomeApi, Room } from '../home-api';
import { MSG, t, translateText } from '../i18n';
import { dashboardHref } from '../navigation';
import { BACKGROUND_TYPES, prepareRoomBackground, useRoomAppearance } from '../room-appearance';

type Catalog = { buildings: Building[]; rooms: Room[] };
type CatalogRead = { api: HomeApi; data?: Catalog; error?: string };
type RunAction = (work: () => Promise<void>) => Promise<void>;

function failureMessage(failure: unknown) {
  return failure instanceof Error ? translateText(failure.message) : t(MSG.COULD_NOT_COMPLETE_THE_ACTION);
}

function NameForm({
  title, initial = '', submitLabel, buildings, busy, onSave,
}: {
  title: string;
  initial?: string;
  submitLabel: string;
  buildings?: Building[];
  busy: boolean;
  onSave: (name: string, buildingId: number) => void;
}) {
  const nameId = useId();
  const buildingId = useId();
  const [name, setName] = useState(initial);
  const [building, setBuilding] = useState(buildings?.[0]?.id ?? 0);
  const trimmed = name.trim();
  const disabled = busy || !trimmed || trimmed === initial || (Boolean(buildings) && !building);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disabled) onSave(trimmed, building);
  }

  return (
    <form
      aria-label={title}
      className="room-editor-form"
      onSubmit={submit}
    >
      <label htmlFor={nameId}>{t(MSG.NAME)}</label>
      <input
        id={nameId}
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={120}
        required
        disabled={busy}
      />
      {buildings && (
        <>
          <label htmlFor={buildingId}>{t(MSG.BUILDING)}</label>
          <select id={buildingId} value={building} onChange={(event) => setBuilding(Number(event.target.value))} disabled={busy}>
            {buildings.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </>
      )}
      <button type="submit" disabled={disabled}>{submitLabel}</button>
    </form>
  );
}

function RoomAppearanceForm({
  api, roomId, busy, run,
}: { api: HomeApi; roomId: number; busy: boolean; run: RunAction }) {
  const [revision, setRevision] = useState(0);
  const [opacityDraft, setOpacityDraft] = useState<number>();
  const [file, setFile] = useState<File>();
  const fileInput = useRef<HTMLInputElement>(null);
  const opacityId = useId();
  const backgroundId = useId();
  const read = useRoomAppearance(api, roomId, revision);
  const savedOpacity = read?.value?.appearance.card_opacity;
  const opacity = opacityDraft ?? savedOpacity ?? 100;
  const imageUrl = read?.value?.backgroundUrl;

  function refresh() {
    setRevision((previous) => previous + 1);
  }

  async function upload() {
    if (!file) return;
    await run(async () => {
      const image = await prepareRoomBackground(file);
      await api.uploadRoomBackground(roomId, image);
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = '';
      refresh();
    });
  }

  async function remove() {
    await run(async () => {
      await api.removeRoomBackground(roomId);
      refresh();
    });
  }

  async function saveOpacity() {
    await run(async () => {
      await api.setRoomOpacity(roomId, opacity);
      refresh();
    });
  }

  return (
    <section className="room-appearance-settings" aria-label={t(MSG.ROOM_APPEARANCE)}>
      <h2>{t(MSG.ROOM_APPEARANCE)}</h2>
      {!read && <p role="status">{t(MSG.LOADING_LIST)}</p>}
      {read?.error !== undefined && <p className="field-error" role="alert">{failureMessage(read.error)}</p>}
      {read?.value && (
        <>
          {imageUrl && <img className="room-background-preview" src={imageUrl} alt={t(MSG.ROOM_BACKGROUND_PREVIEW)} />}
          <label htmlFor={backgroundId}>{t(MSG.ROOM_BACKGROUND_IMAGE)}</label>
          <input
            id={backgroundId}
            ref={fileInput}
            type="file"
            accept={BACKGROUND_TYPES.join(',')}
            onChange={(event) => setFile(event.target.files?.[0])}
            disabled={busy}
          />
          <p className="help">{t(MSG.ROOM_BACKGROUND_HINT)}</p>
          <div className="room-editor-actions">
            <button type="button" disabled={busy || !file} onClick={upload}>{t(MSG.ROOM_BACKGROUND_UPLOAD)}</button>
            {imageUrl && (
              <button type="button" className="secondary" disabled={busy} onClick={remove}>{t(MSG.ROOM_BACKGROUND_REMOVE)}</button>
            )}
          </div>
          <label htmlFor={opacityId}>
            {t(MSG.ROOM_CARD_OPACITY)}
            {' · '}
            <output htmlFor={opacityId}>{opacity}%</output>
          </label>
          <input
            id={opacityId}
            type="range"
            min={65}
            max={100}
            value={opacity}
            aria-valuetext={`${opacity}%`}
            disabled={busy}
            onChange={(event) => setOpacityDraft(Number(event.target.value))}
          />
          <p className="help">{t(MSG.ROOM_OPACITY_HINT)}</p>
          <button type="button" disabled={busy || opacity === savedOpacity} onClick={saveOpacity}>{t(MSG.SAVE)}</button>
        </>
      )}
    </section>
  );
}

export default function RoomEditor({
  api, ready, onAuthError,
}: { api: HomeApi; ready: boolean; onAuthError: () => void }) {
  const [query] = useSearchParams();
  const [selectedId, setSelectedId] = useState(() => Number(query.get('room')) || undefined);
  const [catalog, setCatalog] = useState<CatalogRead>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const roomId = useId();
  const read = catalog?.api === api ? catalog : undefined;
  const data = read?.data;
  const selected = data?.rooms.find(({ id }) => id === selectedId) ?? data?.rooms[0];

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    api.roomCatalog(controller.signal).then((result) => {
      if (!controller.signal.aborted) setCatalog({ api, data: result });
    }).catch((failure) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      else setCatalog({ api, error: failureMessage(failure) });
    });
    return () => controller.abort();
  }, [api, attempt, onAuthError, ready]);

  const run: RunAction = useCallback(async (work) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onAuthError();
      else setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [busy, onAuthError]);

  const createBuilding = useCallback(async (name: string) => {
    if (!data) return;
    await run(async () => {
      const building = await api.createBuilding(name);
      setCatalog({ api, data: { ...data, buildings: [...data.buildings, building] } });
    });
  }, [api, data, run]);

  const createRoom = useCallback(async (name: string, buildingId: number) => {
    if (!data) return;
    await run(async () => {
      const room = await api.createRoom(name, buildingId);
      setCatalog({ api, data: { ...data, rooms: [...data.rooms, room] } });
      setSelectedId(room.id);
      setCreating(false);
    });
  }, [api, data, run]);

  const renameRoom = useCallback(async (name: string) => {
    if (!data || !selected) return;
    await run(async () => {
      const room = await api.renameRoom(selected.id, name);
      setCatalog({ api, data: { ...data, rooms: data.rooms.map((item) => (item.id === room.id ? room : item)) } });
    });
  }, [api, data, run, selected]);

  async function removeRoom() {
    if (!data || !selected) return;
    await run(async () => {
      try {
        await api.deleteRoom(selected.id);
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 409) throw new Error(t(MSG.ROOM_DELETE_BLOCKED));
        throw failure;
      }
      setCatalog({ api, data: { ...data, rooms: data.rooms.filter((item) => item.id !== selected.id) } });
      setSelectedId(undefined);
      setConfirmDelete(false);
    });
  }

  function selectRoom(event: ChangeEvent<HTMLSelectElement>) {
    setSelectedId(Number(event.target.value));
    setCreating(false);
    setConfirmDelete(false);
    setError('');
  }

  function toggleCreate() {
    setCreating((previous) => !previous);
    setError('');
  }

  function toggleDelete() {
    setConfirmDelete((previous) => !previous);
    setError('');
  }

  return (
    <section className="card room-editor" aria-busy={busy}>
      <div className="card-heading">
        <h1>{t(MSG.ROOM_EDITOR_TITLE)}</h1>
        <Link to={dashboardHref(selected ? String(selected.id) : '', new URLSearchParams(), 'tools')}>{t(MSG.DASHBOARD_SETTINGS)}</Link>
      </div>
      {!read && <p role="status">{t(MSG.LOADING_LIST)}</p>}
      {read?.error && (
        <>
          <p className="field-error" role="alert">{read.error}</p>
          <button type="button" className="secondary" onClick={() => setAttempt((value) => value + 1)}>{t(MSG.REFRESH_LIST)}</button>
        </>
      )}
      {data && !data.buildings.length && (
        <>
          <p>{t(MSG.ROOM_EDITOR_NEEDS_BUILDING)}</p>
          <NameForm title={t(MSG.ROOM_CREATE_BUILDING)} submitLabel={t(MSG.ROOM_CREATE_BUILDING)} busy={busy} onSave={createBuilding} />
        </>
      )}
      {data && data.buildings.length > 0 && (
        <>
          {data.rooms.length > 0 && (
            <div className="room-editor-actions">
              <label htmlFor={roomId}>{t(MSG.ROOM)}</label>
              <select
                id={roomId}
                value={selected?.id}
                disabled={busy}
                onChange={selectRoom}
              >
                {data.rooms.map((room) => {
                  const building = data.buildings.find(({ id }) => id === room.building_id);
                  const label = data.buildings.length > 1 && building ? `${room.name} · ${building.name}` : room.name;
                  return <option key={room.id} value={room.id}>{label}</option>;
                })}
              </select>
              <button type="button" className="secondary" disabled={busy} onClick={toggleCreate}>
                {t(creating ? MSG.CANCEL : MSG.ROOM_CREATE)}
              </button>
            </div>
          )}
          {creating || !selected ? (
            <NameForm
              title={t(MSG.ROOM_CREATE)}
              submitLabel={t(MSG.ROOM_CREATE)}
              buildings={data.buildings}
              busy={busy}
              onSave={createRoom}
            />
          ) : (
            <>
              <NameForm
                key={`name-${selected.id}`}
                title={t(MSG.ROOM_RENAME)}
                initial={selected.name}
                submitLabel={t(MSG.ROOM_RENAME)}
                busy={busy}
                onSave={renameRoom}
              />
              <RoomAppearanceForm
                key={`appearance-${selected.id}`}
                api={api}
                roomId={selected.id}
                busy={busy}
                run={run}
              />
              <Link to={dashboardHref(String(selected.id), new URLSearchParams(), null)}>{t(MSG.ROOM_VIEW_DASHBOARD)}</Link>
              {confirmDelete ? (
                <div className="room-editor-delete">
                  <p>{t(MSG.ROOM_DELETE_CONFIRM, [selected.name])}</p>
                  <p className="help">{t(MSG.ROOM_DELETE_SYNC_HINT)}</p>
                  <div className="room-editor-actions">
                    <button type="button" className="secondary" disabled={busy} onClick={toggleDelete}>{t(MSG.CANCEL)}</button>
                    <button type="button" disabled={busy} onClick={removeRoom}>{t(MSG.ROOM_DELETE)}</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="secondary" disabled={busy} onClick={toggleDelete}>{t(MSG.ROOM_DELETE)}</button>
              )}
            </>
          )}
        </>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}
