'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Select, Stat, Table, Td, Textarea, Th, Tr, cn } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Audience = 'EXECUTIVE' | 'INVESTOR';
type Narrative = { highlights: string; challenges: string; outlook: string; asks: string };
interface Report {
  title: string;
  audience: Audience;
  currency: string;
  status: 'DRAFT' | 'FINAL';
  saved: boolean;
  inProgress: boolean;
  period: { key: string; label: string; from: string; to: string };
  prior: { key: string; label: string };
  lastYear: { key: string; label: string };
  headline: {
    revenue: string; revenueGrowthPrior: string | null; revenueGrowthYear: string | null; grossProfit: string; grossMargin: string | null; grossMarginPrior: string | null;
    operatingProfit: string; netIncome: string; netMargin: string | null; cashOpening: string; cashClosing: string; cashChange: string; averageMonthlyCashChange: string;
    runwayMonths: string | null; receivables: string; payables: string;
  };
  lines: { key: string; label: string; kind: string; current: string; prior: string; lastYear: string; changePrior: string | null; changeYear: string | null }[];
  months: { month: string; revenue: string; grossProfit: string; netIncome: string; cash: string | null }[];
  customers: { count: number; largestShare: string | null; topFiveShare: string | null; top: { name: string; revenue: string; share: string | null }[] };
  attention: { code: string; severity: 'HIGH' | 'MEDIUM'; message: string }[];
  narrative: Narrative;
  updatedBy: string | null;
  finalisedBy: string | null;
  finalisedAt: string | null;
  changedSince: { key: string; label: string; then: string; now: string }[];
}
interface Listing {
  suggested: { key: string; label: string; ended: boolean }[];
  reports: { id: string; audience: Audience; period: string; label: string; status: 'DRAFT' | 'FINAL'; updatedBy: string; finalisedBy: string | null }[];
}

const COPY = {
  EXECUTIVE: {
    title: 'Executive report',
    description: 'A quarter or a year for the leadership team and the board: headline figures, profit and loss against the period before and last year, cash and runway, the largest customers, points that need attention and your commentary. Finalise it when the period has ended to freeze it.',
    asks: 'Decisions needed',
  },
  INVESTOR: {
    title: 'Investor report',
    description: 'A quarter or a year for investors: headline figures, profit and loss against the period before and last year, cash and runway, and how concentrated revenue is (customers are never named), with your update. Finalise it when the period has ended to freeze it.',
    asks: 'Asks of investors',
  },
} as const;
const pct = (x: string | null) => (x === null ? '—' : `${x.startsWith('-') ? '' : '+'}${x}%`);
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Executive (RPT-022) and investor (RPT-023) reports for a fiscal quarter or year. */
export function StakeholderReportPage({ audience }: { audience: Audience }) {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/stakeholder-reports`;
  const slug = audience.toLowerCase();
  const list = useQuery({ queryKey: ['stakeholder-reports', orgId], queryFn: () => api<Listing>(base) });
  const [picked, setPicked] = useState<string | null>(null);
  const period = picked ?? list.data?.suggested.find((s) => s.ended)?.key ?? null;
  const q = useQuery({ queryKey: ['stakeholder-report', orgId, audience, period], enabled: !!period, queryFn: () => api<Report>(`${base}/${slug}/${period}`) });
  const [draft, setDraft] = useState<Narrative | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refresh = (r: Report) => {
    qc.setQueryData(['stakeholder-report', orgId, audience, period], r);
    void qc.invalidateQueries({ queryKey: ['stakeholder-reports', orgId] });
  };
  const save = useMutation({ mutationFn: (n: Narrative) => api<Report>(`${base}/${slug}/${period}/narrative`, { method: 'PUT', body: n }), onSuccess: (r) => { setDraft(null); refresh(r); } });
  const finalise = useMutation({ mutationFn: () => api<Report>(`${base}/${slug}/${period}/finalise`, { method: 'POST' }), onSuccess: (r) => { setConfirming(false); setDraft(null); refresh(r); } });
  if (!org) return null;
  const copy = COPY[audience];
  const r = q.data?.period.key === period ? q.data : undefined;
  const c = r?.currency ?? org.functionalCurrency;
  const canManage = can(org.role, 'budgets.manage');
  const final = r?.status === 'FINAL';
  const text = draft ?? r?.narrative ?? { highlights: '', challenges: '', outlook: '', asks: '' };
  const saved = (list.data?.reports ?? []).filter((x) => x.audience === audience);
  const options = [...(list.data?.suggested ?? []), ...saved.filter((s) => !list.data?.suggested.some((x) => x.key === s.period)).map((s) => ({ key: s.period, label: s.label, ended: true }))];
  const SECTIONS = [
    ['highlights', 'Highlights'],
    ['challenges', 'Challenges'],
    ['outlook', 'Outlook'],
    ['asks', copy.asks],
  ] as const;
  return (
    <>
      <PageHeader
        title={r ? r.title : copy.title}
        description={copy.description}
        actions={
          <span className="flex items-center gap-2 print:hidden">
            <Button variant="ghost" size="sm" disabled={!r} onClick={() => window.print()}>Print</Button>
            {canManage && r && !final && !r.inProgress ? <Button size="sm" onClick={() => setConfirming(true)}>Finalise report</Button> : null}
          </span>
        }
      />
      <Card className="mb-4 print:hidden">
        <CardHeader title="Report period" description="A fiscal quarter or year. A period in progress shows the figures so far and can be finalised once it has ended." />
        <div className="flex flex-wrap items-end gap-4 p-4">
          <Field label="Period">
            {(p) => (
              <Select {...p} className="w-56" value={period ?? ''} onChange={(e) => { setPicked(e.target.value); setDraft(null); }}>
                {options.map((o) => <option key={o.key} value={o.key}>{o.label}{o.ended ? '' : ' (in progress)'}</option>)}
              </Select>
            )}
          </Field>
          {saved.length ? (
            <div className="text-sm text-fg-muted">
              Saved: {saved.map((s, i) => (
                <span key={s.id}>{i ? ', ' : ''}<button type="button" className="text-accent hover:underline" onClick={() => { setPicked(s.period); setDraft(null); }}>{s.label}</button> ({s.status === 'FINAL' ? 'final' : 'draft'})</span>
              ))}
            </div>
          ) : null}
        </div>
      </Card>
      <ErrorAlert title="Could not load the report" error={list.error ?? q.error} />
      {r ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {final ? <Badge tone="positive">Final</Badge> : r.inProgress ? <Badge tone="warning">Period in progress</Badge> : <Badge>Draft</Badge>}
            <span>{date(r.period.from)} to {date(r.period.to)}.</span>
            {final ? <span>Finalised by {r.finalisedBy} on {date(r.finalisedAt!.slice(0, 10))}. These are the figures as they stood then.</span> : <span>Figures are live from the books until the report is finalised.</span>}
          </div>
          {r.changedSince.length ? (
            <div role="alert" className="mb-4 rounded border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
              Postings made after this report was finalised changed {r.period.label}:
              <ul className="mt-1 list-inside list-disc">
                {r.changedSince.map((x) => <li key={x.key}>{x.label}: {money(x.then, c)} in the report, {money(x.now, c)} now</li>)}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Revenue" value={<Money value={r.headline.revenue} currency={c} />} sub={`${r.headline.revenueGrowthPrior === null ? 'No revenue' : pct(r.headline.revenueGrowthPrior)} on ${r.prior.label}; ${r.headline.revenueGrowthYear === null ? 'no revenue a year before' : `${pct(r.headline.revenueGrowthYear)} on a year before`}`} />
            <Stat label="Gross margin" value={r.headline.grossMargin === null ? '—' : `${r.headline.grossMargin}%`} sub={`${r.prior.label}: ${r.headline.grossMarginPrior === null ? '—' : `${r.headline.grossMarginPrior}%`}`} />
            <Stat label="Net income" value={<Money value={r.headline.netIncome} currency={c} />} tone={r.headline.netIncome.startsWith('-') ? 'negative' : 'neutral'} sub={`Net margin ${r.headline.netMargin === null ? '—' : `${r.headline.netMargin}%`}`} />
            <Stat label="Cash at the end" value={<Money value={r.headline.cashClosing} currency={c} />} sub={r.headline.runwayMonths ? `About ${r.headline.runwayMonths} months of runway` : r.headline.cashChange.startsWith('-') ? 'Cash fell' : 'Cash did not fall'} />
          </div>

          {audience === 'EXECUTIVE' ? (
            <Card className="mt-4">
              <CardHeader title="Points for attention" description="Worked out from the figures: a net loss, revenue or gross margin falling on the period before, a runway under a year, and one customer with 30% or more of revenue." />
              {r.attention.length ? (
                <ul className="flex flex-col gap-2 p-4 text-sm">
                  {r.attention.map((a) => (
                    <li key={a.code} className="flex items-center gap-2"><Badge tone={a.severity === 'HIGH' ? 'negative' : 'warning'}>{a.severity === 'HIGH' ? 'High' : 'Medium'}</Badge>{a.message}</li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="Nothing needs attention">None of the checks found anything in this period.</EmptyState>
              )}
            </Card>
          ) : null}

          <Card className="mt-4">
            <CardHeader title="Summary profit and loss" description={`${r.period.label} against ${r.prior.label} and ${r.lastYear.label}, with the change in percent.`} />
            <Table aria-label="Summary profit and loss" className="[&_td]:whitespace-nowrap">
              <thead><Tr><Th /><Th numeric>{r.period.label}</Th><Th numeric>{r.prior.label}</Th><Th numeric>Change</Th><Th numeric>{r.lastYear.label}</Th><Th numeric>Change</Th></Tr></thead>
              <tbody>
                {r.lines.map((l) => (
                  <Tr key={l.key} className={l.kind === 'TOTAL' ? 'font-semibold' : undefined}>
                    <Td>{l.label}</Td>
                    <Td numeric><Money value={l.current} currency={c} /></Td>
                    <Td numeric className="text-fg-muted"><Money value={l.prior} currency={c} /></Td>
                    <Td numeric>{pct(l.changePrior)}</Td>
                    <Td numeric className="text-fg-muted"><Money value={l.lastYear} currency={c} /></Td>
                    <Td numeric>{pct(l.changeYear)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <div className="mt-4 grid gap-4">
            <Card>
              <CardHeader title="Months in the period" description={`Cash opened at ${money(r.headline.cashOpening, c)} and moved by ${money(r.headline.averageMonthlyCashChange, c)} a month on average.`} />
              <Table aria-label="Months in the period" className="[&_td]:whitespace-nowrap">
                <thead><Tr><Th>Month</Th><Th numeric>Revenue</Th><Th numeric>Gross profit</Th><Th numeric>Net income</Th><Th numeric>Cash</Th></Tr></thead>
                <tbody>
                  {r.months.map((m) => (
                    <Tr key={m.month}>
                      <Td>{monthLabel(m.month)}</Td>
                      <Td numeric><Money value={m.revenue} currency={c} /></Td>
                      <Td numeric><Money value={m.grossProfit} currency={c} /></Td>
                      <Td numeric className={cn(m.netIncome.startsWith('-') && 'text-negative')}><Money value={m.netIncome} currency={c} /></Td>
                      <Td numeric>{m.cash === null ? '—' : <Money value={m.cash} currency={c} />}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="border-t border-line px-4 py-3 text-sm text-fg-muted">Receivables {money(r.headline.receivables, c)} and payables {money(r.headline.payables, c)} at the end.</div>
            </Card>
            <Card>
              <CardHeader title={audience === 'EXECUTIVE' ? 'Top customers in the period' : 'Revenue concentration'} description={`Invoiced revenue without tax from ${r.customers.count} customer${r.customers.count === 1 ? '' : 's'}.`} />
              <div className="grid grid-cols-2 gap-3 p-4">
                <Stat label="Largest customer" value={r.customers.largestShare === null ? '—' : `${r.customers.largestShare}%`} sub="of revenue" />
                <Stat label="Five largest" value={r.customers.topFiveShare === null ? '—' : `${r.customers.topFiveShare}%`} sub="of revenue" />
              </div>
              {audience === 'EXECUTIVE' && r.customers.top.length ? (
                <Table aria-label="Top customers in the period">
                  <tbody>
                    {r.customers.top.map((x) => (
                      <Tr key={x.name}><Td>{x.name}</Td><Td numeric><Money value={x.revenue} currency={c} /></Td><Td numeric className="text-fg-muted">{x.share}%</Td></Tr>
                    ))}
                  </tbody>
                </Table>
              ) : audience === 'INVESTOR' ? (
                <p className="px-4 pb-4 text-sm text-fg-muted">Customers are not named in an investor report.</p>
              ) : null}
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader title="Narrative" description={final ? 'Frozen with the report.' : r.updatedBy ? `Last saved by ${r.updatedBy}.` : 'What happened in the period and why, what comes next, and what you need from the reader.'} />
            <div className="px-4 pb-4">
              <ErrorAlert title="Not saved" error={save.error} />
              {final || !canManage ? (
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  {SECTIONS.map(([k, label]) => (
                    <div key={k}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap text-fg-muted">{r.narrative[k] || '—'}</dd></div>
                  ))}
                </dl>
              ) : (
                <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(text); }}>
                  {SECTIONS.map(([k, label]) => (
                    <Field key={k} label={label}>{(p) => <Textarea {...p} rows={4} maxLength={5000} value={text[k]} onChange={(e) => setDraft({ ...text, [k]: e.target.value })} />}</Field>
                  ))}
                  <div className="flex items-center justify-end gap-3 text-xs text-fg-muted sm:col-span-2 print:hidden">
                    {draft !== null ? 'Unsaved changes' : null}
                    <Button type="submit" variant="secondary" loading={save.isPending} disabled={draft === null}>Save narrative</Button>
                  </div>
                </form>
              )}
            </div>
          </Card>
          {confirming ? (
            <Dialog open onOpenChange={(o) => !o && setConfirming(false)} title={`Finalise ${r.period.label}?`} description="The figures and narrative are frozen as they are now and cannot be changed or deleted. Later postings to the period will be listed on the report, not folded in.">
              <ErrorAlert title="Not finalised" error={finalise.error} />
              {draft !== null ? <p className="mb-3 text-sm text-warning">Save the narrative first: unsaved changes would be lost.</p> : null}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                <Button loading={finalise.isPending} disabled={draft !== null} onClick={() => finalise.mutate()}>Finalise</Button>
              </div>
            </Dialog>
          ) : null}
        </>
      ) : null}
    </>
  );
}
