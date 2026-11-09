import {
  useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  dashboardBrowserId, ensureDashboardBrowserId, MAX_LAYOUT_SLOTS, moveCard, placeCards, trimSlots,
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
  slot, row, column, cardName, selected, moving, disabled, over, visibility, onSelect,
}: {
  slot: number;
  row: number;
  column: number;
  cardName?: string;
  selected: boolean;
  moving: boolean;
  disabled: boolean;
  over?: DropTarget['nudge'];
  visibility?: { shown: boolean; toggle: () => void };
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
      {cardName && visibility && (
        <button
          type="button"
          className="secondary dashboard-layout-card-eye"
          aria-label={t(MSG.DASHBOARD_LAYOUT_CARD_VISIBILITY, [cardName])}
          aria-pressed={visibility.shown}
          title={t(MSG.DASHBOARD_LAYOUT_CARD_VISIBILITY, [cardName])}
          disabled={disabled}
          onClick={visibility.toggle}
        >
          <Icon name={visibility.shown ? 'eye' : 'eye-off'} />
        </button>
      )}
    </li>
  );
}

export default function DashboardGrid<T>({
  api, density, items, view, editable, editing, onEditingChange, navigation, roomAction, emptyState, renderCard,
}: {
  api: HomeApi;
  density: 'small' | 'large';
  items: GridItem<T>[];
  view?: GridView;
  editable: boolean;
  editing: boolean;
  onEditingChange: (value: boolean) => void;
  navigation?: ReactNode;
  roomAction?: ReactNode;
  emptyState?: ReactNode;
  renderCard: (item: T, placement: GridCardPlacement) => ReactNode;
}) {
  const { grid, columns } = useGridColumns(density);
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
    if (!viewKey || (!api.account && !browserId)) return undefined;
    const request = new AbortController();
    const pending = api.account
      ? api.accountDashboardLayout(viewKey, browserId, request.signal)
      : api.dashboardLayout(browserId ?? '', viewKey, request.signal);
    pending.then((layout) => {
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
  const hasHiddenDevices = items.some((item) => item.hideable && hidden.has(item.id));
  const showEditor = Boolean(editing || (viewKey && editable));

  useLayoutEffect(() => {
    if (editing) return;
    setDraft(undefined);
    setSaving(false);
    setSaveError(false);
    pendingSave.current = null;
  }, [editing]);

  useEffect(() => {
    if (!editing || !editable || !viewKey || draft || (browserId && !current?.layout)) return;
    setDraft({
      columns,
      slots: placeCards(items.map(({ id }) => id), current?.layout?.slots ?? []),
      hiddenDevices: current?.layout?.hidden_devices ?? [],
    });
  }, [editing, editable, viewKey, draft, browserId, current, columns, items]);

  const drag = useDashboardDrag(editing ? scope : undefined, (from, target) => {
    setDraft((value) => value && {
      ...value,
      slots: moveCard(slots, from, target.slot, activeColumns, target.nudge === 'up'),
      selected: undefined,
    });
  });
  const dropPreview = drag.over;

  function retryLayout() {
    setSaved(undefined);
    setReadAttempt((attempt) => attempt + 1);
  }

  function toggleEditing() {
    drag.cancel();
    if (current?.error && !editing) retryLayout();
    else onEditingChange(!editing);
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

  function renderSlot(id: string | null, column: number, index: number, appendTarget: boolean) {
    const slot = index * activeColumns + column;
    const row = index + 1;
    const item = id ? cards.get(id) : undefined;
    const isHidden = Boolean(item?.hideable && draft?.hiddenDevices.includes(item.id));
    const style = { gridColumnStart: 1, gridRowStart: row };
    const content = [];
    if (item) {
      content.push(renderCard(item.entry, {
        style: { ...style, opacity: isHidden ? 0.55 : undefined },
        inert: Boolean(draft) || undefined,
        slot: draft ? slot : undefined,
        nudge: dropPreview?.slot === slot ? dropPreview.nudge : undefined,
      }));
    }
    if (draft && (slot < EDITOR_SLOTS || item || appendTarget)) {
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
          visibility={item?.hideable ? {
            shown: !isHidden,
            toggle: () => setDeviceVisibility(item.id, isHidden),
          } : undefined}
          onSelect={(target) => selectSlot(target)}
        />,
      );
    } else if (!item) {
      content.push(<li key={`empty-${slot}`} className="dashboard-layout-gap" aria-hidden="true" style={style} />);
    }
    return content;
  }

  function renderColumn(column: number) {
    const columnSlots = trimSlots(slots.filter((_, slot) => slot % activeColumns === column));
    const appendRow = columnSlots.length;
    const canAppend = appendRow * activeColumns + column < MAX_LAYOUT_SLOTS;
    const editorRows = Math.ceil((EDITOR_SLOTS - column) / activeColumns);
    const rows = draft ? Math.max(editorRows, appendRow + Number(canAppend)) : appendRow;
    const visibleSlots = Array.from({ length: rows }, (_, row) => columnSlots[row] ?? null);
    return (
      <ul key={column} className="dashboard-device-column" data-dashboard-column={column + 1}>
        {visibleSlots.flatMap((id, row) => renderSlot(id, column, row, canAppend && row === appendRow))}
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
      const changes: DashboardLayout = { slots };
      if (hidden.size || draft.hiddenDevices.length) changes.hidden_devices = draft.hiddenDevices;
      let result;
      if (api.account) result = await api.saveAccountDashboardLayout(viewKey, changes);
      else {
        const id = ensureDashboardBrowserId();
        result = await api.saveDashboardLayout(id, viewKey, changes);
        setBrowserId(id);
      }
      if (pendingSave.current !== request) return;
      setSaved({ api, view: viewKey, layout: result });
      setShowAll(false);
      onEditingChange(false);
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
  let editIcon: 'edit' | 'close' | 'refresh-list' = 'edit';
  if (editing) {
    editLabel = t(MSG.CANCEL);
    editIcon = 'close';
  } else if (current?.error) {
    editLabel = t(MSG.RETRY_DASHBOARD_LAYOUT);
    editIcon = 'refresh-list';
  }

  return (
    <>
      {(navigation || showEditor) && (
        <div className="dashboard-layout-toolbar" data-editing={editing || undefined}>
          <div className="dashboard-layout-heading">
            {navigation && <div className="dashboard-layout-room">{navigation}</div>}
            {showEditor && (
              <div className="dashboard-layout-actions">
                <button
                  type="button"
                  className="secondary dashboard-layout-icon"
                  aria-label={editLabel}
                  data-tour="room-layout"
                  title={editLabel}
                  disabled={saving || (!editing && ((!current?.error && !items.length && !roomAction) || Boolean((api.account || browserId) && !current)))}
                  onClick={toggleEditing}
                >
                  <Icon name={editIcon} />
                </button>
                {draft ? (
                  <button type="button" className="primary compact" disabled={saving} onClick={() => saveLayout()}>
                    {saving ? t(MSG.SAVING).trim() : t(MSG.SAVE)}
                  </button>
                ) : !editing && (
                  <button
                    type="button"
                    className="secondary dashboard-layout-icon"
                    aria-label={t(MSG.DASHBOARD_LAYOUT_SHOW_HIDDEN)}
                    aria-pressed={showAll}
                    title={t(hasHiddenDevices ? MSG.DASHBOARD_LAYOUT_SHOW_HIDDEN : MSG.DASHBOARD_LAYOUT_NONE_HIDDEN)}
                    disabled={!hasHiddenDevices}
                    onClick={() => setShowAll((value) => !value)}
                  >
                    <Icon name={showAll ? 'eye' : 'eye-off'} />
                  </button>
                )}
              </div>
            )}
          </div>
          {draft && <p className="help">{t(MSG.DASHBOARD_LAYOUT_INSTRUCTIONS)}</p>}
          {saveError && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_SAVE_FAILED)}</p>}
          {current?.error && <p className="field-error" role="alert">{t(MSG.DASHBOARD_LAYOUT_LOAD_FAILED)}</p>}
          {editing && current?.error && (
            <button type="button" className="secondary compact" onClick={retryLayout}>
              {t(MSG.RETRY_DASHBOARD_LAYOUT)}
            </button>
          )}
        </div>
      )}
      {draft && roomAction}
      {emptyState}
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
