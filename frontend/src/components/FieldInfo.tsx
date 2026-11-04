import { t } from "../i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export function FieldInfo({label,text}: {label:string;text:string}) {
  const [open,setOpen] = useState(false), id=useId(), container=useRef<HTMLSpanElement>(null), button=useRef<HTMLButtonElement>(null);
  const panel=useRef<HTMLSpanElement>(null);
  const [position,setPosition]=useState<{left:number;top:number}>();
  useLayoutEffect(()=>{
    if (!open || !button.current || !panel.current) return;
    const anchor=button.current.getBoundingClientRect(), bounds=panel.current.getBoundingClientRect();
    setPosition({left:Math.max(16,Math.min(anchor.left,window.innerWidth-bounds.width-16)),top:Math.max(16,Math.min(anchor.bottom+6,window.innerHeight-bounds.height-16))});
  },[open]);
  useEffect(()=>{
    if (!open) return;
    const outside=(event:PointerEvent)=>{if (!container.current?.contains(event.target as Node)) setOpen(false);};
    const reposition=()=>setOpen(false);
    const escape=(event:KeyboardEvent)=>{if (event.key==='Escape') {event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus();}};
    document.addEventListener('pointerdown',outside); document.addEventListener('keydown',escape,true);
    window.addEventListener('resize',reposition);
    const scroll=(event:Event)=>{if (!panel.current?.contains(event.target as Node)) setOpen(false);};
    document.addEventListener('scroll',scroll,true);
    return ()=>{document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',escape,true); window.removeEventListener('resize',reposition); document.removeEventListener('scroll',scroll,true);};
  },[open]);
  return <span className="field-info" ref={container}>
    <button ref={button} type="button" className="secondary field-info-button" aria-label={t("Подробнее: ")+label} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}>i</button>
    {open && <span ref={panel} style={position} id={id} className="field-info-panel" role="note" aria-label={label}>
      <button type="button" className="secondary" aria-label={t("Закрыть пояснение")} onClick={()=>{setOpen(false); button.current?.focus();}}>×</button>{text}
    </span>}
  </span>;
}
