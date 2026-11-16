'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ForecastDay } from '@/lib/cashflow';
import { date, money } from '@/lib/format';

/**
 * The daily balance in the base case, the range between the low and high cases, the minimum
 * balance and (for a saved forecast) the actual balance. Numbers become floats only to place
 * marks; the tooltip shows the exact decimal strings from the API.
 */
export function ForecastChart({ days, actual, minimumBalance, currency }: { days: ForecastDay[]; actual?: Map<string, string>; minimumBalance?: string | null; currency: string }) {
  const rows = days.map((d) => ({ date: d.date, range: [Number(d.low), Number(d.high)] as [number, number], base: Number(d.base), actual: actual?.has(d.date) ? Number(actual.get(d.date)) : undefined, raw: d, rawActual: actual?.get(d.date) }));
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const buffer = minimumBalance && Number(minimumBalance) > 0 ? Number(minimumBalance) : null;
  const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <div className="h-80 w-full" role="img" aria-label="Daily cash balance forecast with its likely range. The same figures are in the table below.">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={short} minTickGap={28} />
          <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={60} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }}
            labelStyle={{ color: 'var(--t2t-text)' }}
            labelFormatter={(l) => date(String(l))}
            formatter={(_v, name, item) => {
              const p = item.payload as (typeof rows)[number];
              if (name === 'Likely range') return [`${money(p.raw.low, currency)} – ${money(p.raw.high, currency)}`, name];
              if (name === 'Actual') return [money(p.rawActual ?? null, currency), name];
              return [money(p.raw.base, currency), name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
          <Area dataKey="range" name="Likely range" stroke="none" fill={chartSeries[0]} fillOpacity={0.15} isAnimationActive={!reducedMotion} />
          <Line dataKey="base" name="Expected balance" stroke={chartSeries[0]} strokeWidth={2} dot={false} type="stepAfter" isAnimationActive={!reducedMotion} />
          {actual ? <Line dataKey="actual" name="Actual" stroke={chartSeries[2]} strokeWidth={2} dot={false} type="stepAfter" connectNulls={false} isAnimationActive={!reducedMotion} /> : null}
          {buffer !== null ? <ReferenceLine y={buffer} stroke="var(--t2t-warning)" strokeDasharray="6 4" ifOverflow="extendDomain" label={{ value: 'Minimum balance', position: 'insideTopRight', fill: 'var(--t2t-text-muted)', fontSize: 11 }} /> : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
