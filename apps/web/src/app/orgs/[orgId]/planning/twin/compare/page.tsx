'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { TwinCashChart } from '@/components/twin/twin-chart';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { monthLabel, type TwinMonth, type TwinRun } from '@/lib/twin';

interface Comparison {
  currency: string;
  horizonMonths: number;
  baselineMonths: number;
  months: string[];
  rows: { id: string | null; name: string; revenue: string; netProfit: string; netMarginPercent: string | null; closingCash: string; minimumCash: { amount: string; month: string }; cashNegativeFrom: string | null; cashRequired: string; risks: number; cash: string[] }[];
}

export default function ComparePage() {
  return (
    <Suspense>
      <Compare />
    </Suspense>
  );
}

function Compare() {
  const { orgId } = useOrg();
  const ids = useSearchParams().get('ids') ?? '';
  const q = useQuery({ queryKey: ['twin-compare', orgId, ids], queryFn: () => api<Comparison>(`/v1/orgs/${orgId}/twin/compare?ids=${ids}`) });
  const d = q.data;
  const actual = useQuery({ queryKey: ['twin-baseline', orgId, d?.baselineMonths, d?.horizonMonths], enabled: !!d, queryFn: () => api<TwinRun>(`/v1/orgs/${orgId}/twin/baseline?baselineMonths=${d!.baselineMonths}&horizonMonths=${d!.horizonMonths}`) });
  const c = d?.currency ?? 'INR';
  const best = d ? d.rows.reduce((a, r) => (Number(r.netProfit) > Number(a.netProfit) ? r : a), d.rows[0]!) : null;
  return (
    <>
      <PageHeader title="Compare scenarios" description="The same horizon and baseline for each. All projected figures are hypothetical." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/twin`}>All scenarios</Link>} />
      <ErrorAlert title="Could not compare" error={q.error} />
      {d ? (
        <>
          <Card className="mb-4 overflow-x-auto">
            <CardHeader title={`Over ${d.horizonMonths} months`} description={`Baseline: the last ${d.baselineMonths} actual months.`} />
            <Table aria-label="Scenario comparison">
              <thead><tr><Th>Scenario</Th><Th numeric>Revenue</Th><Th numeric>Net profit</Th><Th numeric>Margin</Th><Th numeric>Cash at the end</Th><Th numeric>Lowest cash</Th><Th numeric>Cash to raise</Th><Th>Serious risks</Th></tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <Tr key={r.id ?? 'baseline'}>
                    <Td>
                      {r.id ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/planning/twin/${r.id}`}>{r.name}</Link> : r.name} {best === r ? <Badge tone="positive">Most profitable</Badge> : null}
                    </Td>
                    <Td numeric><Money value={r.revenue} currency={c} /></Td>
                    <Td numeric><Money value={r.netProfit} currency={c} signed /></Td>
                    <Td numeric>{r.netMarginPercent ? `${r.netMarginPercent}%` : '—'}</Td>
                    <Td numeric><Money value={r.closingCash} currency={c} signed /></Td>
                    <Td numeric className="whitespace-nowrap"><Money value={r.minimumCash.amount} currency={c} signed /> <span className="text-xs text-fg-muted">{monthLabel(r.minimumCash.month)}</span></Td>
                    <Td numeric><Money value={r.cashRequired} currency={c} /></Td>
                    <Td>{r.risks ? <Badge tone="negative">{r.risks}</Badge> : <Badge tone="positive">None</Badge>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card className="p-4">
            <CardHeader title="Cash at each month end" description="Solid: actual. Dashed: hypothetical." />
            <TwinCashChart
              actual={actual.data?.actualMonths ?? []}
              series={d.rows.map((r) => ({ name: r.name, months: d.months.map((m, i) => ({ month: m, closingCash: r.cash[i]! }) as TwinMonth) }))}
              currency={c}
              label="Month-end cash for each scenario compared, after the actual months. The key figures are in the table above."
            />
          </Card>
        </>
      ) : null}
    </>
  );
}
