'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '@/lib/format';
import type { ForecastMonth } from '@/lib/revenue-forecast';

const KEYS = [
  ['contracts', 'Contracts'],
  ['orders', 'Sales orders'],
  ['pipelineWeighted', 'Pipeline (weighted)'],
  ['otherSales', 'Other sales'],
] as const;
// Distinct hues for adjacent stacked series: sky, amber, emerald, violet; the best-case line is indigo and dashed.
const COLOURS: Record<(typeof KEYS)[number][0], string> = { contracts: chartSeries[0], orders: chartSeries[4], pipelineWeighted: chartSeries[2], otherSales: chartSeries[3] };

/** Stacked expected revenue by stream with the best case as a line. Floats only place the marks; tooltips show the API's strings. */
export function ForecastChart({ months, currency, actualSoFar }: { months: ForecastMonth[]; currency: string; actualSoFar?: string }) {
  const rows = months.map((m, i) => ({
    label: new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    invoiced: i === 0 && actualSoFar ? Number(actualSoFar) : 0,
    contracts: Number(m.contracts),
    orders: Number(m.orders),
    pipelineWeighted: Number(m.pipelineWeighted),
    otherSales: Number(m.otherSales),
    best: Number(m.best) + (i === 0 && actualSoFar ? Number(actualSoFar) : 0),
    raw: m,
  }));
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  return (
    <div className="h-72 w-full" role="img" aria-label="Expected revenue by month and stream, with the best case. The same figures are in the table below.">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} />
          <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={56} />
          <Tooltip
            cursor={{ fill: 'rgba(14,165,233,0.08)' }}
            contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }}
            formatter={(v, name, item) => {
              const raw = (item.payload as { raw: ForecastMonth }).raw;
              const k = KEYS.find(([, l]) => l === name)?.[0];
              return [k ? money(raw[k], currency) : money(String(v), currency), name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
          {actualSoFar ? <Bar dataKey="invoiced" name="Invoiced so far" stackId="a" fill="var(--t2t-text-faint)" isAnimationActive={!reducedMotion} maxBarSize={32} /> : null}
          {KEYS.map(([k, label]) => <Bar key={k} dataKey={k} name={label} stackId="a" fill={COLOURS[k]} maxBarSize={32} isAnimationActive={!reducedMotion} />)}
          <Line dataKey="best" name="Best case" stroke={chartSeries[1]} strokeDasharray="4 3" strokeWidth={2} dot={false} type="monotone" isAnimationActive={!reducedMotion} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
