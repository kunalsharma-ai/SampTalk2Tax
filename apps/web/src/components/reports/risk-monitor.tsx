'use client';
import { chartSeries } from '@talk2tax/design-system';
import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { isMotionReduced } from '@/lib/motion';

export type RiskLevel = 'CLEAR' | 'LOW' | 'ELEVATED' | 'HIGH' | 'SEVERE';
export interface RiskAreaView {
  area: string;
  name: string;
  href: string;
  high: number;
  medium: number;
  low: number;
  findings: number;
  active: boolean;
  available: boolean;
  score: number;
  level: RiskLevel;
  change: number | null;
  window: string | null;
  top: { title: string; detail: string; level: 'HIGH' | 'MEDIUM' | 'LOW' }[];
}
export interface RiskMonitor {
  today: string;
  score: number;
  level: RiskLevel;
  change: number | null;
  complete: boolean;
  previous: { date: string; score: number; level: RiskLevel } | null;
  focus: string[];
  areas: RiskAreaView[];
  history: { date: string; score: number; level: RiskLevel; areas: Record<string, number> }[];
}

export const LEVEL: Record<RiskLevel, { label: string; tone: 'positive' | 'neutral' | 'warning' | 'negative'; colour: string }> = {
  CLEAR: { label: 'Clear', tone: 'positive', colour: '#34d399' },
  LOW: { label: 'Low', tone: 'neutral', colour: '#38bdf8' },
  ELEVATED: { label: 'Elevated', tone: 'warning', colour: '#fbbf24' },
  HIGH: { label: 'High', tone: 'negative', colour: '#fb923c' },
  SEVERE: { label: 'Severe', tone: 'negative', colour: '#f87171' },
};
const BANDS: [number, number, RiskLevel][] = [[0, 25, 'LOW'], [25, 50, 'ELEVATED'], [50, 75, 'HIGH'], [75, 100, 'SEVERE']];

/** The overall score on a half-circle dial, coloured by its level. */
export function RiskGauge({ score, level }: { score: number; level: RiskLevel }) {
  const angle = Math.PI * (1 - score / 100); // not money
  const x = 100 + 80 * Math.cos(angle); // not money
  const y = 100 - 80 * Math.sin(angle); // not money
  return (
    <svg viewBox="0 0 200 116" className="h-36 w-56" role="img" aria-label={`Overall risk ${score} out of 100: ${LEVEL[level].label}. Each area’s score is listed below, and the readings by day are in the Risk readings by day table.`}>
      {BANDS.map(([a, b, l]) => {
        const p = (v: number) => [100 + 80 * Math.cos(Math.PI * (1 - v / 100)), 100 - 80 * Math.sin(Math.PI * (1 - v / 100))]; // not money
        const [x1, y1] = p(a);
        const [x2, y2] = p(b);
        return <path key={l} d={`M ${x1} ${y1} A 80 80 0 0 1 ${x2} ${y2}`} stroke={LEVEL[l].colour} strokeOpacity={0.3} strokeWidth={14} fill="none" />;
      })}
      {score > 0 ? <path d={`M 20 100 A 80 80 0 0 1 ${x} ${y}`} stroke={LEVEL[level].colour} strokeWidth={14} fill="none" strokeLinecap="round" /> : null}
      <text x={100} y={92} textAnchor="middle" fontSize={34} fontWeight={600} fill="var(--t2t-text)">{score}</text>
      <text x={100} y={112} textAnchor="middle" fontSize={12} fill="var(--t2t-text-muted)">{LEVEL[level].label}</text>
    </svg>
  );
}

const reduced = () => isMotionReduced();
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The overall score and each area's score by day, over the level bands. */
export function RiskTrend({ history, areas }: { history: RiskMonitor['history']; areas: RiskAreaView[] }) {
  const data = history.map((h) => ({ label: dayLabel(h.date), overall: h.score, ...h.areas }));
  const shown = areas.filter((a) => a.available && history.some((h) => (h.areas[a.area] ?? 0) > 0));
  return (
    <div className="h-64 w-full px-2" role="img" aria-label="Overall risk score and each area's score by day. The same figures are in the table below the chart.">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {BANDS.map(([a, b, l]) => <ReferenceArea key={l} y1={a} y2={b} fill={LEVEL[l].colour} fillOpacity={0.06} stroke="none" />)}
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} width={36} />
          <Tooltip contentStyle={{ background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
          <Line dataKey="overall" name="Overall" stroke="var(--t2t-text)" strokeWidth={2.5} dot={data.length < 3} type="linear" isAnimationActive={!reduced()} />
          {shown.map((a, i) => <Line key={a.area} dataKey={a.area} name={a.name} stroke={chartSeries[i % chartSeries.length]} strokeWidth={1.5} strokeDasharray="4 3" dot={data.length < 3} type="linear" isAnimationActive={!reduced()} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
