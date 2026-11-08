import {
  Dialog, DialogBackdrop, DialogPanel, DialogTitle,
} from '@headlessui/react';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { ensureDashboardBrowserId } from '../dashboard-layout';
import type { RoomNavigationEntry, RoomNavigationLayout } from '../dashboard-layout';
import type { HomeApi, Room } from '../home-api';
import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';

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
  api, rooms, layout, onClose, onSave,
}: {
  api: HomeApi;
  rooms: Room[];
  layout: RoomNavigationLayout;
  onClose: () => void;
  onSave: (layout: RoomNavigationLayout) => void;
}) {
  const [draft, setDraft] = useState(() => layout.rooms);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const ordered = orderRooms(rooms, draft);
  const hidden = new Set(draft.filter((entry) => entry.hidden).map(({ id }) => id));

  useEffect(() => () => request.current?.abort(), []);

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

  const close = useCallback(() => {
    if (!request.current) onClose();
  }, [onClose]);

  async function save() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setFailed(false);
    try {
      const browser = ensureDashboardBrowserId();
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
          <DialogTitle as="h2">{t(MSG.EDIT_ROOM_NAVIGATION)}</DialogTitle>
        </header>
        <p className="help room-navigation-editor-help">{t(MSG.ROOM_NAVIGATION_LAYOUT_HELP)}</p>
        <ol className="room-picker-list">
          {ordered.map(({ id, name }, index) => (
            <li className="room-navigation-editor-row" key={id} data-room-hidden={hidden.has(id) || undefined}>
              <span>{name}</span>
              <button
                type="button"
                className="secondary"
                aria-label={t(MSG.COMBINED_MOVE_MEMBER_UP, [name])}
                disabled={saving || index === 0}
                onClick={() => move(index, -1)}
              >
                <Icon name="chevron-down" className="tw:rotate-180" />
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={t(MSG.COMBINED_MOVE_MEMBER_DOWN, [name])}
                disabled={saving || index === ordered.length - 1}
                onClick={() => move(index, 1)}
              >
                <Icon name="chevron-down" />
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={t(MSG.ROOM_NAVIGATION_VISIBILITY, [name])}
                aria-pressed={!hidden.has(id)}
                disabled={saving}
                onClick={() => toggleVisibility(id)}
              >
                <Icon name={hidden.has(id) ? 'eye-off' : 'eye'} />
              </button>
            </li>
          ))}
        </ol>
        {failed && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_SAVE_FAILED)}</p>}
        <footer className="room-navigation-editor-actions">
          <button type="button" className="secondary" disabled={saving} onClick={close}>
            {t(MSG.CANCEL)}
          </button>
          <button type="button" disabled={saving} onClick={save}>
            {saving ? t(MSG.SAVING).trim() : t(MSG.SAVE)}
          </button>
        </footer>
      </DialogPanel>
    </Dialog>
  );
}
