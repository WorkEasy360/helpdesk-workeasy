import { StatCard } from '@/components/ui/page';

/**
 * Kept as a thin alias so the report tabs need no change: the design system's
 * `StatCard` is the one implementation. `tone` only ever reinforces something the
 * label or `sub` already says, so colour is never the only signal.
 */
export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
}) {
  return <StatCard label={label} value={value} sub={sub} tone={tone ?? 'default'} />;
}

export function formatMinutes(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${Math.round(value)}m`;
  const hours = value / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}
