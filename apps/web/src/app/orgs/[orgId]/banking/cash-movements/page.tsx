'use client';
import { useQuery } from '@tanstack/react-query';
import { CASH_MOVEMENT_FREQUENCY_LABEL, type CashMovementFrequency } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ForecastChart } from '@/components/cash-flow/forecast-chart';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Recurring {
  narration: string;
  direction: 'IN' | 'OUT';
  frequency: CashMovementFrequency;
  amount: string;
  spreadPercent: number;
  count: number;
  firstDate: string;
  lastDate: string;
  running: boolean;
  next: { date: string; amount: string; late: boolean }[];
}
interface Week {
  from: string;
  to: string;
  recurringIn: string;
  recurringOut: string;
  otherIn: string;
  otherOut: string;
  net: string;
  balance: string;
  low: string;
  high: string;
}
interface AccountForecast {
  account: { id: string; code: string; name: string; currency: string; lastStatementDate: string | null };
  asOf: string;
  days: number;
  startBalance: string;
  basis: { lines: number; from: string | null; to: string | null; otherWeeks: number };
  recurring: Recurring[];
  other: { weeklyIn: string; weeklyOut: string; lowNet: string; highNet: string };
  weeks: Week[];
  endBalance: string;
  lowest: { balance: string; weekTo: string };
  thin: boolean;
}
interface Result {
  asOf: string;
  days: number;
  summary: { accounts: number; recurring: number; belowZero: number };
  accounts: AccountForecast[];
}

/** Cash movement forecasting (BANK-022): each bank account's balance week by week ahead. */
export default function CashMovementsPage() {
  const { org, orgId } = useOrg();
  const [days, setDays] = useState('90');
  const [accountId, setAccountId] = useState('');
  const q = useQuery({ queryKey: ['cash-movements', orgId, days], queryFn: () => api<Result>(`/v1/orgs/${orgId}/banking/cash-movements?days=${days}`) });
  if (!org) return null;
  const d = q.data;
  const a = d ? (d.accounts.find((x) => x.account.id === accountId) ?? d.accounts[0] ?? null) : null;
  return (
    <>
      <PageHeader
        title="Bank cash forecast"
        description="Each bank account's balance week by week, from the movements that repeat on its imported statements (rent, salaries, settlements, loan instalments) and the rest of its recent movements, starting from its balance in the books. For the forecast from invoices and bills, see the Cash-flow forecast."
        actions={
          <>
            {d && d.accounts.length > 1 ? (
              <label className="flex items-center gap-2 text-sm text-fg-muted">
                Bank account
                <Select aria-label="Bank account" className="w-56" value={a?.account.id ?? ''} onChange={(e) => setAccountId(e.target.value)}>
                  {d.accounts.map((x) => <option key={x.account.id} value={x.account.id}>{x.account.name}</option>)}
                </Select>
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              Weeks ahead
              <Select aria-label="Weeks ahead" className="w-36" value={days} onChange={(e) => setDays(e.target.value)}>
                {[['30', 'Next 30 days'], ['60', 'Next 60 days'], ['90', 'Next 90 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </label>
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/cash-flow`}>Cash-flow forecast</Link>
          </>
        }
      />
      <ErrorAlert title="Could not forecast bank cash" error={q.error} />
      {d && !a ? (
        <EmptyState title="No statements yet">Import a bank statement on an account to forecast its movements. A year of statements finds the most that repeats.</EmptyState>
      ) : null}
      {a ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Balance in the books" value={<Money value={a.startBalance} currency={a.account.currency} />} sub={`${a.account.name}, today`} />
            <Stat label="Expected at the end" value={<Money value={a.endBalance} currency={a.account.currency} />} sub={`After ${a.days} days`} />
            <Stat label="Lowest expected" value={<Money value={a.lowest.balance} currency={a.account.currency} />} tone={a.lowest.balance.startsWith('-') ? 'negative' : 'positive'} sub={`Week to ${date(a.lowest.weekTo)}`} />
            <Stat label="Repeating movements" value={a.recurring.filter((r) => r.running).length} sub={`From ${a.basis.lines} statement lines${a.basis.from ? ` since ${date(a.basis.from)}` : ''}`} />
          </div>
          {a.thin ? <p className="mb-4 rounded-md border border-border bg-surface-raised p-3 text-sm text-fg-muted">Less than 13 weeks of statements: the movements that do not repeat are a rough guide. Import older statements to improve it.</p> : null}
          <Card className="mb-4">
            <CardHeader title="Balance week by week" description="The expected balance at the end of each week, and the range from how the other movements have varied week to week (not a statistical confidence interval)." />
            <ForecastChart currency={a.account.currency} days={[{ date: a.asOf, base: a.startBalance, low: a.startBalance, high: a.startBalance }, ...a.weeks.map((w) => ({ date: w.to, base: w.balance, low: w.low, high: w.high }))]} />
            <Table aria-label="Weekly bank balance forecast">
              <thead><Tr><Th>Week</Th><Th numeric>Repeating in</Th><Th numeric>Repeating out</Th><Th numeric>Other in</Th><Th numeric>Other out</Th><Th numeric>Balance</Th><Th numeric>Range</Th></Tr></thead>
              <tbody>
                {a.weeks.map((w) => (
                  <Tr key={w.from}>
                    <Td className="whitespace-nowrap">{date(w.from)} to {date(w.to)}</Td>
                    <Td numeric><Money value={w.recurringIn} currency={a.account.currency} /></Td>
                    <Td numeric><Money value={w.recurringOut} currency={a.account.currency} /></Td>
                    <Td numeric><Money value={w.otherIn} currency={a.account.currency} /></Td>
                    <Td numeric><Money value={w.otherOut} currency={a.account.currency} /></Td>
                    <Td numeric><Money value={w.balance} currency={a.account.currency} /></Td>
                    <Td numeric className="whitespace-nowrap text-xs text-fg-muted"><Money value={w.low} currency={a.account.currency} /> to <Money value={w.high} currency={a.account.currency} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <CardHeader title="Repeating movements" description="Lines with the same narration and direction, at least 3 of them, weekly, monthly or quarterly, each within 25% of their usual amount. Ones that stopped are shown but not projected." />
            {!a.recurring.length ? (
              <EmptyState title="Nothing repeats yet">No narration shows up regularly enough on this account's statements. The forecast uses the other movements only.</EmptyState>
            ) : (
              <Table aria-label="Repeating bank movements">
                <thead><Tr><Th>Narration</Th><Th>How often</Th><Th numeric>Usual amount</Th><Th numeric>Seen</Th><Th>Last seen</Th><Th>Next in the forecast</Th></Tr></thead>
                <tbody>
                  {a.recurring.map((r) => (
                    <Tr key={`${r.direction}-${r.narration}`}>
                      <Td>{r.narration}<div className="text-xs text-fg-muted">{r.direction === 'IN' ? 'Money in' : 'Money out'}{r.spreadPercent ? `, varies by up to ${r.spreadPercent}%` : ', always the same'}</div></Td>
                      <Td>{CASH_MOVEMENT_FREQUENCY_LABEL[r.frequency]}{r.running ? null : <> <Badge tone="neutral">Stopped</Badge></>}</Td>
                      <Td numeric><Money value={r.amount} currency={a.account.currency} /></Td>
                      <Td numeric>{r.count}</Td>
                      <Td className="whitespace-nowrap">{date(r.lastDate)}</Td>
                      <Td className="text-sm">{r.next.length ? r.next.slice(0, 3).map((n) => `${date(n.date)}${n.late ? ' (due, not seen yet)' : ''}`).join(', ') + (r.next.length > 3 ? ` and ${r.next.length - 3} more` : '') : '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : !q.error && !d ? <p className="text-sm text-fg-muted">Forecasting bank cash…</p> : null}
    </>
  );
}
