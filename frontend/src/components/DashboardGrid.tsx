import {
  useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  dashboardBrowserId, ensureDashboardBrowserId, moveCard, placeCards, trimSlots,
} from '../dashboard-layout';
import type { DashboardLayout, LayoutSlots } from '../dashboard-layout';
import type { HomeApi } from '../home-api';
import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';
import useDashboardDrag from './use-dashboard-drag';
import type { DropTarget } from './use-dashboard-drag';

export type GridCardPlacement = {
  style?: CSSProperties; inert?: boolean; slot?: number; nudge?: DropTarget['nudge'];
};
type GridView = { building: string; room: string; page: number };
type GridItem<T> = { id: string; cardName: string; entry: T; hideable?: boolean; forceVisible?: boolean };
type SavedLayout = { api: HomeApi; view: string; layout?: DashboardLayout; error?: boolean };
type LayoutDraft = { columns: number; slots: LayoutSlots; hiddenDevices: string[]; selected?: number };
const EDITOR_SLOTS = 20;

function useGridColumns(density: string) {
  const grid = useRef<HTMLDivElement>(null);
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
  slot, row, column, cardName, selected, moving, disabled, over, onSelect,
}: {
  slot: number;
  row: number;
  column: number;
  cardName?: string;
  selected: boolean;
  moving: boolean;
  disabled: boolean;
  over?: DropTarget['nudge'];
  onSelect: (slot: number) => void;
}) {
  const cell = t(MSG.LAYOUT_CELL, [row, column]);
  let label = t(MSG.LAYOUT_MOVE_HERE, [cell]);
  if (cardName) label = moving && !selected ? t(MSG.LAYOUT_INSERT_BEFORE, [cardName, cell]) : t(MSG.LAYOUT_MOVE_CARD, [cardName, cell]);

  return (
    <li
      className="dashboard-layout-target"
      style={{ gridColumnStart: 1, gridRowStart: row }}
      data-occupied={Boolean(cardName) || undefined}
    >
      <button
        type="button"
        className="dashboard-layout-target-button"
        data-layout-target={slot}
        data-occupied={Boolean(cardName) || undefined}
        data-selected={selected || undefined}
        data-drop-over={over}
        aria-label={label}
        aria-pressed={cardName ? selected : undefined}
        title={label}
        disabled={disabled || (!cardName && !moving)}
        onClick={() => onSelect(slot)}
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
  const visibilityId = useId();
  const [browserId, setBrowserId] = useState(dashboardBrowserId);
  const [saved, setSaved] = useState<SavedLayout>();
  const [readAttempt, setReadAttempt] = useState(0);
  const [draft, setDraft] = useState<LayoutDraft>();
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const pendingSave = useRef<symbol | null>(null);
  const scope = view && new URLSearchParams({
    building: view.building || 'all', room: view.room || 'all', page: String(view.page),
  }).toString();
  const activeColumns = draft?.columns ?? columns;
  const viewKey = scope && `${scope}&columns=${activeColumns}`;

  useLayoutEffect(() => {
    setDraft(undefined);
    setShowAll(false);
    setSaving(false);
    setSaveError(false);
    return () => { pendingSave.current = null; };
  }, [api, scope]);

  useEffect(() => {
    if (!browserId || !viewKey) return undefined;
    const request = new AbortController();
    api.dashboardLayout(browserId, viewKey, request.signal).then((layout) => {
      if (!request.signal.aborted) setSaved({ api, view: viewKey, layout });
    }).catch(() => {
      if (!request.signal.aborted) setSaved({ api, view: viewKey, error: true });
    });
    return () => request.abort();
  }, [api, browserId, readAttempt, viewKey]);

  const current = saved?.api === api && saved.view === viewKey ? saved : undefined;
  const hidden = new Set(current?.layout?.hidden_devices);
  const visibleItems = draft || showAll ? items : items.filter((item) => !item.hideable || item.forceVisible || !hidden.has(item.id));
  const slots = placeCards(visibleItems.map(({ id }) => id), draft?.slots ?? current?.layout?.slots ?? []);
  const cards = new Map(visibleItems.map((item) => [item.id, item]));
  const individualDevices = items.filter((item) => item.hideable);
  const hasHiddenDevices = individualDevices.some(({ id }) => hidden.has(id));
  const showEditor = Boolean(viewKey && (draft || (editable && items.length)));

  const drag = useDashboardDrag(scope, (from, target) => {
    setDraft((value) => value && {
      ...value,
      slots: moveCard(slots, from, target.slot, activeColumns, target.nudge === 'up'),
      selected: undefined,
    });
  });
  const dropPreview = drag.over;

  function toggleEditing() {
    setSaveError(false);
    drag.cancel();
    if (draft) setDraft(undefined);
    else if (current?.error) {
      setSaved(undefined);
      setReadAttempt((attempt) => attempt + 1);
    } else {
      setDraft({
        columns,
        slots: placeCards(items.map(({ id }) => id), current?.layout?.slots ?? []),
        hiddenDevices: [...hidden],
      });
    }
  }

  function selectSlot(slot: number) {
    if (!draft) return;
    const { selected } = draft;
    if (selected === undefined) setDraft({ ...draft, selected: slot });
    else setDraft({ ...draft, slots: moveCard(slots, selected, slot, activeColumns), selected: undefined });
  }

  function setDeviceVisibility(id: string, visible: boolean) {
    setDraft((value) => {
      if (!value) return value;
      const hiddenDevices = new Set(value.hiddenDevices);
      if (visible) hiddenDevices.delete(id);
      else hiddenDevices.add(id);
      return { ...value, hiddenDevices: [...hiddenDevices] };
    });
  }

  function renderSlot(id: string | null, column: number, index: number) {
    const slot = index * activeColumns + column;
    const row = index + 1;
    const item = id ? cards.get(id) : undefined;
    const style = { gridColumnStart: 1, gridRowStart: row };
    const content = [];
    if (item) {
      content.push(renderCard(item.entry, {
        style,
        inert: Boolean(draft) || undefined,
        slot: draft ? slot : undefined,
        nudge: dropPreview?.slot === slot ? dropPreview.nudge : undefined,
      }));
    }
    if (draft && (slot < EDITOR_SLOTS || item)) {
      content.push(
        <LayoutTarget
          key={`slot-${slot}`}
          slot={slot}
          row={row}
          column={column + 1}
          cardName={item?.cardName}
          selected={draft.selected === slot}
          moving={draft.selected !== undefined}
          disabled={saving}
          over={dropPreview?.slot === slot ? dropPreview.nudge : undefined}
          onSelect={(target) => selectSlot(target)}
        />,
      );
    } else if (!item) {
      content.push(<li key={`empty-${slot}`} className="dashboard-layout-gap" aria-hidden="true" style={style} />);
    }
    return content;
  }

  function renderColumn(column: number) {
    const limit = draft ? Math.max(EDITOR_SLOTS, slots.length) : slots.length;
    const count = Math.max(0, Math.ceil((limit - column) / activeColumns));
    const columnSlots = Array.from({ length: count }, (_, row) => slots[row * activeColumns + column] ?? null);
    const visibleSlots = draft ? columnSlots : trimSlots(columnSlots);
    return (
      <ul key={column} className="dashboard-device-column" data-dashboard-column={column + 1}>
        {visibleSlots.flatMap((id, row) => renderSlot(id, column, row))}
      </ul>
    );
  }

  async function saveLayout() {
    if (!viewKey || !draft || pendingSave.current) return;
    const request = Symbol('dashboard-layout-save');
    pendingSave.current = request;
    setSaving(true);
    setSaveError(false);
    try {
      const id = ensureDashboardBrowserId();
      const changes: DashboardLayout = { slots };
      if (hidden.size || draft.hiddenDevices.length) changes.hidden_devices = draft.hiddenDevices;
      const result = await api.saveDashboardLayout(id, viewKey, changes);
      setBrowserId(id);
      if (pendingSave.current !== request) return;
      setSaved({ api, view: viewKey, layout: result });
      setDraft(undefined);
      setShowAll(false);
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
        <div className="dashboard-layout-toolbar" data-editing={Boolean(draft) || undefined}>
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
          {!draft && hasHiddenDevices && (
            <button type="button" className="secondary compact" aria-pressed={showAll} onClick={() => setShowAll((value) => !value)}>
              {t(MSG.DASHBOARD_LAYOUT_SHOW_ALL)}
            </button>
          )}
          {draft && <p className="help">{t(MSG.DASHBOARD_LAYOUT_INSTRUCTIONS)}</p>}
          {saveError && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_SAVE_FAILED)}</p>}
          {current?.error && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_LOAD_FAILED)}</p>}
        </div>
      )}
      {draft && individualDevices.length > 0 && (
        <details className="dashboard-layout-visibility">
          <summary>{t(MSG.DASHBOARD_LAYOUT_DEVICE_VISIBILITY)}</summary>
          <ul>
            {individualDevices.map(({ id, cardName }) => (
              <li key={id}>
                <label htmlFor={`${visibilityId}-${id}`}>
                  <input
                    id={`${visibilityId}-${id}`}
                    type="checkbox"
                    checked={!draft.hiddenDevices.includes(id)}
                    disabled={saving}
                    onChange={(event) => setDeviceVisibility(id, event.target.checked)}
                  />
                  {cardName}
                </label>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div
        className="dashboard-device-grid"
        ref={grid}
        onPointerDown={(event) => drag.begin(event)}
        onPointerMove={(event) => drag.move(event)}
        onPointerUp={(event) => drag.finish(event)}
        onPointerCancel={() => drag.cancel()}
        onLostPointerCapture={() => drag.cancel()}
        onClickCapture={(event) => drag.ignoreDragClick(event)}
        style={{ gridTemplateColumns: `repeat(${activeColumns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: activeColumns }, (_, column) => renderColumn(column))}
      </div>
      <ul className="dashboard-layout-drag-layer" ref={drag.layer} aria-hidden="true" inert />
    </>
  );
}
