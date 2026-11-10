'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { GRADE_TONE, pct, SCORE_RULES, type VendorPerformanceList } from '@/lib/vendor-performance';

/** Purchases → Vendor performance: every vendor's scorecard for a period, best first. */
export default function VendorPerformancePage() {
  const { org, orgId } = useOrg();
  const [period, setPeriod] = useState({ from: '', to: '' });
  const qs = new URLSearchParams(Object.entries(period).filter(([, v]) => v)).toString();
  const q = useQuery({ queryKey: ['vendor-performance', orgId, qs], queryFn: () => api<VendorPerformanceList>(`/v1/orgs/${orgId}/purchases/vendor-performance${qs ? `?${qs}` : ''}`) });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Vendor performance"
        description="How each vendor did: deliveries against expected dates, goods rejected on receipt, prices billed against the order, bills that needed differences accepted, and the team's reviews, in one score and grade."
      />
      <form className="mb-6 flex flex-wrap items-end gap-3" aria-label="Period" onSubmit={(e) => e.preventDefault()}>
        <Field label="From">{(p) => <Input {...p} type="date" value={period.from || d?.from || ''} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={period.to || d?.to || ''} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />}</Field>
        <p className="pb-2 text-xs text-fg-muted">Orders placed, and bills, credits and reviews dated, in this period.</p>
      </form>
      <ErrorAlert title="Could not load vendor performance" error={q.error} />
      {d ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Grade A" value={String(d.counts.A)} tone="positive" />
          <Stat label="Grade B" value={String(d.counts.B)} tone="accent" />
          <Stat label="Grade C" value={String(d.counts.C)} tone="warning" />
          <Stat label="Grade D" value={String(d.counts.D)} tone="negative" />
          <Stat label="Not enough to score" value={String(d.counts.ungraded)} />
        </div>
      ) : null}
      <Card className="mb-6">
        <CardHeader title="Vendor scorecards" description={d ? `${date(d.from)} to ${date(d.to)}, best score first. Open a vendor for their order deliveries and reviews.` : 'Best score first.'} />
        {d && !d.vendors.length ? (
          <EmptyState title="No vendor activity in this period">Scorecards appear once vendors have purchase orders, bills or reviews in the period.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Vendor</Th><Th>Grade</Th><Th numeric>Score</Th><Th numeric>Orders</Th><Th numeric>On time</Th><Th numeric>Late</Th><Th numeric>Rejected</Th><Th numeric>Billing accuracy</Th><Th numeric>Above order price</Th><Th numeric>Spend</Th><Th numeric>Reviews</Th></tr></thead>
            <tbody>
              {(d?.vendors ?? []).map((v) => (
                <Tr key={v.contact.id}>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendors/${v.contact.id}`}>{v.contact.name}</Link></Td>
                  <Td>{v.grade ? <Badge tone={GRADE_TONE[v.grade]}>{v.grade}</Badge> : <span className="text-fg-muted">—</span>}</Td>
                  <Td numeric className="num">{v.score ?? '—'}</Td>
                  <Td numeric className="num">{v.orders}</Td>
                  <Td numeric className="num">{pct(v.onTimePercent)}</Td>
                  <Td numeric className="num">{v.late}</Td>
                  <Td numeric className="num">{pct(v.rejectedPercent)}</Td>
                  <Td numeric className="num">{pct(v.accuracyPercent)}</Td>
                  <Td numeric><Money value={v.overcharge} currency={c} /></Td>
                  <Td numeric><Money value={v.spend} currency={c} /></Td>
                  <Td numeric className="num">{v.reviews.average ? `${v.reviews.average} (${v.reviews.count})` : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="How the score is worked out" description="Every figure comes from the books and the team's reviews; nothing is estimated." />
        <ul className="list-disc space-y-1 px-10 pb-5 text-sm">{SCORE_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
      </Card>
    </>
  );
}
