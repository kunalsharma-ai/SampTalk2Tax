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
import { monthLabel, STATUS, type ScenarioStatus, type TwinMonth, type TwinRun } from '@/lib/twin';

const RISKS: Record<string, string> = {
  CASH_NEGATIVE: 'Cash runs out',
  BELOW_BUFFER: 'Cash below the minimum balance',
  LOSS: 'Loss over the period',
  ENDS_LOSS_MAKING: 'Loss-making by the end',
  THIN_MARGIN: 'Thin gross margin',
  RECEIVABLES_GROW: 'Customers owe much more',
  DEBT_SERVICE: 'Loan payments barely covered',
  SHORT_HISTORY: 'Short history behind the baseline',
};
type Risk = { level: 'HIGH' | 'MEDIUM' | 'LOW'; code: string; message: string };

interface Comparison {
  currency: string;
  horizonMonths: number;
  baselineMonths: number;
  months: string[];
  rows: { id: string | null; name: string; revenue: string; netProfit: string; netMarginPercent: string | null; closingCash: string; minimumCash: { amount: string; month: string }; cashNegativeFrom: string | null; cashRequired: string; risks: number; riskList: Risk[]; status: ScenarioStatus | null; cash: string[] }[];
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
                      {r.id ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/planning/twin/${r.id}`}>{r.name}</Link> : r.name} {r.status ? <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge> : null} {best === r ? <Badge tone="positive">Most profitable</Badge> : null}
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
          <RiskMap rows={d.rows} />
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

/** Which risks each scenario carries and how serious they are, side by side. */
function RiskMap({ rows }: { rows: Comparison['rows'] }) {
  const codes = Object.keys(RISKS).filter((k) => rows.some((r) => r.riskList.some((x) => x.code === k)));
  const tone = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' } as const;
  const word = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' } as const;
  return (
    <Card className="mb-4 overflow-x-auto">
      <CardHeader title="Risk map" description="Each risk the twin finds, by scenario. Hover a level for the details." />
      {!codes.length ? (
        <p className="p-4 text-sm text-fg-muted">No risks found in any of these scenarios.</p>
      ) : (
        <Table aria-label="Risk map">
          <thead><tr><Th>Risk</Th>{rows.map((r) => <Th key={r.id ?? 'baseline'}>{r.name}</Th>)}</tr></thead>
          <tbody>
            {codes.map((k) => (
              <Tr key={k}>
                <Td>{RISKS[k]}</Td>
                {rows.map((r) => {
                  const x = r.riskList.find((y) => y.code === k);
                  return <Td key={r.id ?? 'baseline'}>{x ? <span title={x.message}><Badge tone={tone[x.level]}>{word[x.level]}</Badge><span className="sr-only">: {x.message}</span></span> : <span className="text-fg-faint">—</span>}</Td>;
                })}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
