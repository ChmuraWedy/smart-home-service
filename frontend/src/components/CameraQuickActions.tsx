import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';
import DeviceActionControl from './DeviceActionControl';

export default function CameraQuickActions({
  onOpen, onPrivacy, privacy, disabled, privacyDisabled = false, frameDisabled = false,
}:{
  onOpen:(button:HTMLButtonElement)=>void;onPrivacy?:()=>void;privacy?:boolean|null;disabled:boolean;privacyDisabled?:boolean;frameDisabled?:boolean;
}) {
  return (
    <div data-power-layout="single" role="group" aria-label={t(MSG.CAMERA_ACTIONS)}>
      <DeviceActionControl
        label={t(MSG.CAMERA_OPEN_FRAME)}
        icon={<Icon name="frame" className="parameter-icon" />}
        disabled={disabled || frameDisabled}
        onClick={(event) => onOpen(event.currentTarget)}
      />
      <DeviceActionControl
        label={t(MSG.PRIVACY)}
        icon={<Icon name="shield" className="parameter-icon" />}
        disabled={disabled || privacyDisabled || !onPrivacy}
        toggle
        checked={privacy}
        onClick={() => onPrivacy?.()}
      />
    </div>
  );
}
