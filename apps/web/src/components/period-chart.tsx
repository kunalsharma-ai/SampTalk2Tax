'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '@/lib/format';

export interface PeriodPoint {
  name: string;
  startDate: string;
  revenue: string;
  expenses: string;
  netIncome: string;
  closingCash: string;
}

/**
 * Revenue vs expenses per period with closing cash. Numbers are converted to floats ONLY
 * to position marks; every label and tooltip shows the exact decimal string from the API.
 */
export function PeriodChart({ data, currency }: { data: PeriodPoint[]; currency: string }) {
  const rows = data.map((d) => ({
    label: new Date(`${d.startDate}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
    revenue: Number(d.revenue),
    expenses: Number(d.expenses),
    closingCash: Number(d.closingCash),
    raw: d,
  }));
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  return (
    <div className="h-72 w-full" role="img" aria-label="Revenue, expenses and closing cash by period. The same figures are in the table below.">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} />
          <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={56} />
          <Tooltip
            cursor={{ fill: 'rgba(56,217,245,0.06)' }}
            contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }}
            labelStyle={{ color: 'var(--t2t-text)' }}
            formatter={(_v, name, item) => {
              const raw = (item.payload as { raw: PeriodPoint }).raw;
              const key = name === 'Revenue' ? 'revenue' : name === 'Expenses' ? 'expenses' : 'closingCash';
              return [money(raw[key], currency), name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
          <Bar dataKey="revenue" name="Revenue" fill={chartSeries[0]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={!reducedMotion} />
          <Bar dataKey="expenses" name="Expenses" fill={chartSeries[1]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={!reducedMotion} />
          <Line dataKey="closingCash" name="Closing cash" stroke={chartSeries[2]} strokeWidth={2} dot={{ r: 3 }} type="monotone" isAnimationActive={!reducedMotion} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
