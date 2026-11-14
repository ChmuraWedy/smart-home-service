import type { MouseEventHandler, ReactNode } from 'react';
import { MSG, t } from '../i18n';
import { Switch } from './ui/switch';

export function DeviceActionButton({
  id, label, icon, disabled, onClick, pressed, title,
}:{
  id?:string;label:string;icon:ReactNode;disabled?:boolean;onClick:MouseEventHandler<HTMLButtonElement>;pressed?:boolean;title?:string;
}) {
  return (
    <button
      id={id}
      type="button"
      className="dashboard-power-button"
      data-slot="power-button"
      data-checked={pressed ? '' : undefined}
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >{icon}
    </button>
  );
}

export type PowerButtonVariant = 'switch' | 'dashboard-switch' | 'button';

export function PowerButton({
  id, label, checked, disabled, variant, icon, known, buttonText, onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  variant: PowerButtonVariant;
  icon?: ReactNode;
  known: boolean;
  buttonText?: string | ((value: boolean | null) => string);
  onChange: (checked: boolean) => void;
}) {
  function toggle() {
    onChange(!checked);
  }

  if (variant === 'button') {
    let content = icon;
    if (!content) {
      content = typeof buttonText === 'function'
        ? buttonText(known ? checked : null)
        : buttonText || t(checked ? MSG.TURN_OFF : MSG.TURN_ON);
    }
    const title = known ? t(checked ? MSG.TURN_OFF_PREFIX : MSG.TURN_ON_PREFIX) + label : undefined;
    if (icon) {
      return (
        <DeviceActionButton
          id={id}
          label={label}
          icon={icon}
          pressed={checked}
          title={title}
          disabled={disabled || !known}
          onClick={() => toggle()}
        />
      );
    }
    return (
      <button
        id={id}
        type="button"
        className={icon ? 'dashboard-power-button' : 'secondary compact mode-button'}
        data-slot={icon ? 'power-button' : undefined}
        data-checked={icon && checked ? '' : undefined}
        title={title}
        aria-label={label}
        aria-pressed={checked}
        disabled={disabled || !known}
        onClick={() => toggle()}
      >
        {content}
      </button>
    );
  }

  if (variant === 'dashboard-switch') {
    return (
      <Switch
        id={id}
        aria-label={label}
        powerIcon={icon}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  return (
    <button
      id={id}
      type="button"
      className="power-toggle"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => toggle()}
    >
      <span />
    </button>
  );
}
