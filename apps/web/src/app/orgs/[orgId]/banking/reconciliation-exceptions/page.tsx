'use client';
import { useQuery } from '@tanstack/react-query';
import type { ReconExceptionKind } from '@talk2tax/accounting-engine';
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
  id: string;
  date: string;
  amount: string;
  text: string;
  entryId?: string | null;
}
interface Exception {
  kind: ReconExceptionKind;
  label: string;
  action: string;
  statement: Item[];
  book: Item[];
  amount: string;
  difference: string | null;
  age: number;
  detail: string;
}
interface Bucket {
  label: string;
  count: number;
  amount: string;
}
interface AccountExceptions {
  account: { id: string; code: string; name: string; currency: string };
  lastStatementDate: string | null;
  lastReconciled: string | null;
  since: string | null;
  unmatched: { statement: number; book: number };
  summary: { kind: ReconExceptionKind; label: string; count: number; amount: string }[];
  ageing: { statement: Bucket[]; book: Bucket[] };
  exceptions: Exception[];
}
interface Result {
  asOf: string;
  summary: { accounts: number; accountsWithExceptions: number; exceptions: number; needsAction: number; byKind: Record<ReconExceptionKind, number> };
  accounts: AccountExceptions[];
}

const TONE: Record<ReconExceptionKind, 'negative' | 'warning' | 'neutral' | 'positive'> = {
  AMOUNT_DIFFERS: 'warning',
  SPLIT: 'neutral',
  REVERSED: 'neutral',
  BANK_CHARGES: 'warning',
  NOT_IN_BOOKS: 'negative',
  STALE: 'negative',
  IN_TRANSIT: 'positive',
  OUTSTANDING: 'warning',
};

function Items({ title, items, currency, orgId }: { title: string; items: Item[]; currency: string; orgId: string }) {
  if (!items.length) return null;
  return (
    <div className="text-xs">
      <div className="font-medium text-fg-muted">{title}</div>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            {date(i.date)} · <Money value={i.amount} currency={currency} /> · {i.entryId ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${i.entryId}`}>{i.text}</Link> : i.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Reconciliation exceptions (BANK-020): why statement lines and entries are still unmatched. */
export default function ReconciliationExceptionsPage() {
  const { org, orgId } = useOrg();
  const [accountId, setAccountId] = useState('');
  const all = useQuery({ queryKey: ['reconciliation-exceptions', orgId], queryFn: () => api<Result>(`/v1/orgs/${orgId}/banking/reconciliation-exceptions`) });
  if (!org) return null;
  const d = all.data;
  const shown = d ? d.accounts.filter((a) => !accountId || a.account.id === accountId) : [];
  // The kind and age cards are for one account: the one picked, or the only one with exceptions.
  const busy = shown.filter((a) => a.exceptions.length);
  const one = shown.length === 1 ? shown[0]! : busy.length === 1 ? busy[0]! : null;
  return (
    <>
      <PageHeader
        title="Reconciliation exceptions"
        description="Why statement lines and entries in the books are still unmatched on each bank account, and what to do about each: amounts that differ a little, splits, reversals, bank charges, money not in the books, entries in transit, outstanding or old. Nothing here changes the books."
        actions={
          d && d.accounts.length > 1 ? (
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              Bank account
              <Select aria-label="Bank account" className="w-56" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">All accounts</option>
                {d.accounts.map((a) => <option key={a.account.id} value={a.account.id}>{a.account.name}</option>)}
              </Select>
            </label>
          ) : null
        }
      />
      <ErrorAlert title="Could not analyse reconciliation" error={all.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Exceptions" value={shown.reduce((s, a) => s + a.exceptions.length, 0)} sub={`On ${shown.filter((a) => a.exceptions.length).length} of ${shown.length} account${shown.length === 1 ? '' : 's'}`} />
            <Stat label="Need action" value={shown.reduce((s, a) => s + a.exceptions.filter((e) => e.kind !== 'IN_TRANSIT').length, 0)} tone={shown.some((a) => a.exceptions.some((e) => e.kind !== 'IN_TRANSIT')) ? 'warning' : 'positive'} sub="Everything but in transit" />
            <Stat label="Unmatched statement lines" value={shown.reduce((s, a) => s + a.unmatched.statement, 0)} sub="Excluded lines are left out" />
            <Stat label="Unmatched entries" value={shown.reduce((s, a) => s + a.unmatched.book, 0)} sub="In the books, on no statement" />
          </div>
          {one ? (
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Exceptions by kind" description={`${one.account.name}. Latest statement line ${one.lastStatementDate ? date(one.lastStatementDate) : 'none yet'}; last reconciled ${one.lastReconciled ? date(one.lastReconciled) : 'never'}.`} />
                <Table aria-label="Exception kinds">
                  <thead><Tr><Th>Kind</Th><Th numeric>Count</Th><Th numeric>Amount</Th></Tr></thead>
                  <tbody>
                    {one.summary.filter((s) => s.count).map((s) => (
                      <Tr key={s.kind}><Td><Badge tone={TONE[s.kind]}>{s.label}</Badge></Td><Td numeric>{s.count}</Td><Td numeric><Money value={s.amount} currency={one.account.currency} /></Td></Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <Card>
                <CardHeader title="Unmatched by age" description="How long unmatched statement lines and entries have been waiting." />
                <Table aria-label="Unmatched items by age">
                  <thead><Tr><Th>Age</Th><Th numeric>Statement lines</Th><Th numeric>Entries</Th></Tr></thead>
                  <tbody>
                    {one.ageing.statement.map((b, k) => (
                      <Tr key={b.label}>
                        <Td>{b.label}</Td>
                        <Td numeric>{b.count} · <Money value={b.amount} currency={one.account.currency} /></Td>
                        <Td numeric>{one.ageing.book[k]!.count} · <Money value={one.ageing.book[k]!.amount} currency={one.account.currency} /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          ) : null}
          <Card>
            <CardHeader title="Exceptions to clear" description="Grouped by kind, oldest first within each. Open the account's reconcile page to match, exclude or create entries." />
            {!shown.some((a) => a.exceptions.length) ? (
              <EmptyState title="Nothing to clear">Every imported statement line and every entry on the bank accounts is matched. Import the latest statements to keep this up to date.</EmptyState>
            ) : (
              <Table aria-label="Reconciliation exceptions">
                <thead><Tr><Th>Kind</Th><Th>Account</Th><Th>What was found</Th><Th numeric>Amount</Th><Th numeric>Age</Th><Th>What to do</Th></Tr></thead>
                <tbody>
                  {shown.flatMap((a) =>
                    a.exceptions.map((e) => (
                      <Tr key={`${a.account.id}-${e.kind}-${[...e.statement, ...e.book].map((x) => x.id).join('-')}`}>
                        <Td><Badge tone={TONE[e.kind]}>{e.label}</Badge></Td>
                        <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/banking/${a.account.id}/reconcile`}>{a.account.name}</Link></Td>
                        <Td>
                          <div className="mb-1">{e.detail}</div>
                          <Items title="On the statement" items={e.statement} currency={a.account.currency} orgId={orgId} />
                          <Items title="In the books" items={e.book} currency={a.account.currency} orgId={orgId} />
                        </Td>
                        <Td numeric><Money value={e.amount} currency={a.account.currency} />{e.difference ? <div className="text-xs text-fg-muted">Difference <Money value={e.difference} currency={a.account.currency} /></div> : null}</Td>
                        <Td numeric>{e.age} d</Td>
                        <Td className="text-sm">{e.action}</Td>
                      </Tr>
                    )),
                  )}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : !all.error ? <p className="text-sm text-fg-muted">Analysing reconciliation…</p> : null}
    </>
  );
}
