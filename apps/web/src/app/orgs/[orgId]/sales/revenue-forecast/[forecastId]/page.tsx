'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { ForecastChart } from '@/components/revenue-forecast/forecast-chart';
import { ForecastItems, ForecastTable } from '@/components/revenue-forecast/forecast-tables';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { monthLabel, type SavedForecast } from '@/lib/revenue-forecast';

const pct = (s: string | null) => (s == null ? '—' : `${(Number(s) * 100).toFixed(1).replace(/\.0$/, '')}%`);

export default function SavedForecastPage() {
  const { org, orgId } = useOrg();
  const { forecastId } = useParams<{ forecastId: string }>();
  const q = useQuery({ queryKey: ['revenue-forecast', orgId, 'saved', forecastId], queryFn: () => api<SavedForecast>(`/v1/orgs/${orgId}/sales/revenue-forecast/saved/${forecastId}`) });
  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the forecast" error={q.error} />;
  const f = q.data;
  if (!f) return <p className="text-sm text-fg-muted">Loading…</p>;
  const c = f.currency;
  const a = f.accuracy;
  return (
    <>
      <PageHeader
        title={`Saved forecast ${f.reference}`}
        description={`Made on ${date(f.asOf)}${f.createdBy ? ` by ${f.createdBy}` : ''} (${dateTime(f.createdAt)}) for ${f.horizon} months.${f.note ? ` ${f.note}` : ''}`}
        actions={<Link href={`/orgs/${orgId}/sales/revenue-forecast`}><Button variant="secondary">Today's forecast</Button></Link>}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Committed" value={<Money value={f.totals.committed} currency={c} />} tone="accent" />
        <Stat label="Expected" value={<Money value={f.totals.expected} currency={c} />} tone="positive" />
        <Stat label="Best case" value={<Money value={f.totals.best} currency={c} />} tone="violet" />
        <Stat label="Accuracy so far (WAPE)" value={pct(a.wape)} tone={a.wape == null ? 'neutral' : Number(a.wape) <= 0.1 ? 'positive' : 'warning'} sub={a.months.length ? `${a.months.length} months over` : 'No month is over yet'} />
      </div>
      <Card className="mt-6">
        <CardHeader title="Forecast against actual" description="For each month that is over: what was expected (the first month includes what had already been invoiced when it was made) and what was invoiced, before tax, less credit notes." />
        {a.months.length ? (
          <Table aria-label="Forecast against actual">
            <thead><tr><Th>Month</Th><Th numeric>Committed</Th><Th numeric>Expected</Th><Th numeric>Actual</Th><Th numeric>Difference</Th><Th numeric>%</Th></tr></thead>
            <tbody>
              {a.months.map((m) => (
                <Tr key={m.month}>
                  <Td>{monthLabel(m.month)}</Td>
                  <Td numeric><Money value={m.committed} currency={c} /></Td>
                  <Td numeric><Money value={m.forecast} currency={c} /></Td>
                  <Td numeric><Money value={m.actual} currency={c} /></Td>
                  <Td numeric><Money value={m.variance} currency={c} signed /></Td>
                  <Td numeric>{pct(m.variancePct)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">The comparison starts once {monthLabel(f.months[0]!.month)} is over.</p>}
      </Card>
      <Card className="mt-6">
        <CardHeader title="As forecast" description={`Other sales were running at the average of the three months before ${monthLabel(f.months[0]!.month)}.`} />
        <div className="px-5 pt-2"><ForecastChart months={f.months} currency={c} actualSoFar={f.actualSoFar} /></div>
        <ForecastTable months={f.months} totals={f.totals} currency={c} label="Saved forecast by month" />
      </Card>
      <Card className="mt-6">
        <CardHeader title="What it was made of" />
        <ForecastItems items={f.items} orgId={orgId} currency={c} />
      </Card>
    </>
  );
}
