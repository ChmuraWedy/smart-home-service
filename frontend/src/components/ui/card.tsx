import type { ComponentProps } from 'react';

// Adapted from shadcn/ui's Card for the dashboard's list semantics.
export function Card({ className, ...props }: ComponentProps<'li'>) {
  return (
    <li
      data-slot="card"
      className={`tw:flex tw:flex-col tw:rounded-xl tw:border tw:border-solid tw:border-(--border) tw:bg-(--surface) tw:text-(--text) tw:shadow-sm ${className ?? ''}`}
      {...props}
    />
  );
}
