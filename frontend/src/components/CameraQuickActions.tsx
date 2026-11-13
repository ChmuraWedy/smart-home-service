import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';

export default function CameraQuickActions({
  onOpen, onPrivacy, privacy, disabled, privacyDisabled = false, frameDisabled = false,
}:{
  onOpen:()=>void;onPrivacy?:()=>void;privacy?:boolean|null;disabled:boolean;privacyDisabled?:boolean;frameDisabled?:boolean;
}) {
  return (
    <div className="camera-quick-actions" role="group" aria-label={t(MSG.CAMERA_ACTIONS)}>
      <button type="button" className="secondary camera-quick-action" disabled={disabled || frameDisabled} onClick={onOpen}>
        <Icon name="frame" />
        <span>{t(MSG.CAMERA_OPEN_FRAME)}</span>
      </button>
      <button
        type="button"
        className="secondary camera-quick-action"
        aria-pressed={privacy === true}
        disabled={disabled || privacyDisabled || typeof privacy !== 'boolean' || !onPrivacy}
        onClick={onPrivacy}
      >
        <Icon name="shield" />
        <span>{t(MSG.PRIVACY)}</span>
      </button>
    </div>
  );
}
