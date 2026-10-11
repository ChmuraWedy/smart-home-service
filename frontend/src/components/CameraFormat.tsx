import { useRef, useState } from 'react';
import { ControlDialog } from './DeviceControls';

export function CameraFormat({disabled,onFormat}: {disabled:boolean;onFormat:()=>Promise<unknown>}) {
  const [open,setOpen]=useState(false), [pending,setPending]=useState(false), [error,setError]=useState('');
  const lock=useRef(false);
  async function format() {
    if (disabled || lock.current) return;
    lock.current=true; setPending(true); setError('');
    try {await onFormat(); setOpen(false);} catch {setError('Не удалось отправить команду форматирования.');}
    finally {lock.current=false; setPending(false);}
  }
  return <section className="capability camera-format" aria-label="Форматирование карты памяти">
    <div className="capability-row"><div className="capability-heading"><h3>Форматирование карты памяти</h3></div>
      <button type="button" className="secondary compact" disabled={disabled || pending} onClick={()=>{setError(''); setOpen(true);}}>Форматировать…</button>
    </div>
    {open && <ControlDialog title="Форматирование карты памяти" busy={pending} onClose={()=>setOpen(false)} className="camera-format-dialog">
      <p>Все записи на карте памяти будут удалены. Восстановить их после форматирования нельзя.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="camera-format-actions"><button type="button" className="secondary" disabled={pending} onClick={()=>setOpen(false)}>Отмена</button><button type="button" disabled={disabled || pending} onClick={()=>void format()}>{pending ? 'Отправляем…' : 'Форматировать карту'}</button></div>
    </ControlDialog>}
  </section>;
}
