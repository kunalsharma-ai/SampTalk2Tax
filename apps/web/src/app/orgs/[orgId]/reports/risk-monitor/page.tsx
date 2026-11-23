'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { LEVEL, RiskGauge, type RiskMonitor, RiskTrend } from '@/components/reports/risk-monitor';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

const FINDING: Record<'HIGH' | 'MEDIUM' | 'LOW', 'negative' | 'warning' | 'neutral'> = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' };
const change = (n: number | null) => (n === null ? null : n === 0 ? 'No change' : `${n > 0 ? '+' : ''}${n} since the last reading`);

/**
 * Reports → Risk monitor (DASH-036): the organisation's risk across alerts, payments, expenses,
 * bank activity, compliance deadlines and vendors, from each area's own checks, scored and
 * coloured by level, with what drives each area, the trend of daily readings and where to act.
 */
export default function RiskMonitorPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['risk-monitor', orgId], queryFn: () => api<RiskMonitor>(`/v1/orgs/${orgId}/reports/risk-monitor`) });
  if (!org) return null;
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Risk monitor"
        description="Where risk sits today across alerts, payments, expenses, bank activity, compliance deadlines and vendors, read from each area's own checks. Each area scores 0 to 100 from its high, medium and low findings; the overall score leans on the worst area. Open an area to act on it."
      />
      <ErrorAlert title="Could not read the risks" error={q.error} />
      {r ? (
        <div className="grid gap-4">
          <Card role="region" aria-label="Overall risk">
            <CardHeader title="Overall risk" description={`Read on ${date(r.today)}. ${r.previous ? `The last earlier reading, on ${date(r.previous.date)}, was ${r.previous.score} (${LEVEL[r.previous.level].label.toLowerCase()}).` : 'This is the first reading; the trend builds up one reading a day as the monitor is opened.'}`} />
            <div className="flex flex-wrap items-center gap-6 px-5 pb-5">
              <RiskGauge score={r.score} level={r.level} />
              <div className="flex flex-col gap-2 text-sm">
                <p><Badge tone={LEVEL[r.level].tone}>{LEVEL[r.level].label}</Badge>{r.change !== null ? <span className="ml-2 text-fg-muted">{change(r.change)}</span> : null}</p>
                {r.focus.length ? (
                  <p>Look first at: {r.focus.map((k, i) => { const a = r.areas.find((x) => x.area === k)!; return <span key={k}>{i ? ', ' : ''}<a className="text-accent hover:underline" href={`#area-${k}`}>{a.name}</a></span>; })}.</p>
                ) : <p className="text-fg-muted">Nothing needs attention in the areas checked.</p>}
                {!r.complete ? <p className="text-xs text-fg-muted">Some areas are not open to your role, so they are left out of the score and today&apos;s reading is not kept.</p> : null}
              </div>
            </div>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Risk areas" role="list">
            {r.areas.map((a) => (
              <Card key={a.area} id={`area-${a.area}`} role="listitem" aria-label={a.name} className="flex flex-col">
                <div className="flex items-start justify-between gap-2 px-5 pt-4">
                  <div>
                    <h2 className="font-medium">{a.name}</h2>
                    <p className="text-xs text-fg-muted">{a.available ? (a.active ? a.window : 'Nothing to check yet') : 'Not open to your role'}</p>
                  </div>
                  {a.available ? <Badge tone={LEVEL[a.level].tone}>{LEVEL[a.level].label}</Badge> : null}
                </div>
                {a.available ? (
                  <>
                    <div className="px-5 pt-3">
                      <div className="flex items-baseline justify-between text-sm"><span className="num text-2xl font-semibold">{a.score}</span><span className="text-xs text-fg-muted">{change(a.change)}</span></div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-surface-hover" aria-hidden="true"><div className="h-1.5 rounded-full" style={{ width: `${a.score}%`, background: LEVEL[a.level].colour }} /></div>
                      <p className="mt-2 text-xs text-fg-muted">{a.high} high · {a.medium} medium · {a.low} low</p>
                    </div>
                    {a.top.length ? (
                      <ul className="mt-3 flex flex-col gap-1.5 px-5 text-sm" aria-label={`Top findings in ${a.name}`}>
                        {a.top.map((f, i) => (
                          <li key={i} className="flex items-start gap-2"><Badge tone={FINDING[f.level]}>{f.level.toLowerCase()}</Badge><span><span className="block">{f.title}</span><span className="block text-xs text-fg-muted">{f.detail}</span></span></li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-auto px-5 pb-4 pt-3"><Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}${a.href}`}>Open {a.name.toLowerCase()}</Link></div>
                  </>
                ) : <p className="px-5 py-4 text-sm text-fg-muted">Ask an owner for access to see this area.</p>}
              </Card>
            ))}
          </div>

          <Card role="region" aria-label="Risk over time">
            <CardHeader title="Risk over time" description="One reading a day, kept when the monitor is opened, for the last 90 days. The shaded bands are the levels: low, elevated, high and severe." />
            <RiskTrend history={r.history} areas={r.areas} />
            <div className="overflow-x-auto">
              <Table aria-label="Risk readings by day">
                <thead><Tr><Th>Day</Th><Th numeric>Overall</Th>{r.areas.map((a) => <Th key={a.area} numeric>{a.name}</Th>)}</Tr></thead>
                <tbody>
                  {[...r.history].reverse().map((h) => (
                    <Tr key={h.date}>
                      <Td className="whitespace-nowrap">{date(h.date)}</Td>
                      <Td numeric><span className="font-semibold">{h.score}</span> <span className="text-xs text-fg-muted">{LEVEL[h.level].label}</span></Td>
                      {r.areas.map((a) => <Td key={a.area} numeric>{h.areas[a.area] ?? '—'}</Td>)}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>
        </div>
      ) : !q.error ? <p className="text-sm text-fg-muted">Reading the risks…</p> : null}
    </>
  );
}
