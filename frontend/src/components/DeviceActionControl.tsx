import { useId } from 'react';
import type { MouseEventHandler, ReactNode } from 'react';
import ControlRow from './ControlRow';
import { DeviceActionButton } from './PowerButton';
import { MSG, t } from '../i18n';

// Shared device row: the same icon tile, heading and state used by power controls.
export default function DeviceActionControl({
  label, icon, onClick, disabled = false, checked, toggle = false, title,
}:{
  label:string;icon:ReactNode;onClick:MouseEventHandler<HTMLButtonElement>;disabled?:boolean;
  checked?:boolean|null;toggle?:boolean;title?:string;
}) {
  const id = useId();
  let state:Parameters<typeof t>[0] = MSG.NO_DATA;
  if (typeof checked === 'boolean') state = checked ? MSG.ON : MSG.OFF;
  return (
    <section className="capability capability-boolean">
      <ControlRow
        heading={(
          <div className="capability-heading">
            <div className="capability-label">
              <h3>{label}</h3>
            </div>
          </div>
        )}
        state={toggle && <span className="dashboard-power-state">{t(state)}</span>}
        power={(
          <div className="power-actions">
            {toggle ? (
              <DeviceActionButton
                id={id}
                label={label}
                icon={icon}
                pressed={checked === true}
                title={title}
                disabled={disabled || typeof checked !== 'boolean'}
                onClick={onClick}
              />
            ) : (
              <DeviceActionButton
                id={id}
                label={label}
                icon={icon}
                title={title}
                disabled={disabled}
                onClick={onClick}
              />
            )}
          </div>
        )}
      />
    </section>
  );
}
