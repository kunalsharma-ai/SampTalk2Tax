'use client';
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';

/** A small trend line. Values become floats only to draw it; nothing is read from it. */
export function Sparkline({ values, tone }: { values: (string | null)[]; tone: string }) {
  const data = values.map((v, i) => ({ i, v: v === null ? null : Number(v) }));
  return (
    <div className="h-10 w-full" aria-hidden="true">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 4 }}>
          <YAxis hide domain={['auto', 'auto']} />
          <Line dataKey="v" stroke={tone} strokeWidth={1.75} dot={false} isAnimationActive={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
