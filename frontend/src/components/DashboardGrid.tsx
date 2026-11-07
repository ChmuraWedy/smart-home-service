import {
  useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import type { CSSProperties, DragEvent, ReactNode } from 'react';
import {
  dashboardBrowserId, ensureDashboardBrowserId, MAX_LAYOUT_SLOTS, moveCard, placeCards,
} from '../dashboard-layout';
import type { LayoutSlots } from '../dashboard-layout';
import type { HomeApi } from '../home-api';
import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';

export type GridCardPlacement = { style?: CSSProperties; inert?: boolean };
type GridView = { building: string; room: string; page: number };
type GridItem<T> = { id: string; cardName: string; entry: T };
type SavedLayout = { api: HomeApi; view: string; slots?: LayoutSlots; error?: boolean };
type LayoutDraft = { columns: number; slots: LayoutSlots; selected?: number };

function slotPosition(slot: number, columns: number): CSSProperties {
  return { gridColumnStart: (slot % columns) + 1, gridRowStart: Math.floor(slot / columns) + 1 };
}

function useGridColumns(density: string) {
  const grid = useRef<HTMLUListElement>(null);
  const [columns, setColumns] = useState(1);

  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return undefined;

    function measure() {
      if (!element) return;
      const style = getComputedStyle(element);
      const forced = Number(style.getPropertyValue('--dashboard-grid-forced-columns'));
      const minimum = Number.parseFloat(style.getPropertyValue('--dashboard-grid-minimum')) || 264;
      const gap = Number.parseFloat(style.columnGap) || 0;
      const { width } = element.getBoundingClientRect();
      setColumns(forced || Math.max(1, Math.min(24, Math.floor((width + gap) / (minimum + gap)))));
    }

    measure();
    if (!window.ResizeObserver) {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [density]);

  return { grid, columns };
}

function LayoutTarget({
  slot, columns, cardName, selected, moving, disabled, onSelect, onDragStart, onDrop, onDragEnd,
}: {
  slot: number;
  columns: number;
  cardName?: string;
  selected: boolean;
  moving: boolean;
  disabled: boolean;
  onSelect: (slot: number) => void;
  onDragStart: (slot: number) => void;
  onDrop: (slot: number) => void;
  onDragEnd: () => void;
}) {
  const position = slotPosition(slot, columns);
  const cell = t(MSG.LAYOUT_CELL, [position.gridRowStart, position.gridColumnStart]);
  let label = t(MSG.LAYOUT_MOVE_HERE, [cell]);
  if (cardName) label = moving && !selected ? t(MSG.LAYOUT_SWAP_WITH, [cardName, cell]) : t(MSG.LAYOUT_MOVE_CARD, [cardName, cell]);

  function startDrag(event: DragEvent<HTMLButtonElement>) {
    if (!cardName) return;
    const { dataTransfer } = event;
    dataTransfer.effectAllowed = 'move';
    dataTransfer.setData('text/plain', cardName);
    onDragStart(slot);
  }

  function allowDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    const { dataTransfer } = event;
    dataTransfer.dropEffect = 'move';
  }

  function drop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    onDrop(slot);
  }

  return (
    <li className="dashboard-layout-target" style={position}>
      <button
        type="button"
        className="dashboard-layout-target-button"
        data-occupied={Boolean(cardName) || undefined}
        data-selected={selected || undefined}
        aria-label={label}
        aria-pressed={cardName ? selected : undefined}
        title={label}
        disabled={disabled || (!cardName && !moving)}
        draggable={Boolean(cardName) && !disabled}
        onClick={() => onSelect(slot)}
        onDragStart={startDrag}
        onDragOver={allowDrop}
        onDrop={drop}
        onDragEnd={onDragEnd}
      >
        <Icon name={cardName ? 'move' : 'add'} />
      </button>
    </li>
  );
}

export default function DashboardGrid<T>({
  api, density, items, view, editable, renderCard,
}: {
  api: HomeApi;
  density: 'small' | 'large';
  items: GridItem<T>[];
  view?: GridView;
  editable: boolean;
  renderCard: (item: T, placement: GridCardPlacement) => ReactNode;
}) {
  const { grid, columns } = useGridColumns(density);
  const [browserId, setBrowserId] = useState(dashboardBrowserId);
  const [saved, setSaved] = useState<SavedLayout>();
  const [readAttempt, setReadAttempt] = useState(0);
  const [draft, setDraft] = useState<LayoutDraft>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const dragSource = useRef<number | undefined>(undefined);
  const pendingSave = useRef<symbol | null>(null);
  const scope = view && new URLSearchParams({
    building: view.building || 'all', room: view.room || 'all', page: String(view.page),
  }).toString();
  const activeColumns = draft?.columns ?? columns;
  const viewKey = scope && `${scope}&columns=${activeColumns}`;

  useLayoutEffect(() => {
    setDraft(undefined);
    setSaving(false);
    setSaveError(false);
    dragSource.current = undefined;
    return () => { pendingSave.current = null; };
  }, [api, scope]);

  useEffect(() => {
    if (!browserId || !viewKey) return undefined;
    const request = new AbortController();
    api.dashboardLayout(browserId, viewKey, request.signal).then(({ slots }) => {
      if (!request.signal.aborted) setSaved({ api, view: viewKey, slots });
    }).catch(() => {
      if (!request.signal.aborted) setSaved({ api, view: viewKey, error: true });
    });
    return () => request.abort();
  }, [api, browserId, readAttempt, viewKey]);

  const current = saved?.api === api && saved.view === viewKey ? saved : undefined;
  const hasSavedSlots = Boolean(current?.slots?.length);
  const slots = placeCards(items.map(({ id }) => id), draft?.slots ?? current?.slots ?? []);
  const cards = new Map(items.map((item) => [item.id, item]));
  const showEditor = Boolean(viewKey && (draft || (editable && items.length)));
  const targets = draft ? Math.min(MAX_LAYOUT_SLOTS, (Math.ceil(slots.length / activeColumns) + 1) * activeColumns) : 0;

  function toggleEditing() {
    setSaveError(false);
    if (draft) setDraft(undefined);
    else if (current?.error) {
      setSaved(undefined);
      setReadAttempt((attempt) => attempt + 1);
    } else setDraft({ columns, slots });
  }

  function selectSlot(slot: number) {
    if (!draft) return;
    const { selected } = draft;
    if (selected === undefined) setDraft({ ...draft, selected: slot });
    else setDraft({ columns: activeColumns, slots: moveCard(slots, selected, slot) });
  }

  function startDrag(slot: number) {
    dragSource.current = slot;
    setDraft({ columns: activeColumns, slots, selected: slot });
  }

  function clearDrag() {
    dragSource.current = undefined;
    setDraft((currentDraft) => currentDraft && { ...currentDraft, selected: undefined });
  }

  function dropCard(slot: number) {
    const source = dragSource.current;
    if (source === undefined) return;
    dragSource.current = undefined;
    setDraft({ columns: activeColumns, slots: moveCard(slots, source, slot) });
  }

  async function saveLayout() {
    if (!viewKey || pendingSave.current) return;
    const request = Symbol('dashboard-layout-save');
    pendingSave.current = request;
    setSaving(true);
    setSaveError(false);
    try {
      const id = ensureDashboardBrowserId();
      const result = await api.saveDashboardLayout(id, viewKey, slots);
      setBrowserId(id);
      if (pendingSave.current !== request) return;
      setSaved({ api, view: viewKey, slots: result.slots });
      setDraft(undefined);
    } catch {
      if (pendingSave.current === request) setSaveError(true);
    } finally {
      if (pendingSave.current === request) {
        pendingSave.current = null;
        setSaving(false);
      }
    }
  }

  let editLabel = t(MSG.EDIT_DASHBOARD_LAYOUT);
  if (draft) editLabel = t(MSG.CANCEL);
  else if (current?.error) editLabel = t(MSG.RETRY_DASHBOARD_LAYOUT);

  return (
    <>
      {showEditor && (
        <div className="dashboard-layout-toolbar">
          <button
            type="button"
            className="secondary compact"
            disabled={saving || Boolean(browserId && !current && !draft)}
            onClick={toggleEditing}
          >
            {!draft && <Icon name="edit" />}
            {editLabel}
          </button>
          {draft && (
            <button type="button" className="primary compact" disabled={saving} onClick={() => saveLayout()}>
              {saving ? t(MSG.SAVING).trim() : t(MSG.SAVE)}
            </button>
          )}
          {draft && <p className="help">{t(MSG.DASHBOARD_LAYOUT_INSTRUCTIONS)}</p>}
          {saveError && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_SAVE_FAILED)}</p>}
          {current?.error && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_LOAD_FAILED)}</p>}
        </div>
      )}
      <ul
        className="dashboard-device-grid"
        ref={grid}
        data-positioned={Boolean(draft || hasSavedSlots) || undefined}
        style={draft || hasSavedSlots ? { gridTemplateColumns: `repeat(${activeColumns}, minmax(0, 1fr))` } : undefined}
      >
        {slots.map((id, index) => {
          const item = id ? cards.get(id) : undefined;
          if (!item) return null;
          const style = draft || hasSavedSlots ? slotPosition(index, activeColumns) : undefined;
          return renderCard(item.entry, { style, inert: Boolean(draft) || undefined });
        })}
        {Array.from({ length: targets }, (_, slot) => {
          const id = slots[slot];
          return (
            <LayoutTarget
              key={`slot-${slot}`}
              slot={slot}
              columns={activeColumns}
              cardName={id ? cards.get(id)?.cardName : undefined}
              selected={draft?.selected === slot}
              moving={draft?.selected !== undefined}
              disabled={saving}
              onSelect={(target) => selectSlot(target)}
              onDragStart={(target) => startDrag(target)}
              onDrop={(target) => dropCard(target)}
              onDragEnd={() => clearDrag()}
            />
          );
        })}
      </ul>
    </>
  );
}
