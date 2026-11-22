'use client';
import { useQuery } from '@tanstack/react-query';
import type { BankActivityLevel } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Item {
  lineId: string;
  account: { id: string; code: string; name: string; currency: string };
  date: string;
  amount: string;
  description: string;
  reference: string | null;
  matched: boolean;
  level: BankActivityLevel;
  indicators: { code: string; level: BankActivityLevel; label: string; detail: string }[];
}
interface Activity {
  asOf: string;
  days: number;
  threshold: string;
  summary: { lines: number; high: number; medium: number; low: number; accounts: number };
  items: Item[];
}

const TONE: Record<BankActivityLevel, 'negative' | 'warning' | 'neutral'> = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' };
const LEVEL: Record<BankActivityLevel, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

/** Unusual bank activity (BANK-019, BANK-023): statement lines with warning signs. */
export default function UnusualBankActivityPage() {
  const { org, orgId } = useOrg();
  const [days, setDays] = useState('30');
  const q = useQuery({ queryKey: ['unusual-activity', orgId, days], queryFn: () => api<Activity>(`/v1/orgs/${orgId}/banking/unusual-activity?days=${days}`) });
  if (!org) return null;
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Unusual bank activity"
        description="Lines on your imported bank statements with warning signs: possible duplicates, deposits or payments split just under a threshold, money straight in and out, unusually large movements, large payments to new payees, money out that is not in the books, and large round amounts. Nothing here changes the books."
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              Period
              <Select aria-label="Period" className="w-44" value={days} onChange={(e) => setDays(e.target.value)}>
                {[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </label>
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/alerts`}>Alerts</Link>
          </>
        }
      />
      <ErrorAlert title="Could not check bank activity" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Lines with warning signs" value={d.summary.lines} sub={`On ${d.summary.accounts} account${d.summary.accounts === 1 ? '' : 's'}`} />
            <Stat label="High" value={d.summary.high} tone={d.summary.high ? 'negative' : 'positive'} sub="Duplicates, splitting, in and out" />
            <Stat label="Medium" value={d.summary.medium} tone={d.summary.medium ? 'warning' : 'positive'} sub="Large, new payee, not in the books" />
            <Stat label="Low" value={d.summary.low} sub="Large round amounts" />
          </div>
          <Card>
            <CardHeader title="Statement lines with warning signs" description="Most serious first, then newest. Each line is compared with the year before on the same account; excluded lines are left out." />
            {!d.items.length ? (
              <EmptyState title="Nothing unusual">No statement line in this period has a warning sign. Import recent statements to keep this check useful.</EmptyState>
            ) : (
              <Table aria-label="Unusual bank activity">
                <thead><Tr><Th>Level</Th><Th>Date</Th><Th>Account</Th><Th>Narration</Th><Th numeric>Amount</Th><Th>Warning signs</Th></Tr></thead>
                <tbody>
                  {d.items.map((i) => (
                    <Tr key={i.lineId}>
                      <Td><Badge tone={TONE[i.level]}>{LEVEL[i.level]}</Badge></Td>
                      <Td className="whitespace-nowrap">{date(i.date)}</Td>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/banking/${i.account.id}/reconcile`}>{i.account.name}</Link></Td>
                      <Td>{i.description}{i.reference ? <div className="text-xs text-fg-muted">Ref {i.reference}</div> : null}<div className="text-xs text-fg-muted">{i.matched ? 'Matched in the books' : 'Not matched yet'}</div></Td>
                      <Td numeric><Money value={i.amount} currency={i.account.currency} /></Td>
                      <Td>
                        <ul className="space-y-1">
                          {i.indicators.map((x) => <li key={x.code}><Badge tone={TONE[x.level]}>{x.label}</Badge> <span className="text-xs text-fg-muted">{x.detail}</span></li>)}
                        </ul>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : !q.error ? <p className="text-sm text-fg-muted">Checking bank activity…</p> : null}
    </>
  );
}
