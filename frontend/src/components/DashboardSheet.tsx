import { useEffect, useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { t } from '../i18n';

export type DashboardSheetState = {
  open: boolean;
  close: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
};

export function DashboardSheet({ title, onClose, returnFocus, children }: { title: string; onClose: () => void; returnFocus?: RefObject<HTMLElement | null>; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dragStart = useRef<number | null>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current!;
    const active = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      const trigger = returnFocus?.current ?? active;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  return <dialog ref={dialog} className="dashboard-sheet" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => event.stopPropagation()}>
    <div className="dashboard-sheet-handle" aria-hidden="true"
      onPointerDown={event => { dragStart.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerCancel={() => { dragStart.current = null; }}
      onPointerUp={event => {
        if (dragStart.current !== null && event.clientY - dragStart.current > 48) onClose();
        dragStart.current = null;
      }}><span /></div>
    <header className="dashboard-sheet-heading">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="secondary" aria-label={t("Закрыть")} onClick={onClose}>×</button>
    </header>
    {children}
  </dialog>;
}
