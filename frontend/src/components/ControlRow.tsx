import type { ReactNode } from 'react';

export type PowerSide = 'start' | 'end';

export default function ControlRow({
  heading, state, power, powerSide, metadata, children,
}: {
  heading: ReactNode;
  state?: ReactNode;
  power?: ReactNode;
  powerSide?: PowerSide;
  metadata?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="capability-row" data-power-side={powerSide}>
      {heading}
      {state}
      {children}
      {power}
      {metadata}
    </div>
  );
}
