import {
  Dialog, DialogBackdrop, DialogPanel, DialogTitle,
} from '@headlessui/react';
import {
  useCallback, useEffect, useId, useRef, useState,
} from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../api';
import type { TranslatedText } from '../device-translations';
import type {
  Building, HomeApi, Room, RoomNameChanges,
} from '../home-api';
import {
  LANGUAGES, MSG, t, translateText,
} from '../i18n';
import { dashboardHref } from '../navigation';
import { BACKGROUND_TYPES, prepareRoomBackground, useRoomAppearance } from '../room-appearance';
import useRoomName from '../room-names';
import RoomBackgroundCrop from './RoomBackgroundCrop';

type Catalog = { buildings: Building[]; rooms: Room[] };
type CatalogRead = { api: HomeApi; data?: Catalog; error?: string };
type RunAction = (work: () => Promise<void>) => Promise<void>;

function failureMessage(failure: unknown) {
  return failure instanceof Error ? translateText(failure.message) : t(MSG.COULD_NOT_COMPLETE_THE_ACTION);
}

function NameForm({
  title, initial = '', submitLabel, buildings, busy, onSave, translations, onCancel,
}: {
  title: string;
  initial?: string;
  submitLabel: string;
  buildings?: Building[];
  busy: boolean;
  translations?: TranslatedText;
  onCancel?: () => void;
  onSave: (name: string, buildingId: number, changes?: RoomNameChanges) => void;
}) {
  const nameId = useId();
  const buildingId = useId();
  const [name, setName] = useState(initial);
  const [building, setBuilding] = useState(buildings?.[0]?.id ?? 0);
  const [draft, setDraft] = useState<TranslatedText>({});
  const trimmed = name.trim();
  const changes: RoomNameChanges = Object.fromEntries(LANGUAGES.flatMap(({ value }) => {
    const text = draft[value]?.normalize('NFC').trim();
    return text !== undefined && text !== (translations?.[value] ?? '') ? [[value, text || null]] : [];
  }));
  const translationsChanged = Object.keys(changes).length > 0;
  const disabled = busy || !trimmed || (trimmed === initial && !translationsChanged) || (Boolean(buildings) && !building);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disabled) onSave(trimmed, building, translationsChanged ? changes : undefined);
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
        data-autofocus={Boolean(onCancel) || undefined}
      />
      {buildings && (
        <>
          <label htmlFor={buildingId}>{t(MSG.BUILDING)}</label>
          <select id={buildingId} value={building} onChange={(event) => setBuilding(Number(event.target.value))} disabled={busy}>
            {buildings.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </>
      )}
      {translations && (
        <details className="room-name-translations">
          <summary>{t(MSG.ROOM_NAME_TRANSLATIONS)}</summary>
          <p className="help">{t(MSG.ROOM_NAME_TRANSLATIONS_HELP)}</p>
          <div className="device-translation-inputs">
            {LANGUAGES.map(({ value, label }) => (
              <label key={value} lang={value} htmlFor={`${nameId}-${value}`}>
                {label}
                <input
                  id={`${nameId}-${value}`}
                  value={draft[value] ?? translations[value] ?? ''}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, [value]: event.target.value })}
                />
              </label>
            ))}
          </div>
        </details>
      )}
      <div className="room-editor-actions">
        {onCancel && (
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t(MSG.CANCEL)}</button>
        )}
        <button type="submit" disabled={disabled}>{submitLabel}</button>
      </div>
    </form>
  );
}

export function RoomNameDialog({
  room, buildings, busy, error, onSave, onClose,
}: {
  room?: Room;
  buildings?: Building[];
  busy: boolean;
  error?: string;
  onSave: (name: string, buildingId: number, changes?: RoomNameChanges) => void;
  onClose: () => void;
}) {
  const title = t(room ? MSG.ROOM_RENAME : MSG.ROOM_CREATE);
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  return (
    <Dialog className="room-picker" open onClose={close}>
      <DialogBackdrop className="room-picker-backdrop" />
      <DialogPanel className="room-name-panel">
        <DialogTitle as="h2">{title}</DialogTitle>
        <NameForm
          title={title}
          initial={room?.name}
          translations={room?.name_translations ?? {}}
          buildings={buildings}
          submitLabel={title}
          busy={busy}
          onSave={onSave}
          onCancel={close}
        />
        {error && <p className="field-error" role="alert">{error}</p>}
      </DialogPanel>
    </Dialog>
  );
}

function RoomAppearanceForm({
  api, roomId, busy, run, onSaved,
}: { api: HomeApi; roomId: number; busy: boolean; run: RunAction; onSaved?: () => void }) {
  const [revision, setRevision] = useState(0);
  const [opacityDraft, setOpacityDraft] = useState<number>();
  const [file, setFile] = useState<File>();
  const [cropOpen, setCropOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const opacityId = useId();
  const backgroundId = useId();
  const read = useRoomAppearance(api, roomId, revision);
  const savedOpacity = read?.value?.appearance.card_opacity;
  const opacity = opacityDraft ?? savedOpacity ?? 100;
  const imageUrl = read?.value?.backgroundUrl;
  const cropSource = file ?? read?.value?.background;
  const closeCrop = useCallback(() => setCropOpen(false), []);

  const refresh = useCallback(() => {
    setRevision((previous) => previous + 1);
    onSaved?.();
  }, [onSaved]);

  const saveBackground = useCallback(async (image: Blob) => {
    await api.uploadRoomBackground(roomId, image);
    setFile(undefined);
    if (fileInput.current) fileInput.current.value = '';
    refresh();
  }, [api, refresh, roomId]);

  async function upload() {
    if (file) await run(async () => saveBackground(await prepareRoomBackground(file)));
  }

  const saveCrop = useCallback(async (image: Blob) => {
    setCropOpen(false);
    await run(() => saveBackground(image));
  }, [run, saveBackground]);

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
            <button type="button" className="secondary" disabled={busy || !cropSource} onClick={() => setCropOpen(true)}>
              {t(MSG.ROOM_CROP_IMAGE)}
            </button>
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
      {cropOpen && cropSource && (
        <RoomBackgroundCrop source={cropSource} onSave={saveCrop} onClose={closeCrop} />
      )}
    </section>
  );
}

export function useRoomAction(onAuthError?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run: RunAction = useCallback(async (work) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401 && onAuthError) onAuthError();
      else setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [busy, onAuthError]);

  return {
    busy, error, run, setError,
  };
}

export async function removeRoomOrExplain(api: HomeApi, id: number) {
  try {
    await api.deleteRoom(id);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 409) throw new Error(t(MSG.ROOM_DELETE_BLOCKED));
    throw failure;
  }
}

function RoomNameAndAppearance({
  api, room, busy, error, run, onRenamed, onAppearanceSaved,
}: {
  api: HomeApi;
  room: Room;
  busy: boolean;
  error?: string;
  run: RunAction;
  onRenamed: (room: Room) => void;
  onAppearanceSaved?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const closeRename = useCallback(() => setRenaming(false), []);
  const rename = useCallback(async (name: string, _buildingId: number, changes?: RoomNameChanges) => {
    await run(async () => {
      const renamed = await api.renameRoom(room.id, name === room.name ? undefined : name, changes);
      onRenamed(renamed);
      closeRename();
    });
  }, [api, closeRename, onRenamed, room.id, room.name, run]);

  return (
    <>
      <button type="button" className="secondary compact" disabled={busy} onClick={() => setRenaming(true)}>
        {t(MSG.ROOM_RENAME)}
      </button>
      {renaming && (
        <RoomNameDialog
          room={room}
          busy={busy}
          error={error}
          onSave={rename}
          onClose={closeRename}
        />
      )}
      <RoomAppearanceForm
        api={api}
        roomId={room.id}
        busy={busy}
        run={run}
        onSaved={onAppearanceSaved}
      />
    </>
  );
}

export function RoomLayoutSettings({
  api, room, onAuthError, onRenamed, onAppearanceSaved,
}: {
  api: HomeApi;
  room: Room;
  onAuthError: () => void;
  onRenamed: (room: Room) => void;
  onAppearanceSaved: () => void;
}) {
  const { busy, error, run } = useRoomAction(onAuthError);

  return (
    <details className="room-layout-settings">
      <summary>{t(MSG.ROOM_APPEARANCE_AND_NAME_EDITOR)}</summary>
      <div className="room-layout-settings-content" aria-busy={busy}>
        <RoomNameAndAppearance
          api={api}
          room={room}
          busy={busy}
          error={error}
          run={run}
          onRenamed={onRenamed}
          onAppearanceSaved={onAppearanceSaved}
        />
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
    </details>
  );
}

export default function RoomEditor({
  api, ready, onAuthError,
}: { api: HomeApi; ready: boolean; onAuthError: () => void }) {
  const [query] = useSearchParams();
  const [selectedId, setSelectedId] = useState(() => Number(query.get('room')) || undefined);
  const [catalog, setCatalog] = useState<CatalogRead>();
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const {
    busy, error, run, setError,
  } = useRoomAction(onAuthError);
  const roomId = useId();
  const roomLabel = useRoomName();
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

  const createBuilding = useCallback(async (name: string) => {
    if (!data) return;
    await run(async () => {
      const building = await api.createBuilding(name);
      setCatalog({ api, data: { ...data, buildings: [...data.buildings, building] } });
    });
  }, [api, data, run]);

  const createRoom = useCallback(async (name: string, buildingId: number, changes?: RoomNameChanges) => {
    if (!data) return;
    await run(async () => {
      const room = await api.createRoom(name, buildingId, changes);
      setCatalog({ api, data: { ...data, rooms: [...data.rooms, room] } });
      setSelectedId(room.id);
      setCreating(false);
    });
  }, [api, data, run]);

  const updateRoom = useCallback((room: Room) => {
    setCatalog((value) => {
      if (value?.api !== api || !value.data) return value;
      const rooms = value.data.rooms.map((item) => (item.id === room.id ? room : item));
      return { ...value, data: { ...value.data, rooms } };
    });
  }, [api]);

  async function removeRoom() {
    if (!data || !selected) return;
    await run(async () => {
      await removeRoomOrExplain(api, selected.id);
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

  const closeCreate = useCallback(() => setCreating(false), []);

  function openCreate() {
    setCreating(true);
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
        <Link to={dashboardHref(selected ? String(selected.id) : '', new URLSearchParams(), null, true)}>{t(MSG.EDIT_DASHBOARD_LAYOUT)}</Link>
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
          <div className="room-editor-actions">
            {data.rooms.length > 0 && (
              <>
                <label htmlFor={roomId}>{t(MSG.ROOM)}</label>
                <select
                  id={roomId}
                  value={selected?.id}
                  disabled={busy}
                  onChange={selectRoom}
                >
                  {data.rooms.map((room) => {
                    const building = data.buildings.find(({ id }) => id === room.building_id);
                    const name = roomLabel(room);
                    const label = data.buildings.length > 1 && building ? `${name} · ${building.name}` : name;
                    return <option key={room.id} value={room.id}>{label}</option>;
                  })}
                </select>
              </>
            )}
            <button type="button" className="secondary" disabled={busy} onClick={openCreate}>
              {t(MSG.ROOM_CREATE)}
            </button>
          </div>
          {creating && (
            <RoomNameDialog
              buildings={data.buildings}
              busy={busy}
              error={error}
              onSave={createRoom}
              onClose={closeCreate}
            />
          )}
          {selected && (
            <>
              <RoomNameAndAppearance
                key={selected.id}
                api={api}
                room={selected}
                busy={busy}
                error={error}
                run={run}
                onRenamed={updateRoom}
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
