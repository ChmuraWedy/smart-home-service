import type { ReactNode } from 'react';
import combinedLayout from '../combined-layout';
import { labelFor } from '../controls';
import { useDeviceDisplayName } from '../devices';
import { MSG, t } from '../i18n';
import type { ResolvedMember } from './CombinedDeviceCard';
import { Icon } from './ui/icon';

export default function CombinedDeviceOrder({ members, disabled, onMove }: {
  members: ResolvedMember[];
  disabled: boolean;
  onMove: (id: string, neighbor: string) => void;
}) {
  const displayName = useDeviceDisplayName();
  const { roots, channels } = combinedLayout(members);

  function renderSiblings(siblings: ResolvedMember[]): ReactNode {
    return (
      <ol className="combined-order-list">
        {siblings.map(({ member, device }, index) => {
          const id = member.device_id;
          const name = displayName(device, id);
          const groups = channels.get(id);
          const up = siblings[index - 1]?.member.device_id;
          const down = siblings[index + 1]?.member.device_id;
          return (
            <li key={id}>
              <div className="combined-order-row">
                <span>{name}</span>
                <button
                  className="secondary compact"
                  type="button"
                  aria-label={t(MSG.COMBINED_MOVE_MEMBER_UP, [name])}
                  disabled={!up}
                  onClick={() => up && onMove(id, up)}
                >
                  <Icon name="chevron-down" className="tw:rotate-180" />
                </button>
                <button
                  className="secondary compact"
                  type="button"
                  aria-label={t(MSG.COMBINED_MOVE_MEMBER_DOWN, [name])}
                  disabled={!down}
                  onClick={() => down && onMove(id, down)}
                >
                  <Icon name="chevron-down" />
                </button>
              </div>
              {groups && Array.from(groups, ([code, entries]) => (
                <div className="combined-order-channel" key={code}>
                  <p className="help">{labelFor(code)}</p>
                  {renderSiblings(entries)}
                </div>
              ))}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <fieldset className="combined-order" disabled={disabled}>
      <legend>{t(MSG.COMBINED_DEVICE_ORDER)}</legend>
      <p className="help">{t(MSG.COMBINED_DEVICE_ORDER_HELP)}</p>
      {renderSiblings(roots)}
    </fieldset>
  );
}
