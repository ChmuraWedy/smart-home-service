import type { ReactNode } from 'react';
import { MSG, t } from '../i18n';
import { Switch } from './ui/switch';

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
        onClick={toggle}
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
      onClick={toggle}
    >
      <span />
    </button>
  );
}
