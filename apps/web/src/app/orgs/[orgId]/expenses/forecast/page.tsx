'use client';
import { useQuery } from '@tanstack/react-query';
import { EXPENSE_FORECAST_METHOD_LABEL, type ExpenseForecastMethod } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Month = { month: string; forecast: string; low: string; high: string };
interface Forecast {
  asOf: string;
  currency: string;
  months: string[];
  accounts: { accountId: string; accountLabel: string; method: ExpenseForecastMethod; basis: string; history: { month: string; amount: string }[]; thisMonthSoFar: string; months: Month[]; trendPercent: string | null }[];
  occasional: { accountId: string; accountLabel: string; lastSpent: string; total12Months: string }[];
  totals: Month[];
  thisMonthSoFar: string;
  owed: { approvedNotPaid: string; approvedClaims: number; waitingApproval: string; waitingClaims: number };
}
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Expenses → Expense forecast (EXP-025): likely spending on expense claims in the coming months. */
export default function ExpenseForecastPage() {
  const { org, orgId } = useOrg();
  const [months, setMonths] = useState('3');
  const q = useQuery({ queryKey: ['expense-forecast', orgId, months], queryFn: () => api<Forecast>(`/v1/orgs/${orgId}/expense-forecast?months=${months}`) });
  if (!org) return null;
  const f = q.data;
  const c = f?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Expense forecast"
        description="What expense claims are likely to cost in the coming months, by expense account, worked out from the claims approved over the last year: the average of the last three months, adjusted for the season once there is a year of history, with a likely range. Plan cash and budgets with it; it is not a limit."
        actions={<div className="w-40"><Select aria-label="Months ahead" value={months} onChange={(e) => setMonths(e.target.value)}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} month{n === 1 ? '' : 's'}</option>)}</Select></div>}
      />
      <ErrorAlert title="Could not work out the expense forecast" error={q.error} />
      {f ? (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card className="p-4"><p className="text-sm text-fg-muted">Expected this month</p><p className="mt-1 text-2xl font-semibold"><Money value={f.totals[0]?.forecast ?? '0'} currency={c} /></p><p className="text-xs text-fg-muted">Likely <Money value={f.totals[0]?.low ?? '0'} currency={c} /> to <Money value={f.totals[0]?.high ?? '0'} currency={c} /></p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Spent so far this month</p><p className="mt-1 text-2xl font-semibold"><Money value={f.thisMonthSoFar} currency={c} /></p><p className="text-xs text-fg-muted">Approved claims, by date spent</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Owed to employees</p><p className="mt-1 text-2xl font-semibold text-warning"><Money value={f.owed.approvedNotPaid} currency={c} /></p><p className="text-xs text-fg-muted">{f.owed.approvedClaims} approved claim{f.owed.approvedClaims === 1 ? '' : 's'} not yet paid back</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Waiting for approval</p><p className="mt-1 text-2xl font-semibold"><Money value={f.owed.waitingApproval} currency={c} /></p><p className="text-xs text-fg-muted">{f.owed.waitingClaims} submitted claim{f.owed.waitingClaims === 1 ? '' : 's'}</p></Card>
        </div>
      ) : null}
      {f ? (
        <Card className="mt-6" role="region" aria-label="Forecast by account">
          <CardHeader title="Forecast by account" description={`Expected spending, with the likely range below it. As of ${date(f.asOf)}.`} />
          {f.accounts.length ? (
            <Table aria-label="Forecast by account">
              <thead>
                <Tr>
                  <Th>Account</Th>
                  <Th numeric>Last 3 months</Th>
                  {f.months.map((m) => <Th key={m} numeric>{monthName(m)}</Th>)}
                </Tr>
              </thead>
              <tbody>
                {f.accounts.map((a) => (
                  <Tr key={a.accountId}>
                    <Td className="align-top">
                      <span className="font-medium">{a.accountLabel}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-2"><Badge tone={a.method === 'SEASONAL' ? 'violet' : 'neutral'}>{EXPENSE_FORECAST_METHOD_LABEL[a.method]}</Badge>{a.trendPercent ? <span className={`text-xs ${a.trendPercent.startsWith('-') ? 'text-positive' : 'text-warning'}`}>{a.trendPercent.startsWith('-') ? '' : '+'}{a.trendPercent}% on the 3 months before</span> : null}</span>
                      <span className="block max-w-md text-xs text-fg-muted">{a.basis}</span>
                    </Td>
                    <Td numeric className="align-top text-sm">{a.history.slice(-3).map((h) => <span key={h.month} className="block"><span className="text-fg-muted">{monthName(h.month)}</span> <Money value={h.amount} currency={c} /></span>)}</Td>
                    {a.months.map((m, i) => (
                      <Td key={m.month} numeric className="align-top">
                        <Money value={m.forecast} currency={c} />
                        <span className="block text-xs text-fg-muted"><Money value={m.low} currency={c} /> to <Money value={m.high} currency={c} /></span>
                        {i === 0 ? <span className="block text-xs">So far <Money value={a.thisMonthSoFar} currency={c} /></span> : null}
                      </Td>
                    ))}
                  </Tr>
                ))}
                <Tr>
                  <Td className="font-semibold">Total</Td>
                  <Td />
                  {f.totals.map((m) => <Td key={m.month} numeric className="font-semibold"><Money value={m.forecast} currency={c} /><span className="block text-xs font-normal text-fg-muted"><Money value={m.low} currency={c} /> to <Money value={m.high} currency={c} /></span></Td>)}
                </Tr>
              </tbody>
            </Table>
          ) : (
            <EmptyState title="Not enough history yet">An account is forecast once approved claims have spent on it in at least two of the last six months.</EmptyState>
          )}
        </Card>
      ) : null}
      {f && f.occasional.length ? (
        <Card className="mt-6">
          <CardHeader title="Spent on now and then" description="Accounts with spending in fewer than two of the last six months: too irregular to forecast. Plan these by hand." />
          <Table aria-label="Spent on now and then">
            <thead><Tr><Th>Account</Th><Th>Last spent</Th><Th numeric>Last 12 months</Th></Tr></thead>
            <tbody>{f.occasional.map((o) => <Tr key={o.accountId}><Td>{o.accountLabel}</Td><Td>{date(o.lastSpent)}</Td><Td numeric><Money value={o.total12Months} currency={c} /></Td></Tr>)}</tbody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
