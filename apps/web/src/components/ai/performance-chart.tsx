'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { type AiPerformance, duration } from '@/lib/ai-performance';
import { isMotionReduced } from '@/lib/motion';

/** AI calls per day (answered and failed, stacked) with the 95th percentile time as a line on its own axis. */
export function AiPerformanceChart({ days }: { days: AiPerformance['days'] }) {
  const rows = days.map((d) => ({
    label: new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    answered: d.calls - d.failed,
    failed: d.failed,
    p95: d.p95Ms === null ? null : d.p95Ms / 1000,
    raw: d,
  }));
  const reducedMotion = isMotionReduced();
  return (
    <div className="h-64 w-full" role="img" aria-label="AI calls each day, answered and failed, with the time 95 in 100 calls finished within. The same figures are in the table below.">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} minTickGap={16} />
          <YAxis yAxisId="calls" allowDecimals={false} stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} width={40} />
          <YAxis
            yAxisId="time"
            orientation="right"
            stroke="var(--t2t-text-faint)"
            tickLine={false}
            axisLine={false}
            fontSize={12}
            width={56}
            tickFormatter={(v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${Number(v.toFixed(1))} s`)}
          />
          <Tooltip
            cursor={{ fill: 'rgba(14,165,233,0.08)' }}
            contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }}
            formatter={(v, name, item) => {
              const raw = (item.payload as { raw: AiPerformance['days'][number] }).raw;
              return name === '95% within' ? [duration(raw.p95Ms), name] : [String(v), name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
          <Bar yAxisId="calls" dataKey="answered" name="Answered" stackId="c" fill={chartSeries[0]} maxBarSize={24} isAnimationActive={!reducedMotion} />
          <Bar yAxisId="calls" dataKey="failed" name="Failed" stackId="c" fill={chartSeries[4]} maxBarSize={24} isAnimationActive={!reducedMotion} />
          <Line yAxisId="time" dataKey="p95" name="95% within" stroke={chartSeries[3]} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} type="monotone" isAnimationActive={!reducedMotion} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
