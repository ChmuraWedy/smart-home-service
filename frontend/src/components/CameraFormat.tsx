import { MSG, t, translateText } from "../i18n";
import { useRef, useState, type ReactNode } from 'react';
import { ControlDialog } from './DeviceControls';

export function CameraFormat({disabled,onFormat,information}: {disabled:boolean;information?:ReactNode;onFormat:()=>Promise<unknown>}) {
  const [open,setOpen]=useState(false), [pending,setPending]=useState(false), [error,setError]=useState('');
  const lock=useRef(false);
  async function format() {
    if (disabled || lock.current) return;
    lock.current=true; setPending(true); setError('');
    try {await onFormat(); setOpen(false);} catch {setError(t(MSG.COULD_NOT_SEND_THE_FORMATTING_COMMAND));}
    finally {lock.current=false; setPending(false);}
  }
  return (
    <section className="capability camera-format" aria-label={t(MSG.FORMAT_MEMORY_CARD)}>
      <div className="capability-row">
        <div className="capability-heading">
          <div className="capability-label-line">
            <h3>{t(MSG.FORMAT_MEMORY_CARD)}</h3>{information}
          </div>
        </div>
        <button type="button" className="secondary compact" disabled={disabled || pending} onClick={()=>{setError(''); setOpen(true);}}>{t(MSG.FORMAT)}</button>
      </div>
      {open && (
      <ControlDialog title={t(MSG.FORMAT_MEMORY_CARD)} busy={pending} onClose={()=>setOpen(false)} className="camera-format-dialog">
        <p>{t(MSG.ALL_RECORDINGS_ON_THE_MEMORY_CARD_WILL_BE)}</p>
        {error && <p className="error" role="alert">{translateText(error)}</p>}
        <div className="camera-format-actions">
          <button type="button" className="secondary" disabled={pending} onClick={()=>setOpen(false)}>{t(MSG.CANCEL)}</button>
          <button type="button" disabled={disabled || pending} onClick={()=>void format()}>{pending ? t(MSG.SENDING) : t(MSG.FORMAT_CARD)}</button>
        </div>
      </ControlDialog>
)}
    </section>
  );
}
