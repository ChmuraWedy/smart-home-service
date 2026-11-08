import {
  Dialog, DialogBackdrop, DialogPanel, DialogTitle,
} from '@headlessui/react';
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import type { ComponentProps } from 'react';
import { dashboardBrowserId } from '../dashboard-layout';
import type { RoomNavigationLayout } from '../dashboard-layout';
import type { HomeApi, Room } from '../home-api';
import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';
import RoomNavigationEditor, { orderRooms } from './RoomNavigationEditor';

type RoomIcon = ComponentProps<typeof Icon>['name'];
type RoomChoice = { id: string; label: string; icon: RoomIcon };
type LayoutRead = { api: HomeApi; layout?: RoomNavigationLayout };
const EMPTY_LAYOUT: RoomNavigationLayout = { rooms: [] };

const roomIcons = [
  [/\b(?:study|office)\b/i, 'room-study'],
  [/\b(?:living|lounge)\b/i, 'room-living'],
  [/\b(?:bath(?:room)?|wc)\b/i, 'room-bath'],
  [/\bbed(?:room)?\b/i, 'room-bed'],
  [/\bkitchen\b/i, 'room-kitchen'],
  [/\bbalcony\b/i, 'room-balcony'],
] as const;

function useVisibleRooms(rooms: Room[], allRooms: string, noRoom: string, moreRooms: string) {
  const bar = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(Infinity);

  useLayoutEffect(() => {
    const container = bar.current;
    const measure = ruler.current;
    if (!container || !measure) return undefined;

    const update = () => {
      const available = container.getBoundingClientRect().width;
      if (!available) return;
      const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
      const widths = Array.from(measure.children, (item) => item.getBoundingClientRect().width);
      const moreWidth = widths.pop() ?? 0;
      const fullWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
      if (fullWidth <= available) {
        setVisibleCount(widths.length);
        return;
      }

      let used = moreWidth;
      let count = 0;
      for (const width of widths) {
        used += width + gap;
        if (used > available) break;
        count += 1;
      }
      setVisibleCount(count);
    };

    update();
    if (!window.ResizeObserver) {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [rooms, allRooms, noRoom, moreRooms]);

  return { bar, ruler, visibleCount };
}

function RoomButton({
  choice, active, onSelect,
}: {
  choice: RoomChoice;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  function select() {
    onSelect(choice.id);
  }

  return (
    <button
      type="button"
      className="secondary room-choice"
      aria-pressed={active}
      title={choice.label}
      onClick={select}
    >
      <Icon name={choice.icon} />
      <span>{choice.label}</span>
      {active && <Icon name="check" className="room-choice-check" />}
    </button>
  );
}

function roomChoice(room: Room): RoomChoice {
  return {
    id: String(room.id),
    label: room.name,
    icon: roomIcons.find(([pattern]) => pattern.test(room.name))?.[1] ?? 'room',
  };
}

export default function RoomNavigation({
  api, allRooms, rooms, selected, onSelect,
}: {
  api: HomeApi;
  allRooms: Room[] | undefined;
  rooms: Room[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingApi, setEditingApi] = useState<HomeApi>();
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<LayoutRead>();
  const currentRead = read?.api === api ? read : undefined;
  const layout = currentRead?.layout ?? EMPTY_LAYOUT;
  const readFailed = Boolean(currentRead && !currentRead.layout);
  const layoutLoaded = Boolean(currentRead);
  const ready = allRooms !== undefined;
  const visibleRooms = useMemo(() => {
    if (!layoutLoaded) return [];
    const hidden = new Set(layout.rooms.filter((entry) => entry.hidden).map(({ id }) => id));
    return orderRooms(rooms, layout.rooms).filter(({ id }) => !hidden.has(id));
  }, [layout, layoutLoaded, rooms]);

  useEffect(() => {
    if (!ready) return undefined;
    const browser = dashboardBrowserId();
    if (!browser) {
      setRead({ api, layout: EMPTY_LAYOUT });
      return undefined;
    }
    const controller = new AbortController();
    api.roomNavigationLayout(browser, controller.signal).then((saved) => {
      if (!controller.signal.aborted) setRead({ api, layout: Array.isArray(saved?.rooms) ? saved : undefined });
    }).catch(() => {
      if (!controller.signal.aborted) setRead({ api });
    });
    return () => controller.abort();
  }, [api, attempt, ready]);

  const all: RoomChoice = { id: '', label: t(MSG.ALL_ROOMS), icon: 'room-all' };
  const none: RoomChoice = { id: 'none', label: t(MSG.NO_ROOM), icon: 'room-none' };
  const moreLabel = t(MSG.MORE_ROOMS);
  const options = [all, ...visibleRooms.map(roomChoice), none];
  const { bar, ruler, visibleCount } = useVisibleRooms(visibleRooms, all.label, none.label, moreLabel);
  const quick = options.slice(0, visibleCount);
  const overflow = quick.length < options.length;
  const selectedRoom = allRooms?.find(({ id }) => String(id) === selected);
  const current = selectedRoom ? roomChoice(selectedRoom) : options.find((option) => option.id === selected);
  const currentName = current?.label ?? t(MSG.ROOMS);
  const moreActive = options.some((choice) => choice.id === selected) && !quick.some((choice) => choice.id === selected);
  const editLabel = t(readFailed ? MSG.RETRY_DASHBOARD_LAYOUT : MSG.EDIT_ROOM_NAVIGATION);

  function openEditor() {
    if (readFailed) {
      setRead(undefined);
      setAttempt((value) => value + 1);
    } else {
      setEditingApi(api);
    }
  }

  const closeEditor = useCallback(() => setEditingApi(undefined), []);
  const applyLayout = useCallback((saved: RoomNavigationLayout) => {
    setRead({ api, layout: saved });
    setEditingApi(undefined);
  }, [api]);

  function openPicker() {
    setOpen(true);
  }

  const closePicker = useCallback(() => {
    setOpen(false);
  }, []);

  const chooseRoom = useCallback((id: string) => {
    setOpen(false);
    onSelect(id);
  }, [onSelect]);

  return (
    <>
      <div className="room-navigation-selection">
        <button
          type="button"
          className="secondary room-navigation-trigger"
          aria-label={t(MSG.CHANGE_ROOM, [currentName])}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={openPicker}
        >
          <Icon name={current?.icon ?? 'room'} />
          <span>{currentName}</span>
          <Icon name="chevron-down" />
        </button>
        <p className="room-navigation-heading">{currentName}</p>
        {Boolean(allRooms?.length) && (
          <button
            type="button"
            className="secondary dashboard-layout-icon room-navigation-edit"
            aria-label={editLabel}
            aria-haspopup={readFailed ? undefined : 'dialog'}
            title={editLabel}
            disabled={!currentRead}
            onClick={openEditor}
          >
            <Icon name={readFailed ? 'refresh-list' : 'edit'} />
          </button>
        )}
      </div>
      {readFailed && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_LOAD_FAILED)}</p>}
      {editingApi === api && allRooms && (
        <RoomNavigationEditor
          api={api}
          rooms={allRooms}
          layout={layout}
          onClose={closeEditor}
          onSave={applyLayout}
        />
      )}
      <nav className="room-navigation-bar" aria-label={t(MSG.ROOMS)}>
        <div className="room-navigation-shortcuts" ref={bar}>
          {quick.map((choice) => <RoomButton key={choice.id} choice={choice} active={choice.id === selected} onSelect={onSelect} />)}
          {overflow && (
            <button
              type="button"
              className="secondary room-choice"
              data-active={moreActive || undefined}
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={openPicker}
            >
              <Icon name="more" />
              <span>{moreLabel}</span>
            </button>
          )}
        </div>
        <div className="room-navigation-measure" aria-hidden="true">
          <div className="room-navigation-shortcuts" ref={ruler}>
            {options.map((choice) => (
              <span className="room-choice" key={choice.id}>{choice.label}</span>
            ))}
            <span className="room-choice">{moreLabel}</span>
          </div>
        </div>
      </nav>
      <Dialog className="room-picker" open={open} onClose={closePicker}>
        <DialogBackdrop className="room-picker-backdrop" />
        <DialogPanel className="room-picker-panel">
          <header className="room-picker-heading">
            <DialogTitle as="h2">{t(MSG.ROOMS)}</DialogTitle>
            <button
              type="button"
              className="secondary room-picker-close"
              aria-label={t(MSG.CLOSE)}
              onClick={closePicker}
              data-autofocus
            >
              <Icon name="close" />
            </button>
          </header>
          <ul className="room-picker-list">
            {options.map((choice) => (
              <li key={choice.id}>
                <RoomButton choice={choice} active={choice.id === selected} onSelect={chooseRoom} />
              </li>
            ))}
          </ul>
        </DialogPanel>
      </Dialog>
    </>
  );
}
