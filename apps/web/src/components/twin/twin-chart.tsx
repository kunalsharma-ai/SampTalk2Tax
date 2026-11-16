'use client';
import { chartSeries } from '@talk2tax/design-system';
import { CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '@/lib/format';
import { monthLabel, type TwinMonth } from '@/lib/twin';

type Series = { name: string; months: TwinMonth[] };

/**
 * Month-end cash: actual months as a solid line, then each projection dashed over a shaded
 * "hypothetical" band, so actual and hypothetical figures are never confused. Floats only place
 * the marks; the tooltip shows the exact decimal strings.
 */
export function TwinCashChart({ actual, series, currency, label }: { actual: { month: string; cash: string }[]; series: Series[]; currency: string; label: string }) {
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const rows: Record<string, number | string | undefined>[] = actual.map((a) => ({ month: a.month, actual: Number(a.cash), rawActual: a.cash }));
  const last = rows[rows.length - 1];
  // Each projection starts from the last actual balance so the lines join up.
  if (last) series.forEach((_, i) => (last[`s${i}`] = last.actual));
  const months = series[0]?.months ?? [];
  months.forEach((m, j) => {
    const row: Record<string, number | string | undefined> = { month: m.month };
    series.forEach((s, i) => {
      const x = s.months[j];
      if (x) (row[`s${i}`] = Number(x.closingCash)), (row[`raw${i}`] = x.closingCash);
    });
    rows.push(row);
  });
  const colors = ['var(--t2t-text-faint)', chartSeries[0], chartSeries[4], chartSeries[1], chartSeries[3]];
  const firstProjected = months[0]?.month;
  const lastProjected = months[months.length - 1]?.month;
  return (
    <div className="h-80 w-full" role="img" aria-label={label}>
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          {firstProjected && lastProjected ? (
            <ReferenceArea x1={firstProjected} x2={lastProjected} fill="var(--t2t-violet, #8b5cf6)" fillOpacity={0.06} label={{ value: 'Hypothetical', position: 'insideTopLeft', fill: 'var(--t2t-text-muted)', fontSize: 11 }} />
          ) : null}
          <XAxis dataKey="month" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={monthLabel} minTickGap={24} />
          <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={64} domain={['auto', 'auto']} />
          <ReferenceLine y={0} stroke="var(--t2t-negative)" strokeOpacity={0.5} />
          <Tooltip
            contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }}
            labelStyle={{ color: 'var(--t2t-text)' }}
            labelFormatter={(m) => monthLabel(String(m))}
            formatter={(_v, name, item) => {
              const p = item.payload as Record<string, string>;
              const key = String(item.dataKey);
              const raw = key === 'actual' ? p.rawActual : p[`raw${key.slice(1)}`] ?? p.rawActual;
              return [money(raw, currency), name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
          {actual.length ? <Line dataKey="actual" name="Actual (from the books)" stroke={chartSeries[2]} strokeWidth={2.5} dot={false} isAnimationActive={!reducedMotion} /> : null}
          {series.map((s, i) => (
            <Line key={s.name} dataKey={`s${i}`} name={s.name} stroke={colors[i % colors.length]} strokeWidth={2} strokeDasharray={i === 0 ? '3 4' : '7 4'} dot={false} isAnimationActive={!reducedMotion} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
