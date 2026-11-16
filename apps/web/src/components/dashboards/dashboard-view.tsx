'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardConfig, DashboardData, Metric, SeriesData, WidgetData } from '@/lib/dashboards';
import { date, money } from '@/lib/format';
import { formatChange, formatKpi } from '@/lib/kpis';
import { monthLabel } from '@/lib/twin';

const SPAN = { SMALL: 'md:col-span-2', MEDIUM: 'md:col-span-3', LARGE: 'md:col-span-6' } as const;

/** A dashboard's widgets with their figures, laid out on a six-column grid. */
export function DashboardView({ config, data }: { config: DashboardConfig; data: Pick<DashboardData, 'currency' | 'widgets'> }) {
  return (
    <div className="grid gap-4 md:grid-cols-6" data-testid="dashboard">
      {config.widgets.map((w, i) => {
        const d = data.widgets[i];
        const size = w.size ?? (w.type === 'STAT' ? 'SMALL' : 'MEDIUM');
        return (
          <section key={i} className={SPAN[size]} aria-label={w.title}>
            <Card className="h-full">{d ? <WidgetBody title={w.title} d={d} currency={data.currency} /> : null}</Card>
          </section>
        );
      })}
    </div>
  );
}

function WidgetBody({ title, d, currency }: { title: string; d: WidgetData; currency: string }) {
  if (d.type === 'UNAVAILABLE')
    return (
      <>
        <CardHeader title={title} />
        <p className="px-5 pb-5 text-sm text-fg-muted">{d.reason}</p>
      </>
    );
  if (d.type === 'STAT')
    return (
      <div className="flex flex-col gap-1 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</p>
        <p className="text-2xl font-semibold tabular-nums" title={d.metric.formula}>
          {formatKpi(d.value, d.metric.unit, currency)}
        </p>
        {d.value === null ? <p className="text-xs text-fg-muted">{d.reason}</p> : null}
        {d.compareMonth ? (
          <p className="text-xs text-fg-muted">
            {d.change !== null ? <Badge tone={d.better === null ? 'neutral' : d.better ? 'positive' : 'negative'}>{formatChange(d.change, d.metric.unit, currency)}</Badge> : null} against {monthLabel(d.compareMonth)}
            {d.compareValue !== null ? ` (${formatKpi(d.compareValue, d.metric.unit, currency)})` : ''}
          </p>
        ) : null}
        <p className="text-xs text-fg-faint">{d.metric.label}, {monthLabel(d.month)}</p>
      </div>
    );
  if (d.type === 'TOP_CUSTOMERS')
    return (
      <>
        <CardHeader title={title} description={`Revenue from ${date(d.from)} to ${date(d.to)}: ${money(d.total, currency)}`} />
        {d.rows.length ? (
          <Table aria-label={title}>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th numeric>Revenue</Th>
                <Th numeric>Share</Th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <Tr key={r.id}>
                  <Td>{r.name}</Td>
                  <Td numeric>{money(r.revenue, currency)}</Td>
                  <Td numeric>{r.share === null ? '—' : `${r.share}%`}</Td>
                </Tr>
              ))}
              {d.others.count ? (
                <Tr>
                  <Td className="text-fg-muted">{d.others.count} other{d.others.count === 1 ? '' : 's'}</Td>
                  <Td numeric>{money(d.others.revenue, currency)}</Td>
                  <Td numeric>{d.others.share === null ? '—' : `${d.others.share}%`}</Td>
                </Tr>
              ) : null}
            </tbody>
          </Table>
        ) : (
          <p className="px-5 pb-5 text-sm text-fg-muted">No customer revenue in these months.</p>
        )}
      </>
    );
  return (
    <>
      <CardHeader title={title} description={d.metrics.map((m) => m.label).join(', ')} />
      {d.type === 'TABLE' ? null : <Chart d={d} currency={currency} title={title} />}
      <SeriesTable d={d} currency={currency} title={title} hidden={d.type !== 'TABLE'} />
    </>
  );
}

/** Numbers become floats only to place the marks; the tooltip and table show the exact figures. */
function Chart({ d, currency, title }: { d: SeriesData; currency: string; title: string }) {
  const rows = d.rows.map((r) => ({ label: monthLabel(r.month), ...Object.fromEntries(d.metrics.flatMap((m) => [[m.key, r.values[m.key] === null ? null : Number(r.values[m.key])], [`${m.key}Raw`, r.values[m.key]]])) }));
  const unit = d.metrics[0]!.unit;
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const common = (
    <>
      <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} />
      <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => (unit === 'MONEY' ? compact.format(v) : String(v))} width={56} />
      <Tooltip
        contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }}
        labelStyle={{ color: 'var(--t2t-text)' }}
        formatter={(_v, name, item) => [formatKpi((item.payload as Record<string, string | null>)[`${String(item.dataKey)}Raw`] ?? null, unit, currency), name]}
      />
      {d.metrics.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
    </>
  );
  return (
    <div className="h-64 w-full px-2" role="img" aria-label={`${title}: ${d.metrics.map((m) => m.label).join(', ')} by month. The figures are in the table that follows.`}>
      <ResponsiveContainer>
        {d.type === 'LINE' ? (
          <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            {common}
            {d.metrics.map((m, i) => <Line key={m.key} type="monotone" dataKey={m.key} name={m.label} stroke={chartSeries[i % chartSeries.length]} strokeWidth={2.5} dot={{ r: 3 }} connectNulls isAnimationActive={!reducedMotion} />)}
          </LineChart>
        ) : (
          <BarChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            {common}
            {d.metrics.map((m, i) => <Bar key={m.key} dataKey={m.key} name={m.label} fill={chartSeries[i % chartSeries.length]} radius={[4, 4, 0, 0]} isAnimationActive={!reducedMotion} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function SeriesTable({ d, currency, title, hidden }: { d: SeriesData; currency: string; title: string; hidden: boolean }) {
  const table = (
    <Table aria-label={`${title} figures`}>
      <thead>
        <tr>
          <Th>Month</Th>
          {d.metrics.map((m: Metric) => <Th key={m.key} numeric>{m.label}</Th>)}
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r) => (
          <Tr key={r.month}>
            <Td>{monthLabel(r.month)}</Td>
            {d.metrics.map((m) => <Td key={m.key} numeric>{formatKpi(r.values[m.key] ?? null, m.unit, currency)}</Td>)}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
  if (!hidden) return table;
  return (
    <details className="px-5 pb-4 text-sm">
      <summary className="cursor-pointer text-xs text-fg-muted">Show the figures</summary>
      {table}
    </details>
  );
}
