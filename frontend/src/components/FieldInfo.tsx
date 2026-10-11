import { useEffect, useId, useRef, useState } from 'react';

export function FieldInfo({label,text}: {label:string;text:string}) {
  const [open,setOpen] = useState(false), id=useId(), container=useRef<HTMLSpanElement>(null), button=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if (!open) return;
    const outside=(event:PointerEvent)=>{if (!container.current?.contains(event.target as Node)) setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if (event.key==='Escape') {event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus();}};
    document.addEventListener('pointerdown',outside); document.addEventListener('keydown',escape,true);
    return ()=>{document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',escape,true);};
  },[open]);
  return <span className="field-info" ref={container}>
    <button ref={button} type="button" className="secondary field-info-button" aria-label={'Подробнее: '+label} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}>i</button>
    {open && <span id={id} className="field-info-panel" role="note" aria-label={label}>
      <button type="button" className="secondary" aria-label="Закрыть пояснение" onClick={()=>{setOpen(false); button.current?.focus();}}>×</button>{text}
    </span>}
  </span>;
}
