import type { ReactNode } from 'react';
import { DashboardAliases } from './DashboardAliases';
import { Icon } from './ui/icon';

export function CardDetailsButton({ label, disabled, onClick }: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="secondary tile-icon-action"
      data-tour="device-settings"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="settings" />
    </button>
  );
}

export function DashboardCardHeader({
  icon, title, aliases, metadata, actions, secondary,
}: {
  icon: ReactNode;
  title: ReactNode;
  aliases?: string[];
  metadata: ReactNode;
  actions: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <header className="dashboard-card-header" data-slot="card-header">
      <span className="device-symbol" aria-hidden="true">{icon}</span>
      <div className="device-card-identity">
        <div className="device-card-title">
          <h3 title={typeof title === 'string' ? title : undefined}>{title}</h3>
          {!!aliases?.length && <DashboardAliases aliases={aliases} />}
        </div>
        <div className="device-card-context">{metadata}</div>
      </div>
      <div className="device-card-actions">{actions}</div>
      {secondary && <div className="dashboard-card-subheader">{secondary}</div>}
    </header>
  );
}
