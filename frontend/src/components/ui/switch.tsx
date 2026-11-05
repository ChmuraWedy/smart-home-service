import { Root, Thumb } from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';

// Adapted from shadcn/ui's Switch with the dashboard theme and touch target.
export function Switch(props: ComponentProps<typeof Root>) {
  return (
    <Root
      data-slot="switch"
      className="tw:relative tw:inline-flex tw:h-6 tw:w-11 tw:shrink-0 tw:items-center tw:rounded-full tw:max-[600px]:h-11 tw:pointer-coarse:h-11 tw:before:absolute tw:before:inset-x-0 tw:before:h-6 tw:before:rounded-full tw:before:bg-(--toggle-off) tw:data-[state=checked]:before:bg-(--accent)"
      {...props}
    >
      <Thumb
        data-slot="switch-thumb"
        className="tw:pointer-events-none tw:relative tw:ml-[3px] tw:block tw:size-[18px] tw:rounded-full tw:bg-(--toggle-thumb) tw:transition-transform tw:motion-reduce:transition-none tw:data-[state=checked]:translate-x-5 tw:data-[state=checked]:bg-(--on-accent)"
      />
    </Root>
  );
}
