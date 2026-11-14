import { MSG, t } from '../i18n';

export default function CameraMovementControls({ disabled, onMove, onStop }:{
  disabled:boolean;onMove:(direction:string)=>void;onStop:()=>void;
}) {
  return (
    <div className="camera-ptz" role="group" aria-label={t(MSG.CAMERA_MOVEMENT)}>
      {([
        ['up', '↑', MSG.CAMERA_MOVE_UP], ['left', '←', MSG.CAMERA_MOVE_LEFT],
        ['right', '→', MSG.CAMERA_MOVE_RIGHT], ['down', '↓', MSG.CAMERA_MOVE_DOWN],
      ] as const).map(([direction, glyph, label]) => (
        <button
          key={direction}
          type="button"
          className={`secondary compact camera-ptz-${direction}`}
          aria-label={t(label)}
          disabled={disabled}
          onClick={() => onMove(direction)}
        >{glyph}
        </button>
      ))}
      <button type="button" className="secondary compact camera-ptz-stop" onClick={onStop}>{t(MSG.STOP)}</button>
    </div>
  );
}
