import { Switch as HeadlessSwitch } from '@headlessui/react';
import type { ComponentProps, KeyboardEvent, ReactNode } from 'react';

export function Switch({ powerIcon, ...props }: ComponentProps<typeof HeadlessSwitch> & { powerIcon?: ReactNode }) {
  return (
    <HeadlessSwitch
      data-slot={powerIcon ? 'power-button' : 'switch'}
      className={powerIcon ? 'dashboard-power-button' : 'tw:group tw:relative tw:inline-flex tw:size-11 tw:shrink-0 tw:items-center tw:rounded-full tw:before:absolute tw:before:inset-x-0 tw:before:h-6 tw:before:rounded-full tw:before:bg-(--toggle-off) tw:data-checked:before:bg-(--accent)'}
      {...props}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        // Keep Enter activation alongside the Space handling built into Headless UI.
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
    >
      {powerIcon || <span
        aria-hidden="true"
        data-slot="switch-thumb"
        className="tw:pointer-events-none tw:relative tw:ml-[3px] tw:block tw:size-[18px] tw:rounded-full tw:bg-(--toggle-thumb) tw:transition-transform tw:motion-reduce:transition-none tw:group-data-checked:translate-x-5 tw:group-data-checked:bg-(--on-accent)"
      />}
    </HeadlessSwitch>
  );
}
