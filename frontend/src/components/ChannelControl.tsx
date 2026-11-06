import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { ControlSpec } from '../controls';
import { Icon } from './ui/icon';

// Pair only numbered channels with the timer reported for the same channel.
export function channelTimer(spec:ControlSpec, specs:ControlSpec[]) {
  const channel = /^switch_([1-9][0-9]*)$/.exec(spec.key)?.[1];
  return channel ? specs.find(item => item.key === 'countdown_' + channel && item.kind === 'number') : undefined;
}

export function ChannelControl({spec,timer,renderField}: {
  spec:ControlSpec; timer?:ControlSpec; renderField:(spec:ControlSpec,headingActions?:ReactNode)=>ReactNode;
}) {
  const [open,setOpen] = useState(false), panelId = useId();
  return <div className="channel-control">
    {renderField(spec, timer && <button
      type="button"
      className="secondary channel-timer-toggle"
      aria-label={timer.label}
      title={timer.label}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen(value => !value)}
    >
      <Icon name="clock" />
    </button>)}
    {timer && <div id={panelId} className="channel-timer-panel" hidden={!open}>{renderField(timer)}</div>}
  </div>;
}
