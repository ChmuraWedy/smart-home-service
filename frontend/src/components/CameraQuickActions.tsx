import { useId } from 'react';
import type { ReactNode } from 'react';
import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';
import { DeviceActionButton, PowerButton } from './PowerButton';

export default function CameraQuickActions({
  onOpen, onPrivacy, privacy, disabled, privacyDisabled = false, frameDisabled = false, showPrivacy = true, children,
}:{
  onOpen:(button:HTMLButtonElement)=>void;onPrivacy?:()=>void;privacy?:boolean|null;disabled:boolean;
  privacyDisabled?:boolean;frameDisabled?:boolean;showPrivacy?:boolean;children?:ReactNode;
}) {
  const privacyId = useId();
  let privacyState = t(MSG.NO_DATA);
  if (typeof privacy === 'boolean') privacyState = t(privacy ? MSG.ON : MSG.OFF);
  return (
    <div className="camera-quick-actions" role="group" aria-label={t(MSG.CAMERA_ACTIONS)}>
      <DeviceActionButton
        label={t(MSG.CAMERA_OPEN_FRAME)}
        title={t(MSG.CAMERA_OPEN_FRAME)}
        icon={<Icon name="frame" className="parameter-icon" />}
        disabled={disabled || frameDisabled}
        onClick={(event) => onOpen(event.currentTarget)}
      />
      {showPrivacy && (
        <PowerButton
          id={privacyId}
          label={t(MSG.PRIVACY)}
          title={`${t(MSG.PRIVACY)}: ${privacyState}`}
          variant="dashboard-switch"
          checked={privacy === true}
          known={typeof privacy === 'boolean'}
          icon={<Icon name="shield" className="parameter-icon" />}
          disabled={disabled || privacyDisabled || !onPrivacy || typeof privacy !== 'boolean'}
          onChange={() => onPrivacy?.()}
        />
      )}
      {children}
    </div>
  );
}
