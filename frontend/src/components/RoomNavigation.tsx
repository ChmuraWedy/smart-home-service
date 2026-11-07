import {
  Dialog, DialogBackdrop, DialogPanel, DialogTitle,
} from '@headlessui/react';
import {
  useCallback, useLayoutEffect, useRef, useState,
} from 'react';
import type { ComponentProps } from 'react';
import type { Room } from '../home-api';
import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';

type RoomIcon = ComponentProps<typeof Icon>['name'];
type RoomChoice = { id: string; label: string; icon: RoomIcon };

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

export default function RoomNavigation({ rooms, selected, onSelect }: {
  rooms: Room[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const all: RoomChoice = { id: '', label: t(MSG.ALL_ROOMS), icon: 'room-all' };
  const none: RoomChoice = { id: 'none', label: t(MSG.NO_ROOM), icon: 'room-none' };
  const moreLabel = t(MSG.MORE_ROOMS);
  const choices: RoomChoice[] = rooms.map((room) => ({
    id: String(room.id),
    label: room.name,
    icon: roomIcons.find(([pattern]) => pattern.test(room.name))?.[1] ?? 'room',
  }));
  const options = [all, ...choices, none];
  const { bar, ruler, visibleCount } = useVisibleRooms(rooms, all.label, none.label, moreLabel);
  const quick = options.slice(0, visibleCount);
  const overflow = quick.length < options.length;
  const current = options.find((option) => option.id === selected);
  const currentName = current?.label ?? t(MSG.ROOMS);
  const moreActive = current && !quick.includes(current);

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
