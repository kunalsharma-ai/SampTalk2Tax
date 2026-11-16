import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { SectionHelpSlot } from './help';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-[var(--t2t-radius-lg)] border border-line bg-surface shadow-[var(--t2t-shadow)]', className)} {...props} />;
}

/**
 * help: the (i) control beside the title. Left out, a text title gets the app's help for it (see
 * SectionHelpContext); pass null for none.
 */
export function CardHeader({ title, description, actions, help }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; help?: ReactNode }) {
  const tip = help !== undefined ? help : typeof title === 'string' ? <SectionHelpSlot title={title} /> : null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {tip}
        </div>
        {description ? <p className="mt-0.5 text-xs text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'negative' | 'violet';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-hover text-fg-muted border-line',
  accent: 'bg-accent/10 text-accent border-accent/30',
  positive: 'bg-positive/10 text-positive border-positive/30',
  warning: 'bg-warning/10 text-warning border-warning/30',
  negative: 'bg-negative/10 text-negative border-negative/30',
  violet: 'bg-violet/10 text-violet border-violet/30',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>;
}

export function Alert({ tone = 'negative', title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  return (
    <div role={tone === 'negative' ? 'alert' : 'status'} className={cn('rounded-[var(--t2t-radius-md)] border px-4 py-3 text-sm', tones[tone])}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title && 'mt-1', 'text-fg-muted')}>{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-semibold text-fg">{title}</p>
      {children ? <p className="max-w-md text-sm text-fg-muted">{children}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function Stat({ label, value, sub, tone = 'neutral' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  const accent: Record<Tone, string> = { neutral: 'before:bg-line', accent: 'before:bg-accent', positive: 'before:bg-positive', warning: 'before:bg-warning', negative: 'before:bg-negative', violet: 'before:bg-violet' };
  return (
    <Card className={cn('relative overflow-hidden px-5 py-4 before:absolute before:inset-x-0 before:top-0 before:h-0.5', accent[tone])}>
      <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-fg">{value}</p>
      {sub ? <p className="mt-1 text-xs text-fg-muted">{sub}</p> : null}
    </Card>
  );
}
