'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Dialog, Stat, Table, Td, Textarea, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { formatChange, formatKpi, type ManagementReport, monthLabel } from '@/lib/kpis';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function ManagementReportPage() {
  const { org, orgId } = useOrg();
  const { month } = useParams<{ month: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['management-report', orgId, month], queryFn: () => api<ManagementReport>(`/v1/orgs/${orgId}/management-reports/${month}`) });
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refresh = (r: ManagementReport) => {
    qc.setQueryData(['management-report', orgId, month], r);
    void qc.invalidateQueries({ queryKey: ['management-reports', orgId] });
  };
  const save = useMutation({ mutationFn: () => api<ManagementReport>(`/v1/orgs/${orgId}/management-reports/${month}/commentary`, { method: 'PUT', body: { commentary: draft ?? '' } }), onSuccess: (r) => { setDraft(null); refresh(r); } });
  const finalise = useMutation({ mutationFn: () => api<ManagementReport>(`/v1/orgs/${orgId}/management-reports/${month}/finalise`, { method: 'POST' }), onSuccess: (r) => { setConfirming(false); setDraft(null); refresh(r); } });
  if (!org) return null;
  const r = q.data;
  const c = r?.currency ?? org.functionalCurrency;
  const canManage = can(org.role, 'budgets.manage');
  const final = r?.status === 'FINAL';
  const text = draft ?? r?.commentary ?? '';
  return (
    <>
      <PageHeader
        title={`Management report · ${monthLabel(month)}`}
        description={r ? `${date(r.from)} to ${date(r.to)}. Year to date from ${date(r.ytdFrom)} (FY${r.fiscalYear}).` : undefined}
        actions={
          <span className="flex items-center gap-2 print:hidden">
            <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/management`}>← All months</Link>
            <Button variant="ghost" onClick={() => window.print()}>Print</Button>
            {canManage && r && !final && !r.inProgress ? <Button onClick={() => setConfirming(true)}>Finalise</Button> : null}
          </span>
        }
      />
      <ErrorAlert title="Could not load the report" error={q.error} />
      {r ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {final ? <Badge tone="positive">Final</Badge> : r.inProgress ? <Badge tone="warning">Month in progress</Badge> : <Badge>Draft</Badge>}
            {final ? <span>Finalised by {r.finalisedBy} on {date(r.finalisedAt!.slice(0, 10))}. These are the figures as they stood then.</span> : <span>Figures are live from the books until the report is finalised.</span>}
            {r.budget ? <span>Budget: approved {r.budget.label}.</span> : <span>No approved budget for FY{r.fiscalYear}.</span>}
          </div>
          {r.changedSince.length ? (
            <div role="alert" className="mb-4 rounded border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
              Postings made after this report was finalised changed {monthLabel(month)}:
              <ul className="mt-1 list-inside list-disc">
                {r.changedSince.map((x) => <li key={x.key}>{x.label}: {money(x.then, c)} in the report, {money(x.now, c)} now</li>)}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Revenue" value={money(r.lines[0].actual, c)} sub={r.lines[0].budget ? `Budget ${money(r.lines[0].budget, c)}` : `Last month ${money(r.lines[0].previous, c)}`} />
            <Stat label="Net income" value={money(r.lines[r.lines.length - 1].actual, c)} sub={`Last month ${money(r.lines[r.lines.length - 1].previous, c)}`} tone={r.lines[r.lines.length - 1].actual.startsWith('-') ? 'negative' : 'neutral'} />
            <Stat label="Closing cash" value={money(r.cash.closing, c)} sub={`${r.cash.change.startsWith('-') ? 'Down' : 'Up'} ${money(r.cash.change.replace('-', ''), c)} in the month`} />
            <Stat label="Largest customer" value={r.customers.top[0] ? `${r.customers.largestShare}%` : '—'} sub={r.customers.top[0] ? `${r.customers.top[0].name} of ${money(r.customers.total, c)} invoiced` : 'No invoiced revenue'} />
          </div>

          <Card className="mt-4">
            <CardHeader title="Profit and loss" description="Variance is the actual less the budget; green is favourable." />
            <Table aria-label="Profit and loss" className="[&_td]:whitespace-nowrap">
              <thead>
                <tr>
                  <Th />
                  <Th numeric>{monthLabel(month)}</Th>
                  <Th numeric>Previous month</Th>
                  <Th numeric>A year before</Th>
                  <Th numeric>Budget</Th>
                  <Th numeric>Variance</Th>
                  <Th numeric>Year to date</Th>
                  <Th numeric>Budget to date</Th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <Tr key={l.key} aria-label={l.label} className={l.kind === 'TOTAL' ? 'font-semibold' : undefined}>
                    <Td>{l.label}</Td>
                    <Td numeric><Money value={l.actual} currency={c} /></Td>
                    <Td numeric className="text-fg-muted"><Money value={l.previous} currency={c} /></Td>
                    <Td numeric className="text-fg-muted"><Money value={l.lastYear} currency={c} /></Td>
                    <Td numeric className="text-fg-muted">{l.budget ? <Money value={l.budget} currency={c} /> : '—'}</Td>
                    <Td numeric className={cn(l.favourable === true && 'text-positive', l.favourable === false && 'text-negative')}>{l.variance ? money(l.variance, c) : '—'}</Td>
                    <Td numeric><Money value={l.ytd} currency={c} /></Td>
                    <Td numeric className="text-fg-muted">{l.ytdBudget ? <Money value={l.ytdBudget} currency={c} /> : '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title="KPIs" description={<Link className="text-accent hover:underline print:hidden" href={`/orgs/${orgId}/reports/kpis?month=${month}`}>How each is calculated</Link>} />
              <Table>
                <thead>
                  <tr>
                    <Th />
                    <Th numeric>{monthLabel(month)}</Th>
                    <Th numeric>Change</Th>
                  </tr>
                </thead>
                <tbody className="[&_td]:whitespace-nowrap">
                  {r.kpis.map((k) => (
                    <Tr key={k.key} aria-label={k.label}>
                      <Td>{k.label}</Td>
                      <Td numeric title={k.reason ?? undefined}>{formatKpi(k.value, k.unit, c)}</Td>
                      <Td numeric className={cn(k.improved === true && 'text-positive', k.improved === false && 'text-negative')}>{formatChange(k.change, k.unit, c) || '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card>
              <CardHeader title="Top customers this month" description={`Invoiced revenue without tax, ${r.customers.customers} customer${r.customers.customers === 1 ? '' : 's'}.`} />
              {r.customers.top.length ? (
                <Table>
                  <tbody>
                    {r.customers.top.map((x) => (
                      <Tr key={x.id}>
                        <Td>{x.name}</Td>
                        <Td numeric><Money value={x.revenue} currency={c} /></Td>
                        <Td numeric className="text-fg-muted">{x.share}%</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="px-4 pb-4 text-sm text-fg-muted">No invoiced revenue this month.</p>
              )}
              <div className="border-t border-line px-4 py-3 text-sm text-fg-muted">
                Cash: opened at {money(r.cash.opening, c)}, closed at {money(r.cash.closing, c)}.
              </div>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader title="Commentary" description={final ? 'Frozen with the report.' : r.updatedBy ? `Last saved by ${r.updatedBy}.` : 'What happened this month and why: for the owners, the board or the bank.'} />
            <div className="px-4 pb-4">
              <ErrorAlert title="Not saved" error={save.error} />
              {final || !canManage ? (
                <p className="whitespace-pre-wrap text-sm">{r.commentary || <span className="text-fg-muted">No commentary.</span>}</p>
              ) : (
                <form className="flex flex-col gap-2 print:hidden" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                  <Textarea aria-label="Commentary" rows={6} maxLength={10000} value={text} onChange={(e) => setDraft(e.target.value)} />
                  <div className="flex items-center justify-end gap-3 text-xs text-fg-muted">
                    {draft !== null ? 'Unsaved changes' : null}
                    <Button type="submit" variant="secondary" loading={save.isPending} disabled={draft === null}>Save commentary</Button>
                  </div>
                </form>
              )}
              {!final && canManage ? <p className="mt-2 hidden whitespace-pre-wrap text-sm print:block">{text}</p> : null}
            </div>
          </Card>
          {confirming ? (
            <Dialog open onOpenChange={(o) => !o && setConfirming(false)} title={`Finalise ${monthLabel(month)}?`} description="The figures and commentary are frozen as they are now and cannot be changed or deleted. Later postings to this month will be listed on the report, not folded in.">
              <ErrorAlert title="Not finalised" error={finalise.error} />
              {draft !== null ? <p className="mb-3 text-sm text-warning">Save the commentary first: unsaved changes would be lost.</p> : null}
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
