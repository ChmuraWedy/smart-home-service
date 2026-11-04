import { t } from "../i18n";
import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { CloudApi, Provider } from '../api';
import { encodeArea, parseArea, shiftArea, validArea } from '../camera-area';
import type { Area } from '../camera-area';
import { ControlDialog } from './DeviceControls';
import { CameraLive } from './CameraLive';

export function CameraArea({value,disabled,onChange,api,deviceId,provider,onAuthError,viewingBlocked}:{value:string;disabled:boolean;onChange:(value:string)=>void;api:CloudApi;deviceId:string;provider:Provider;onAuthError:()=>void;viewingBlocked?:string}) {
  const [editing,setEditing]=useState<ReturnType<typeof parseArea>>(null);
  const parsed=parseArea(value);
  return <div className="camera-area-launch">
    <button type="button" className="secondary compact" disabled={disabled || !parsed} onClick={()=>setEditing(parsed)}>{t("Изменить область")}</button>
    {!parsed && value && <p className="help">{t("Формат области этой камеры не поддерживается графическим редактором. Исходные данные сохранены.")}</p>}
    {editing && <AreaDialog viewingBlocked={viewingBlocked} initial={editing} api={api} deviceId={deviceId} provider={provider} onAuthError={onAuthError} onClose={()=>setEditing(null)} onSave={area=>{onChange(encodeArea(editing.document,area)); setEditing(null);}} />}
  </div>;
}

function AreaDialog({initial,api,deviceId,provider,onAuthError,onClose,onSave,viewingBlocked}:{initial:NonNullable<ReturnType<typeof parseArea>>;api:CloudApi;deviceId:string;provider:Provider;onAuthError:()=>void;onClose:()=>void;onSave:(area:Area)=>void;viewingBlocked?:string}) {
  const [area,setArea]=useState(initial.area), surface=useRef<HTMLDivElement>(null);
  const drag=useRef<{x:number;y:number;width:number;height:number;area:Area;resize:boolean}|null>(null);
  function begin(event:PointerEvent<HTMLButtonElement>,resize:boolean) {
    if (event.button!==0 || !validArea(area)) return;
    event.preventDefault();
    event.currentTarget.focus();
    const bounds=surface.current!.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    drag.current={x:event.clientX,y:event.clientY,width:bounds.width,height:bounds.height,area,resize};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event:PointerEvent<HTMLButtonElement>) {
    const start=drag.current;
    if (start) setArea(shiftArea(start.area,(event.clientX-start.x)*100/start.width,(event.clientY-start.y)*100/start.height,start.resize));
  }
  function key(event:KeyboardEvent<HTMLButtonElement>,resize:boolean) {
    const delta:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if (!delta[event.key] || !validArea(area)) return;
    event.preventDefault(); const [x,y]=delta[event.key]; setArea(shiftArea(area,x,y,resize));
  }
  const overlay=<div className="camera-area-surface" ref={surface}>
    <div className="camera-area-box" style={{left:area.x+'%',top:area.y+'%',width:area.xlen+'%',height:area.ylen+'%'}}>
      <button type="button" className="camera-area-move" aria-label={t("Переместить область")} onPointerDown={event=>begin(event,false)} onPointerMove={move} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onKeyDown={event=>key(event,false)} />
      <button type="button" className="camera-area-resize" aria-label={t("Изменить размер области")} onPointerDown={event=>begin(event,true)} onPointerMove={move} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onKeyDown={event=>key(event,true)}>↘</button>
    </div>
  </div>;
  return <ControlDialog title={t("Область обнаружения")} busy={false} onClose={onClose} className="camera-area-dialog">
    <div className="camera-area-body">
    <p className="help">{t("Переместите красную рамку и потяните её угол. Стрелки клавиатуры также перемещают рамку или меняют её размер.")}</p>
    <CameraLive viewingBlocked={viewingBlocked} api={api} deviceId={deviceId} provider={provider} onAuthError={onAuthError} compact overlay={overlay} />
    <div className="camera-area-values">{(['x','y','xlen','ylen'] as const).map(key=><label key={key}>{({x:t("Слева"),y:t("Сверху"),xlen:t("Ширина"),ylen:t("Высота")})[key]} (%)<input type="number" min={key==='x'||key==='y'?0:1} max={100} step={1} value={area[key]} onChange={event=>setArea({...area,[key]:Number(event.target.value)})} /></label>)}</div>
    {!validArea(area) && <p role="alert" className="error">{t("Область должна целиком находиться внутри изображения и иметь ненулевой размер.")}</p>}
    <p className="help">{t("«Сохранить» перенесёт область в настройки. Для отправки камере нажмите «Применить» в подробной карточке.")}</p>
    </div>
    <div className="camera-format-actions camera-area-footer"><button type="button" className="secondary" onClick={onClose}>{t("Отмена")}</button><button type="button" disabled={!validArea(area)} onClick={()=>onSave(area)}>{t("Сохранить")}</button></div>
  </ControlDialog>;
}
