import type { ReactNode } from 'react';

export default function DashboardCardFooter({ children }: { children: ReactNode }) {
  return <footer className="dashboard-card-footer" data-slot="card-footer">{children}</footer>;
}
