'use client';
import { Badge, Card, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { Money } from '@/components/money';
import { CONFIDENCE, GRADE, VERDICT, type CfoAction, type CfoFigure, type CfoFinding, type CfoHealth, type CfoRecommendation, type CfoUnit } from '@/lib/cfo';

/** A figure in its unit: money in the organisation's currency, percentages, days, months, ratios or counts. */
export function FigureValue({ value, unit, currency }: { value: string | number | null; unit: CfoUnit; currency: string }) {
  if (value === null || value === undefined || value === '') return <span className="text-fg-muted">n/a</span>;
  const v = String(value);
  if (unit === 'MONEY') return <Money value={v} currency={currency} signed />;
  if (unit === 'PERCENT') return <span className="num">{v}%</span>;
  if (unit === 'DAYS') return <span className="num">{v} days</span>;
  if (unit === 'MONTHS') return <span className="num">{v} months</span>;
  if (unit === 'RATIO') return <span className="num">{v}×</span>;
  return <span className={unit === 'COUNT' ? 'num' : undefined}>{v}</span>;
}

function ActionLink({ a, orgId }: { a: CfoAction; orgId: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {a.path ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${a.path}`}>{a.text}</Link> : <span>{a.text}</span>}
      {a.approval ? <Badge tone="warning">Approval: {a.approval}</Badge> : null}
    </span>
  );
}

/**
 * One analysis or answer: the verdict and summary, the figures, the records behind it, and how it
 * was worked out (period, method, assumptions, confidence, sources), then what to do and who approves.
 */
export function FindingCard({ f, currency, orgId, open = false, heading }: { f: CfoFinding; currency: string; orgId: string; open?: boolean; heading?: string }) {
  const v = VERDICT[f.verdict];
  const figures = f.figures.filter((x: CfoFigure) => x.value !== null);
  return (
    <Card className="p-4" aria-label={heading ?? f.title}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {heading ? <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{heading}</p> : null}
          <h3 className="text-sm font-semibold text-fg">{f.title}</h3>
        </div>
        <Badge tone={v.tone}>{v.label}</Badge>
      </div>
      <p className="mt-2 text-sm text-fg">{f.summary}</p>
      {figures.length ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 xl:grid-cols-4" aria-label={`Figures: ${f.title}`}>
          {figures.map((x) => (
            <div key={x.label}>
              <dt className="text-fg-muted">{x.label}</dt>
              <dd className="text-sm"><FigureValue value={x.value} unit={x.unit} currency={currency} /></dd>
            </div>
          ))}
        </dl>
      ) : null}
      {f.table && f.table.rows.length ? (
        <div className="mt-3 overflow-x-auto">
          <Table aria-label={`Records: ${f.title}`}>
            <thead>
              <tr>{f.table.columns.map((c) => <Th key={c.key} numeric={c.unit !== 'TEXT'}>{c.label}</Th>)}</tr>
            </thead>
            <tbody>
              {f.table.rows.map((r, i) => (
                <tr key={i}>{f.table!.columns.map((c) => <Td key={c.key} numeric={c.unit !== 'TEXT'}><FigureValue value={r[c.key] ?? null} unit={c.unit} currency={currency} /></Td>)}</tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
      {f.actions.length ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-fg-muted">Recommended actions</p>
          <ul className="mt-1 space-y-1 text-sm" aria-label={`Actions: ${f.title}`}>
            {f.actions.map((a) => <li key={a.text}><ActionLink a={a} orgId={orgId} /></li>)}
          </ul>
        </div>
      ) : null}
      <details className="mt-3 text-xs" open={open}>
        <summary className="cursor-pointer text-accent">How this was worked out</summary>
        <dl className="mt-2 space-y-2" aria-label={`How it was worked out: ${f.title}`}>
          <div><dt className="font-medium text-fg">Period</dt><dd className="text-fg-muted">{f.period.label}</dd></div>
          <div><dt className="font-medium text-fg">Method</dt><dd className="text-fg-muted">{f.method}</dd></div>
          {f.assumptions.length ? (
            <div><dt className="font-medium text-fg">Assumptions</dt><dd><ul className="list-disc pl-5 text-fg-muted">{f.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></dd></div>
          ) : null}
          <div><dt className="font-medium text-fg">Confidence</dt><dd className="text-fg-muted">{CONFIDENCE[f.confidence]}. {f.confidenceReason}</dd></div>
          <div>
            <dt className="font-medium text-fg">Source records</dt>
            <dd className="flex flex-wrap gap-x-3">{f.sources.map((s) => <Link key={s.label} className="text-accent hover:underline" href={`/orgs/${orgId}${s.path}`}>{s.label}</Link>)}</dd>
          </div>
        </dl>
      </details>
    </Card>
  );
}

/** The health score, its grade and how each part was scored. */
export function HealthCard({ health, headline }: { health: CfoHealth; headline: string }) {
  const g = GRADE[health.grade];
  return (
    <Card className="p-4" aria-label="Financial health">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-baseline gap-1">
          <span className="font-mono text-4xl font-semibold tabular-nums text-fg">{health.score}</span>
          <span className="text-sm text-fg-muted">/ 100</span>
        </div>
        <Badge tone={g.tone}>{g.label}</Badge>
        <p className="min-w-0 flex-1 text-sm text-fg">{headline}</p>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5" aria-label="How the score was worked out">
        {health.components.map((c) => (
          <li key={c.key} className="rounded-md border border-line p-2" title={c.reason}>
            <div className="flex items-baseline justify-between text-xs"><span className="font-medium text-fg">{c.label}</span><span className="num text-fg-muted">{c.points} / {c.max}</span></div>
            <div className="mt-1 h-1.5 overflow-hidden rounded bg-surface-hover"><div className={`h-full ${c.points / c.max >= 0.7 ? 'bg-positive' : c.points / c.max >= 0.4 ? 'bg-warning' : 'bg-negative'}`} style={{ width: `${(c.points / c.max) * 100}%` }} /></div>
            <p className="mt-1 text-[11px] leading-snug text-fg-muted">{c.reason.split('. ')[0]}.</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Recommendations({ items, orgId }: { items: CfoRecommendation[]; orgId: string }) {
  if (!items.length) return <p className="text-sm text-fg-muted">Nothing needs action today.</p>;
  return (
    <ol className="space-y-2" aria-label="Recommendations">
      {items.map((r) => (
        <li key={r.text} className="flex gap-3 rounded-md border border-line p-3 text-sm">
          <Badge tone={r.priority === 'HIGH' ? 'negative' : 'warning'}>{r.priority === 'HIGH' ? 'High' : 'Medium'}</Badge>
          <div className="min-w-0">
            <ActionLink a={r} orgId={orgId} />
            <p className="mt-0.5 text-xs text-fg-muted">{r.why}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
