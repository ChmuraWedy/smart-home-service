import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { ControlSpec } from '../controls';
import { MSG, t } from '../i18n';
import { Icon } from './ui/icon';

export function ChannelControl({ spec, renderField }: {
  spec: ControlSpec;
  renderField: (spec: ControlSpec) => ReactNode;
}) {
  return <div className="channel-control">{renderField(spec)}</div>;
}

export function RelayChannel({
  spec, renderField, children,
}: {
  spec: ControlSpec;
  renderField: (spec: ControlSpec) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const panelId = useId();

  return (
    <div className="combined-relay-channel" data-relay-channel={spec.key}>
      <div className="combined-relay-heading">
        <ChannelControl spec={spec} renderField={renderField} />
        <button
          type="button"
          className="secondary combined-relay-toggle"
          aria-label={t(MSG.COMBINED_CHANNEL_DEVICES, [spec.label])}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="chevron-down" />
        </button>
      </div>
      <div id={panelId} className="combined-relay-devices" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
