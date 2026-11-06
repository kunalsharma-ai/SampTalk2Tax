import { Badge, cn } from '@talk2tax/ui';

export interface Level { used: number; limit: number | null; remaining: number | null; percent: number | null; state: 'UNLIMITED' | 'OK' | 'NEAR' | 'REACHED' }

const STATE = {
  UNLIMITED: { label: 'No limit', tone: 'neutral' },
  OK: { label: 'Within the plan', tone: 'positive' },
  NEAR: { label: 'Nearly used up', tone: 'warning' },
  REACHED: { label: 'Used up', tone: 'negative' },
} as const;

/** How much of a monthly limit is used, as a bar with the numbers. */
export function UsageMeter({ label, level, unit, detail }: { label: string; level: Level; unit: string; detail?: string }) {
  const pct = level.percent === null ? 0 : Math.min(100, level.percent);
  return (
    <div aria-label={label} className="rounded-[var(--t2t-radius-lg)] border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{label}</h3>
        <Badge tone={STATE[level.state].tone}>{STATE[level.state].label}</Badge>
      </div>
      <p className="mt-3 font-mono text-2xl tabular-nums">
        {level.used.toLocaleString('en-IN')}
        <span className="text-base text-fg-muted"> {level.limit === null ? unit : `of ${level.limit.toLocaleString('en-IN')} ${unit}`}</span>
      </p>
      {level.limit !== null ? (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-line" role="meter" aria-valuemin={0} aria-valuemax={level.limit} aria-valuenow={level.used} aria-label={`${label} used`}>
          <div className={cn('h-full rounded-full', level.state === 'REACHED' ? 'bg-negative' : level.state === 'NEAR' ? 'bg-warning' : 'bg-accent')} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <p className="mt-2 text-xs text-fg-muted">
        {level.limit === null ? 'Your plan has no monthly limit.' : level.state === 'REACHED' ? 'None left this month.' : `${level.remaining!.toLocaleString('en-IN')} left this month.`}
        {detail ? ` ${detail}` : ''}
      </p>
    </div>
  );
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
