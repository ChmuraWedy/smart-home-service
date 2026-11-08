import { useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

export type DropTarget = { slot: number; nudge: 'up' | 'down' };
type PointerDrag = {
  pointer: number;
  slot: number;
  x: number;
  y: number;
  bounds: DOMRect;
  source: HTMLElement;
  active: boolean;
};
type ScrollPointer = { grid: HTMLDivElement; x: number; y: number };

function edgeScrollDelta(y: number) {
  const edge = Math.min(120, window.innerHeight / 4);
  const bottom = window.innerHeight - edge;
  if (y < edge) return -Math.ceil(16 * ((edge - y) / edge));
  if (y > bottom) return Math.ceil(16 * ((y - bottom) / edge));
  return 0;
}

function dropTarget(grid: HTMLDivElement, x: number, y: number): DropTarget | undefined {
  const hit = document.elementFromPoint(x, y);
  const target = hit?.closest<HTMLElement>('[data-layout-target]')
    ?? hit?.closest('.dashboard-layout-target')?.querySelector<HTMLElement>('[data-layout-target]');
  if (!target || !grid.contains(target)) return undefined;
  const { top, height } = target.getBoundingClientRect();
  return { slot: Number(target.dataset.layoutTarget), nudge: y < top + height / 2 ? 'down' : 'up' };
}

export default function useDashboardDrag(scope: string | undefined, onDrop: (from: number, target: DropTarget) => void) {
  const layer = useRef<HTMLUListElement>(null);
  const gesture = useRef<PointerDrag | undefined>(undefined);
  const edgePointer = useRef<ScrollPointer | undefined>(undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);
  const [over, setOver] = useState<DropTarget>();

  function cancel() {
    gesture.current = undefined;
    edgePointer.current = undefined;
    if (scrollFrame.current !== undefined) {
      window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = undefined;
    }
    layer.current?.replaceChildren();
    setOver(undefined);
  }

  useLayoutEffect(() => {
    gesture.current = undefined;
    suppressClick.current = false;
    layer.current?.replaceChildren();
    setOver(undefined);
    return () => {
      if (scrollFrame.current !== undefined) window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = undefined;
      edgePointer.current = undefined;
    };
  }, [scope]);

  function begin(event: PointerEvent<HTMLDivElement>) {
    suppressClick.current = false;
    if (event.button !== 0 || event.pointerType === 'touch' || gesture.current) return;
    if (!(event.target instanceof Element)) return;
    const handle = event.target.closest<HTMLElement>('[data-layout-target][data-occupied]');
    if (!handle) return;
    const slot = Number(handle.dataset.layoutTarget);
    const source = event.currentTarget.querySelector<HTMLElement>(`[data-layout-slot="${slot}"]`);
    if (!source) return;
    const { clientX: x, clientY: y, pointerId: pointer } = event;
    gesture.current = {
      pointer, slot, x, y, source, bounds: source.getBoundingClientRect(), active: false,
    };
    handle.setPointerCapture(pointer);
  }

  function showTarget({ grid, x, y }: ScrollPointer, sourceSlot: number) {
    const target = dropTarget(grid, x, y);
    const next = target?.slot !== sourceSlot ? target : undefined;
    setOver((previous) => (previous?.slot === next?.slot && previous?.nudge === next?.nudge ? previous : next));
  }

  function scrollAtEdge() {
    scrollFrame.current = undefined;
    const pointer = edgePointer.current;
    const drag = gesture.current;
    if (!pointer || !drag?.active) return;
    const delta = edgeScrollDelta(pointer.y);
    if (!delta) return;
    const previous = window.scrollY;
    window.scrollBy({ top: delta, behavior: 'instant' });
    if (window.scrollY === previous) return;
    showTarget(pointer, drag.slot);
    scrollFrame.current = window.requestAnimationFrame(scrollAtEdge);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const drag = gesture.current;
    const preview = layer.current;
    if (!drag || drag.pointer !== event.pointerId || !preview) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 5) return;
      const copy = drag.source.cloneNode(true) as HTMLElement;
      copy.removeAttribute('id');
      copy.removeAttribute('data-layout-slot');
      copy.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
      copy.style.width = `${drag.bounds.width}px`;
      preview.replaceChildren(copy);
      drag.active = true;
      suppressClick.current = true;
    }
    event.preventDefault();
    preview.style.transform = `translate(${drag.bounds.left + dx}px, ${drag.bounds.top + dy}px)`;
    const pointer = { grid: event.currentTarget, x: event.clientX, y: event.clientY };
    showTarget(pointer, drag.slot);
    edgePointer.current = pointer;
    if (scrollFrame.current === undefined && edgeScrollDelta(pointer.y)) {
      scrollFrame.current = window.requestAnimationFrame(scrollAtEdge);
    }
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const target = drag.active ? dropTarget(event.currentTarget, event.clientX, event.clientY) : undefined;
    cancel();
    if (target) onDrop(drag.slot, target);
  }

  function ignoreDragClick(event: MouseEvent<HTMLDivElement>) {
    if (!suppressClick.current || !event.detail) return;
    event.stopPropagation();
    suppressClick.current = false;
  }

  return {
    layer, over, begin, move, finish, cancel, ignoreDragClick,
  };
}
