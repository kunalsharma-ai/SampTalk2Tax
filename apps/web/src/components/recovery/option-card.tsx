'use client';
import { Badge } from '@talk2tax/ui';
import type { ReactNode } from 'react';
import { Money } from '@/components/money';
import { CATEGORY, CATEGORY_ORDER, type RecoveryOption, type RecoveryTarget } from '@/lib/recovery';
import { monthLabel } from '@/lib/twin';

/** One recovery option: what it is, its measured effect against taking no action, whom it involves and its risks. */
export function OptionCard({ o, currency, action }: { o: RecoveryOption; currency: string; action?: ReactNode }) {
  const e = o.effect;
  return (
    <li className="rounded-md border border-line p-3" aria-label={o.title}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{o.title}</span>
            {o.needsDecision ? <Badge tone="warning">Needs a decision</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-fg-muted">{o.detail}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4" aria-label={`Effect of ${o.title}`}>
        <div><dt className="text-fg-muted">Lowest cash</dt><dd><Money value={e.minimumCash} currency={currency} signed /></dd></div>
        <div><dt className="text-fg-muted">Cash at the end</dt><dd><Money value={e.closingCash} currency={currency} signed /></dd></div>
        <div><dt className="text-fg-muted">Net profit</dt><dd><Money value={e.netProfit} currency={currency} signed /></dd></div>
        <div><dt className="text-fg-muted">Then cash</dt><dd>{e.cashNegativeFrom ? `runs out ${monthLabel(e.cashNegativeFrom)}` : 'stays positive'}</dd></div>
      </dl>
      <Targets targets={o.targets} currency={currency} />
      {o.risks.length ? <ul className="mt-2 list-disc pl-5 text-xs text-fg-muted" aria-label="Risks">{o.risks.map((r) => <li key={r}>{r}</li>)}</ul> : null}
    </li>
  );
}

export function Targets({ targets, currency }: { targets: RecoveryTarget[]; currency: string }) {
  if (!targets.length) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-accent">Who to talk to ({targets.length})</summary>
      <ul className="mt-1 space-y-1" aria-label="Who to talk to">
        {targets.map((t) => (
          <li key={t.id} className="flex justify-between gap-3">
            <span>{t.name} <span className="text-fg-muted">· {t.note}</span></span>
            <Money value={t.amount} currency={currency} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Options grouped by category, in a fixed order. */
export function OptionGroups({ options, currency, action }: { options: RecoveryOption[]; currency: string; action?: (o: RecoveryOption) => ReactNode }) {
  return (
    <div className="space-y-4">
      {CATEGORY_ORDER.filter((c) => options.some((o) => o.category === c)).map((c) => (
        <section key={c} aria-label={CATEGORY[c].label}>
          <h3 className="text-sm font-semibold text-fg">{CATEGORY[c].label}</h3>
          <p className="mb-2 text-xs text-fg-muted">{CATEGORY[c].help}</p>
          <ul className="space-y-2">
            {options.filter((o) => o.category === c).map((o) => <OptionCard key={o.key} o={o} currency={currency} action={action?.(o)} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

