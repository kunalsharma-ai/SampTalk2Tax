'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Table, Td, Th, Tr } from '@talk2tax/ui';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Money } from '@/components/money';
import { money } from '@/lib/format';
import { monthLabel } from './financial-visuals';

export interface DepartmentRow {
  id: string | null;
  code: string | null;
  name: string;
  revenue: string;
  expenses: string;
  profit: string;
  margin: number | null;
  expenseShare: number;
  months: { month: string; revenue: string; expenses: string; profit: string }[];
  expenseTrend: number | null;
  budget: { amount: string; spent: string; remaining: string; usedPercent: number | null; status: 'UNDER' | 'NEAR' | 'OVER' } | null;
}
export interface DepartmentPerformance {
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  currency: string;
  fiscalYear: number;
  fiscalYearStart: string;
  hasDepartments: boolean;
  months: string[];
  rows: DepartmentRow[];
  totals: { revenue: string; expenses: string; profit: string; margin: number | null; unassignedExpenseShare: number };
}

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const TIP = { background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 };
const LINE_COLOURS = [...chartSeries, '#f472b6', '#fb923c', '#a3e635'];

/** Revenue, spending and profit side by side for each department. Floats only place the bars; the ranking table has the figures. */
export function DepartmentBars({ rows, currency }: { rows: DepartmentRow[]; currency: string }) {
  const data = rows.map((r) => ({ name: r.name, revenue: Number(r.revenue), expenses: Number(r.expenses), profit: Number(r.profit), raw: r }));
  const field = { Revenue: 'revenue', Spending: 'expenses', Profit: 'profit' } as const;
  return (
    <div className="h-80 w-full px-2 pb-4" role="img" aria-label="Revenue, spending and profit by department. The same figures are in the ranking table below.">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={11} interval={0} />
          <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={56} />
          <Tooltip cursor={{ fill: 'rgba(14,165,233,0.08)' }} contentStyle={TIP} formatter={(_v, name, item) => [money((item.payload as { raw: DepartmentRow }).raw[field[name as keyof typeof field]], currency), name]} />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
          <Bar dataKey="revenue" name="Revenue" fill={chartSeries[0]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={!reduced()} />
          <Bar dataKey="expenses" name="Spending" fill={chartSeries[4]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={!reduced()} />
          <Bar dataKey="profit" name="Profit" fill={chartSeries[2]} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={!reduced()} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Each department's profit by month as lines, with the same figures in a table beneath. */
export function DepartmentTrend({ rows, months, currency }: { rows: DepartmentRow[]; months: string[]; currency: string }) {
  const data = months.map((m, i) => ({ label: monthLabel(m), ...Object.fromEntries(rows.map((r, k) => [`d${k}`, Number(r.months[i]?.profit ?? 0)])) }));
  return (
    <>
      <div className="h-64 w-full px-2" role="img" aria-label="Profit by department and month. The same figures are in the table below the chart.">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={56} />
            <Tooltip contentStyle={TIP} formatter={(_v, name, item) => { const k = Number(String(item.dataKey).slice(1)); const i = months.findIndex((m) => monthLabel(m) === (item.payload as { label: string }).label); return [money(rows[k]?.months[i]?.profit ?? '0', currency), name]; }} />
            <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
            {rows.map((r, k) => <Line key={r.id ?? 'none'} dataKey={`d${k}`} name={r.name} stroke={LINE_COLOURS[k % LINE_COLOURS.length]} strokeWidth={2} dot={months.length < 3} type="linear" isAnimationActive={!reduced()} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="overflow-x-auto pb-2">
        <Table aria-label="Profit by department and month">
          <thead><Tr><Th>Department</Th>{months.map((m) => <Th key={m} numeric>{monthLabel(m)}</Th>)}</Tr></thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id ?? 'none'}><Td>{r.name}</Td>{r.months.map((m) => <Td key={m.month} numeric><Money value={m.profit} currency={currency} signed /></Td>)}</Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}
