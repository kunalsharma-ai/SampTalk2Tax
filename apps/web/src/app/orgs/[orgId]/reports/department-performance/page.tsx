'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { DepartmentBars, DepartmentTrend, type DepartmentPerformance } from '@/components/reports/department-performance';
import { monthLabel } from '@/components/reports/financial-visuals';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const BUDGET: Record<'UNDER' | 'NEAR' | 'OVER', { label: string; tone: 'positive' | 'warning' | 'negative'; bar: string }> = {
  UNDER: { label: 'Within budget', tone: 'positive', bar: 'bg-positive' },
  NEAR: { label: 'Near the budget', tone: 'warning', bar: 'bg-warning' },
  OVER: { label: 'Over budget', tone: 'negative', bar: 'bg-negative' },
};

/**
 * Reports → Department performance (DASH-035): revenue, spending, profit and margin per
 * department, month by month and against each department's spending budget, from journal lines
 * booked to departments. A department opens its own profit and loss for the same months.
 */
export default function DepartmentPerformancePage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(() => today().slice(0, 7));
  const [from, setFrom] = useState(() => shift(today().slice(0, 7), -5));
  const q = useQuery({ queryKey: ['department-performance', orgId, from, to], queryFn: () => api<DepartmentPerformance>(`/v1/orgs/${orgId}/reports/department-performance?from=${from}&to=${to}`), enabled: /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to) });
  if (!org) return null;
  const r = q.data;
  const c = r?.currency ?? org.functionalCurrency;
  const pl = (id: string | null) => `/orgs/${orgId}/reports/income-statement?from=${r?.fromDate}&to=${r?.toDate}${id ? `&departmentId=${id}` : ''}`;
  return (
    <>
      <PageHeader
        title="Department performance"
        description="How each department is doing over the months you choose: what it earned, what it spent, its profit and margin, month by month, and its spending against this fiscal year's budget. Built from journal lines booked to departments; what carries no department is shown apart."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From month">{(p) => <Input {...p} type="month" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To month">{(p) => <Input {...p} type="month" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        {r ? <p className="pb-2 text-sm text-fg-muted">{monthLabel(r.from)} to {monthLabel(r.to)}: profit <Money value={r.totals.profit} currency={c} signed />{r.totals.margin !== null ? `, margin ${r.totals.margin}%` : ''}</p> : null}
      </div>
      <ErrorAlert title="Could not load department performance" error={q.error} />
      {r && !r.hasDepartments ? (
        <EmptyState title="No departments yet">Add departments under Settings → Departments and projects, then book revenue and costs to them on invoices, bills, expense claims and journals.</EmptyState>
      ) : r && !r.rows.length ? (
        <EmptyState title="Nothing booked to departments in these months">Choose other months, or book revenue and costs to departments.</EmptyState>
      ) : null}
      {r && r.rows.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card role="region" aria-label="Departments compared" className="xl:col-span-2">
            <CardHeader title="Departments compared" description="Revenue, spending and profit of each department over the months chosen." />
            <DepartmentBars rows={r.rows} currency={c} />
          </Card>
          <Card role="region" aria-label="Profit month by month" className="xl:col-span-2">
            <CardHeader title="Profit month by month" description="Each department's profit in each month, to see who is improving and who is slipping." />
            <DepartmentTrend rows={r.rows} months={r.months} currency={c} />
          </Card>
          <Card role="region" aria-label="Department ranking" className="xl:col-span-2">
            <CardHeader title="Department ranking" description={`Ranked by profit. Spending trend compares the last month with the average of the months before it. Budgets are for fiscal year ${r.fiscalYear}, with spending since ${r.fiscalYearStart}.`} />
            <Table aria-label="Department ranking">
              <thead><Tr><Th>Department</Th><Th numeric>Revenue</Th><Th numeric>Spending</Th><Th numeric>Profit</Th><Th numeric>Margin</Th><Th numeric>Share of spending</Th><Th numeric>Spending trend</Th><Th>Budget this year</Th></Tr></thead>
              <tbody>
                {r.rows.map((d) => (
                  <Tr key={d.id ?? 'none'} data-testid={`dept-${d.code ?? 'none'}`}>
                    <Td><Link className="hover:text-accent" href={pl(d.id)}>{d.code ? <span className="num text-fg-muted">{d.code} </span> : null}{d.name}</Link></Td>
                    <Td numeric><Money value={d.revenue} currency={c} /></Td>
                    <Td numeric><Money value={d.expenses} currency={c} /></Td>
                    <Td numeric><Money value={d.profit} currency={c} signed /></Td>
                    <Td numeric>{d.margin === null ? '—' : `${d.margin}%`}</Td>
                    <Td numeric>{d.expenseShare}%</Td>
                    <Td numeric>{d.expenseTrend === null ? '—' : <span className={d.expenseTrend > 10 ? 'text-negative' : d.expenseTrend < -10 ? 'text-positive' : ''}>{d.expenseTrend > 0 ? '+' : ''}{d.expenseTrend}%</span>}</Td>
                    <Td>
                      {d.budget ? (
                        <div className="min-w-44">
                          <div className="flex items-center justify-between gap-2 text-xs"><Badge tone={BUDGET[d.budget.status].tone}>{BUDGET[d.budget.status].label}</Badge><span className="text-fg-muted">{d.budget.usedPercent ?? 0}% of <Money value={d.budget.amount} currency={c} /></span></div>
                          <div className="mt-1 h-1.5 w-full rounded-full bg-surface-hover" aria-hidden="true"><div className={`h-1.5 rounded-full ${BUDGET[d.budget.status].bar}`} style={{ width: `${Math.min(100, d.budget.usedPercent ?? 0)}%` }} /></div>
                        </div>
                      ) : d.id ? <span className="text-xs text-fg-muted">No budget</span> : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <Tr><Td className="font-semibold">All departments</Td><Td numeric className="font-semibold"><Money value={r.totals.revenue} currency={c} /></Td><Td numeric className="font-semibold"><Money value={r.totals.expenses} currency={c} /></Td><Td numeric className="font-semibold"><Money value={r.totals.profit} currency={c} signed /></Td><Td numeric>{r.totals.margin === null ? '—' : `${r.totals.margin}%`}</Td><Td numeric>100%</Td><Td /><Td /></Tr>
              </tfoot>
            </Table>
            {r.totals.unassignedExpenseShare > 0 ? <p className="px-4 py-3 text-xs text-fg-muted">{r.totals.unassignedExpenseShare}% of spending carries no department. Book it to departments to see the full picture.</p> : null}
          </Card>
        </div>
      ) : null}
    </>
  );
}
