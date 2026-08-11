import type { ReactNode } from 'react';

export function MetricCard({ label, value, hint, icon, tone = 'teal' }: { label: string; value: ReactNode; hint?: ReactNode; icon: ReactNode; tone?: 'teal' | 'blue' | 'green' | 'amber' }) {
  return (
    <div className="metric-card">
      <div className={`metric-icon metric-icon--${tone}`}>{icon}</div>
      <div>
        <span className="metric-label">{label}</span>
        <strong>{value}</strong>
        {hint && <small>{hint}</small>}
      </div>
    </div>
  );
}
