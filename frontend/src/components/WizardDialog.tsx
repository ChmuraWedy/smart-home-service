import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function WizardDialog({ title, description, children, actions, onClose }: {
  title: string; description?: string; children: ReactNode; actions: ReactNode; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="schedule-wizard control-dialog" aria-label={'Настройка: ' + title} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header className="wizard-header"><h2>{title}</h2><button type="button" className="secondary wizard-close" aria-label="Закрыть мастер" title="Закрыть" onClick={onClose}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
    <div className="wizard-body">{description && <p className="wizard-description">{description}</p>}{children}</div>
    <footer className="wizard-actions"><button className="secondary" type="button" onClick={onClose}>Отмена</button>{actions}</footer>
  </dialog>;
}
