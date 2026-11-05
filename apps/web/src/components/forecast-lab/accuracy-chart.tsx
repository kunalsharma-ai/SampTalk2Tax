'use client';
import { chartSeries } from '@talk2tax/design-system';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '@/lib/format';
import { monthName, type SeriesBacktest } from '@/lib/forecast-lab';

/**
 * Actual figures against what each chosen model forecast one month ahead. Numbers become floats
 * only to place the lines; the tooltip shows the exact decimal strings. The same figures are in
 * the table below the chart.
 */
export function AccuracyChart({ bt, models, labels, currency }: { bt: SeriesBacktest; models: string[]; labels: Record<string, string>; currency: string }) {
  const rows = bt.actuals.map((a) => {
    const row: Record<string, string | number | null> = { label: monthName(a.month), actual: Number(a.value), actualRaw: a.value };
    for (const m of models) {
      const p = bt.models.find((x) => x.model === m)?.points.find((x) => x.month === a.month && x.horizon === 1);
      row[m] = p ? Number(p.forecast) : null;
      row[`${m}Raw`] = p?.forecast ?? null;
    }
    return row;
  });
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  return (
    <div className="h-72 w-full" role="img" aria-label="Actual figures and one-month-ahead forecasts by month. The same figures are in the table below.">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} />
          <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={56} />
          <Tooltip
            contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }}
            labelStyle={{ color: 'var(--t2t-text)' }}
            formatter={(_v, name, item) => {
              const key = String(item.dataKey);
              const raw = (item.payload as Record<string, string | null>)[`${key}Raw`];
              return [raw === null || raw === undefined ? '—' : money(raw, currency), name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="actual" name="Actual" stroke={chartSeries[0]} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={!reducedMotion} />
          {models.map((m, i) => (
            <Line key={m} type="monotone" dataKey={m} name={`${labels[m]} (1 month ahead)`} stroke={chartSeries[(i + 1) % chartSeries.length]} strokeDasharray="5 4" strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={!reducedMotion} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
