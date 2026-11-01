'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ForecastChart } from '@/components/cash-flow/forecast-chart';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { SavedForecast } from '@/lib/cashflow';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function SavedForecastPage() {
  const { org, orgId } = useOrg();
  const { forecastId } = useParams<{ forecastId: string }>();
  const q = useQuery({ queryKey: ['cash-forecast-saved', orgId, forecastId], queryFn: () => api<SavedForecast>(`/v1/orgs/${orgId}/cash-flow/forecasts/${forecastId}`) });
  const actual = useMemo(() => new Map((q.data?.accuracy.series ?? []).map((s) => [s.date, s.actual])), [q.data]);
  if (!org) return null;
  const f = q.data;
  const c = f?.currency ?? org.functionalCurrency;
  const a = f?.accuracy;
  const last = f?.days[f.days.length - 1]?.date;
  return (
    <>
      <PageHeader
        title={f ? `${f.isBacktest ? 'Backtest' : 'Forecast'} from ${date(f.asOf)}` : 'Saved forecast'}
        description="A saved forecast never changes. Each day that has passed is compared with the actual closing cash and bank balance from posted journals."
        actions={<Link className="text-accent hover:underline" href={`/orgs/${orgId}/planning/cash-flow`}>← Cash-flow forecast</Link>}
      />
      <ErrorAlert title="Could not load" error={q.error} />
      {f && a ? (
        <>
          <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {f.isBacktest ? <Badge tone="accent">Backtest</Badge> : <Badge>Forecast</Badge>}
            {f.horizonDays} days to {last ? date(last) : '—'} · saved by {f.createdBy} on {date(f.createdAt.slice(0, 10))}
            {f.note ? <> · “{f.note}”</> : null}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Days measured" value={`${a.days} of ${f.horizonDays}`} sub={a.days ? `Up to ${date(a.series[a.series.length - 1].date)}` : 'Nothing to compare until tomorrow'} />
            <Stat label="Average miss" value={a.days ? money(a.meanAbsoluteError, c) : '—'} sub="Mean of the daily differences, ignoring sign" />
            <Stat
              label="Bias"
              value={a.days ? money(a.bias, c) : '—'}
              sub={!a.days ? '' : Number(a.bias) > 0 ? 'Actual cash was higher than forecast on average' : Number(a.bias) < 0 ? 'Actual cash was lower than forecast on average' : 'No bias'}
              tone={a.days && Number(a.bias) < 0 ? 'warning' : 'neutral'}
            />
            <Stat label="Inside the range" value={a.days ? `${a.withinRange}%` : '—'} sub="Days the actual was between the low and high case" />
          </div>
          {a.largestMiss ? (
            <p className="mt-3 text-sm text-fg-muted">
              Largest miss: {date(a.largestMiss.date)}, expected {money(a.largestMiss.forecast, c)}, actual {money(a.largestMiss.actual, c)} ({money(a.largestMiss.error, c)}).
            </p>
          ) : null}
          <Card className="mt-4">
            <CardHeader title="Forecast and actual" description={`Opening ${money(f.opening, c)}; expected closing ${money(f.closingBase, c)} (range ${money(f.inputs.closing.low, c)} – ${money(f.inputs.closing.high, c)}). It used ${f.inputs.receivables} open invoices, ${f.inputs.payables} open bills and ${f.inputs.planned} planned dates.`} />
            <div className="px-4 pb-4">
              <ForecastChart days={f.days} actual={actual} minimumBalance={f.minimumBalance} currency={c} />
            </div>
          </Card>
          {a.series.length ? (
            <Card className="mt-4">
              <CardHeader title="Day by day" description="Difference = actual − expected." />
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th numeric>Expected</Th>
                    <Th numeric>Range</Th>
                    <Th numeric>Actual</Th>
                    <Th numeric>Difference</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.series.map((s) => (
                    <Tr key={s.date} aria-label={s.date}>
                      <Td className="whitespace-nowrap">{date(s.date)}</Td>
                      <Td numeric><Money value={s.base} currency={c} /></Td>
                      <Td numeric className="whitespace-nowrap text-fg-muted">{money(s.low, c)} – {money(s.high, c)}</Td>
                      <Td numeric><Money value={s.actual} currency={c} /></Td>
                      <Td numeric><Money value={s.error} currency={c} signed /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
