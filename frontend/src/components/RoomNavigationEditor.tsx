import {
  Dialog, DialogBackdrop, DialogPanel, DialogTitle,
} from '@headlessui/react';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { ensureDashboardBrowserId } from '../dashboard-layout';
import type { RoomNavigationEntry, RoomNavigationLayout } from '../dashboard-layout';
import type {
  Building, HomeApi, Room, RoomNameChanges,
} from '../home-api';
import { MSG, t } from '../i18n';
import useRoomName from '../room-names';
import { Icon } from './ui/icon';
import { RoomNameDialog, removeRoomOrExplain, useRoomAction } from './RoomEditor';

export type RoomManagement = {
  buildings: Building[];
  onSaved: (room: Room) => void;
  onDeleted: (id: number) => void;
  onAuthError: () => void;
  sync?: {
    run: () => Promise<void>; busy: boolean; error?: string | null; emptyRoomsAvailable: boolean;
  };
};

type EditAction = { kind: 'create' } | { kind: 'rename' | 'delete'; roomId: number };

export function orderRooms(rooms: Room[], saved: RoomNavigationEntry[]) {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const ordered = saved.flatMap(({ id }) => {
    const room = byId.get(id);
    byId.delete(id);
    return room ? [room] : [];
  });
  return [...ordered, ...byId.values()];
}

export default function RoomNavigationEditor({
  api, rooms, layout, onClose, onSave, management,
}: {
  api: HomeApi;
  rooms: Room[];
  layout: RoomNavigationLayout;
  onClose: () => void;
  onSave: (layout: RoomNavigationLayout) => void;
  management?: RoomManagement;
}) {
  const [draft, setDraft] = useState(() => layout.rooms);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [action, setAction] = useState<EditAction>();
  const {
    busy, error, run, setError,
  } = useRoomAction(management?.onAuthError);
  const request = useRef<AbortController | null>(null);
  const actionPanel = useRef<HTMLDivElement>(null);
  const roomLabel = useRoomName();
  const ordered = orderRooms(rooms, draft);
  const renamedRoom = action?.kind === 'rename' ? rooms.find(({ id }) => id === action.roomId) : undefined;
  const hidden = new Set(draft.filter((entry) => entry.hidden).map(({ id }) => id));
  const syncing = management?.sync;
  const locked = busy || saving || Boolean(syncing?.busy);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (action?.kind !== 'delete') return;
    actionPanel.current?.scrollIntoView?.({ block: 'nearest' });
    actionPanel.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
  }, [action]);

  function move(index: number, direction: -1 | 1) {
    const destination = index + direction;
    const next = ordered.map(({ id }) => ({ id, hidden: hidden.has(id) }));
    [next[index], next[destination]] = [next[destination], next[index]];
    setDraft(next);
  }

  function toggleVisibility(id: number) {
    setDraft(ordered.map(({ id: roomId }) => ({
      id: roomId,
      hidden: roomId === id ? !hidden.has(roomId) : hidden.has(roomId),
    })));
  }

  function edit(next?: EditAction) {
    setError('');
    setAction(next);
  }

  const create = useCallback(async (name: string, buildingId: number, changes?: RoomNameChanges) => {
    if (!management) return;
    await run(async () => {
      management.onSaved(await api.createRoom(name, buildingId, changes));
      setAction(undefined);
    });
  }, [api, management, run]);

  const rename = useCallback(async (name: string, _buildingId: number, changes?: RoomNameChanges) => {
    if (!management || !renamedRoom) return;
    await run(async () => {
      management.onSaved(await api.renameRoom(renamedRoom.id, name === renamedRoom.name ? undefined : name, changes));
      setAction(undefined);
    });
  }, [api, management, renamedRoom, run]);

  async function remove(id: number) {
    if (!management) return;
    await run(async () => {
      await removeRoomOrExplain(api, id);
      setDraft((previous) => previous.filter((room) => room.id !== id));
      management.onDeleted(id);
      setAction(undefined);
    });
  }

  const cancelAction = useCallback(() => {
    setError('');
    setAction(undefined);
  }, [setError]);

  const close = useCallback(() => {
    if (!request.current && !busy) onClose();
  }, [busy, onClose]);

  async function save() {
    if (request.current || busy || action) return;
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setFailed(false);
    try {
      const browser = api.isMember ? '' : ensureDashboardBrowserId();
      const saved = await api.saveRoomNavigationLayout(browser, {
        rooms: ordered.map(({ id }) => ({ id, hidden: hidden.has(id) })),
      }, controller.signal);
      if (!controller.signal.aborted) onSave(saved);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setSaving(false);
      }
    }
  }

  return (
    <Dialog className="room-picker" open onClose={close}>
      <DialogBackdrop className="room-picker-backdrop" />
      <DialogPanel className="room-picker-panel">
        <header className="room-picker-heading">
          <DialogTitle as="h2">{t(MSG.EDIT_ROOMS)}</DialogTitle>
        </header>
        <p className="help room-navigation-editor-help">{t(MSG.ROOM_NAVIGATION_LAYOUT_HELP)}</p>
        <div className="room-picker-list room-navigation-editor-body">
          <ol className="room-navigation-editor-list">
            {ordered.map((room, index) => {
              const { id } = room;
              const name = roomLabel(room);
              return (
                <li className="room-navigation-editor-row" key={id} data-room-hidden={hidden.has(id) || undefined} data-manage={Boolean(management) || undefined}>
                  <span>{name}</span>
                  {management && (
                    <button
                      type="button"
                      className="secondary room-navigation-rename"
                      aria-label={t(MSG.ROOM_RENAME_NAMED, [name])}
                      title={t(MSG.ROOM_RENAME_NAMED, [name])}
                      disabled={locked}
                      onClick={() => edit({ kind: 'rename', roomId: id })}
                    >
                      <Icon name="edit" />
                    </button>
                  )}
                  <div className="room-navigation-order">
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t(MSG.COMBINED_MOVE_MEMBER_UP, [name])}
                      disabled={locked || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <Icon name="chevron-down" className="tw:rotate-180" />
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t(MSG.COMBINED_MOVE_MEMBER_DOWN, [name])}
                      disabled={locked || index === ordered.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <Icon name="chevron-down" />
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t(MSG.ROOM_NAVIGATION_VISIBILITY, [name])}
                      aria-pressed={!hidden.has(id)}
                      disabled={locked}
                      onClick={() => toggleVisibility(id)}
                    >
                      <Icon name={hidden.has(id) ? 'eye-off' : 'eye'} />
                    </button>
                  </div>
                  {management && (
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t(MSG.ROOM_DELETE_NAMED, [name])}
                      title={t(MSG.ROOM_DELETE_NAMED, [name])}
                      disabled={locked}
                      onClick={() => edit({ kind: 'delete', roomId: id })}
                    >
                      <Icon name="delete" />
                    </button>
                  )}
                  {action?.kind === 'delete' && action.roomId === id && (
                    <div className="room-navigation-room-action" role="group" aria-label={t(MSG.ROOM_DELETE_NAMED, [name])} ref={actionPanel}>
                      <p>{t(MSG.ROOM_DELETE_CONFIRM, [name])}</p>
                      <p className="help">{t(MSG.ROOM_DELETE_SYNC_HINT)}</p>
                      <div className="room-navigation-editor-actions">
                        <button type="button" className="secondary" disabled={locked} onClick={cancelAction}>{t(MSG.CANCEL)}</button>
                        <button type="button" disabled={locked} onClick={() => remove(id)}>{t(MSG.ROOM_DELETE)}</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
        {action?.kind === 'delete' && error && <p className="field-error" role="alert">{error}</p>}
        {failed && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_SAVE_FAILED)}</p>}
        {syncing?.error && <p className="field-error" role="alert">{syncing.error}</p>}
        {syncing?.busy && <p className="help" role="status">{t(MSG.SYNCHRONIZATION_RUNS_IN_THE_BACKGROUND)}</p>}
        {syncing && !syncing.busy && !syncing.emptyRoomsAvailable && (
          <p className="help room-navigation-editor-help">{t(MSG.SMART_LIFE_DOES_NOT_RETURN_EMPTY_ROOMS_IN)}</p>
        )}
        <div className="room-navigation-catalog-actions">
          {management && action?.kind !== 'create' && (
            <button
              type="button"
              className="secondary room-navigation-new-room"
              disabled={locked || !management.buildings.length}
              title={management.buildings.length ? undefined : t(MSG.ROOM_EDITOR_NEEDS_BUILDING)}
              onClick={() => edit({ kind: 'create' })}
            >
              <Icon name="add" />
              {t(MSG.ROOM_NEW)}
            </button>
          )}
          {syncing && (
            <button
              type="button"
              className="secondary room-navigation-new-room"
              disabled={locked || Boolean(action)}
              onClick={syncing.run}
            >
              <Icon name="refresh-list" />
              {t(MSG.ROOM_SYNC_SMART_LIFE)}
            </button>
          )}
        </div>
        <footer className="room-navigation-editor-actions">
          <button type="button" className="secondary" disabled={busy || saving} onClick={close}>
            {t(MSG.CANCEL)}
          </button>
          <button type="button" disabled={locked || Boolean(action)} onClick={save}>
            {saving ? t(MSG.SAVING).trim() : t(MSG.SAVE)}
          </button>
        </footer>
        {management && (action?.kind === 'create' || renamedRoom) && (
          <RoomNameDialog
            api={api}
            room={renamedRoom}
            buildings={renamedRoom ? undefined : management.buildings}
            busy={locked}
            error={error}
            onSave={renamedRoom ? rename : create}
            onClose={cancelAction}
          />
        )}
      </DialogPanel>
    </Dialog>
  );
}
