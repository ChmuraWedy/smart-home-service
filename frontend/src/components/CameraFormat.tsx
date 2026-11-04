import { t } from "../i18n";
import { useRef, useState, type ReactNode } from 'react';
import { ControlDialog } from './DeviceControls';

export function CameraFormat({disabled,onFormat,information}: {disabled:boolean;information?:ReactNode;onFormat:()=>Promise<unknown>}) {
  const [open,setOpen]=useState(false), [pending,setPending]=useState(false), [error,setError]=useState('');
  const lock=useRef(false);
  async function format() {
    if (disabled || lock.current) return;
    lock.current=true; setPending(true); setError('');
    try {await onFormat(); setOpen(false);} catch {setError(t("Не удалось отправить команду форматирования."));}
    finally {lock.current=false; setPending(false);}
  }
  return <section className="capability camera-format" aria-label={t("Форматирование карты памяти")}>
    <div className="capability-row"><div className="capability-heading"><div className="capability-label-line"><h3>{t("Форматирование карты памяти")}</h3>{information}</div></div>
      <button type="button" className="secondary compact" disabled={disabled || pending} onClick={()=>{setError(''); setOpen(true);}}>{t("Форматировать…")}</button>
    </div>
    {open && <ControlDialog title={t("Форматирование карты памяти")} busy={pending} onClose={()=>setOpen(false)} className="camera-format-dialog">
      <p>{t("Все записи на карте памяти будут удалены. Восстановить их после форматирования нельзя.")}</p>
      {error && <p className="error" role="alert">{t(error)}</p>}
      <div className="camera-format-actions"><button type="button" className="secondary" disabled={pending} onClick={()=>setOpen(false)}>{t("Отмена")}</button><button type="button" disabled={disabled || pending} onClick={()=>void format()}>{pending ? t("Отправляем…") : t("Форматировать карту")}</button></div>
    </ControlDialog>}
  </section>;
}
