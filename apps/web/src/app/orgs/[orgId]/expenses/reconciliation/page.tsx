'use client';
import { useQuery } from '@tanstack/react-query';
import type { ReimbursementBankStatus } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Recon {
  asOf: string;
  currency: string;
  account: { id: string; code: string; name: string } | null;
  ledger: string;
  claims: string;
  difference: string;
  reconciled: boolean;
  items: { kind: 'NOT_FROM_A_CLAIM' | 'CLAIM_DIFFERS'; date: string; reference: string; description: string; amount: string; entryId: string | null; claimId: string | null }[];
  owed: { id: string; number: string; claimant: string; title: string; amount: string; approvedOn: string; days: number; overdue: boolean }[];
  ages: { key: string; label: string; claims: number; amount: string }[];
  employees: { claimantId: string; claimant: string; claims: number; amount: string; oldestDays: number; overdue: string }[];
  overdue: { claims: number; amount: string };
  reimbursements: { claimId: string; number: string; claimant: string; amount: string; date: string; bankAccount: string; status: ReimbursementBankStatus; statusLabel: string; days: number }[];
  bank: { cleared: number; notOnStatement: number; notOnStatementAmount: string; awaiting: number };
}

const BANK_TONE: Record<ReimbursementBankStatus, 'positive' | 'negative' | 'neutral'> = { CLEARED: 'positive', NOT_ON_STATEMENT: 'negative', AWAITING_STATEMENT: 'neutral' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const zero = (x: string) => /^-?0(\.0+)?$/.test(x);

/** Expense reconciliation (EXP-016): the employee reimbursements account, the claims and the bank. */
export default function ExpenseReconciliationPage() {
  const { org, orgId } = useOrg();
  const [input, setInput] = useState('');
  const [asOf, setAsOf] = useState('');
  const q = useQuery({ queryKey: ['expense-reconciliation', orgId, asOf], queryFn: () => api<Recon>(`/v1/orgs/${orgId}/expense-reconciliation${asOf ? `?asOf=${asOf}` : ''}`) });
  if (!org) return null;
  const r = q.data;
  const c = org.functionalCurrency;
  const claimLink = (id: string, number: string) => <Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/${id}`}>{number}</Link>;
  return (
    <>
      <PageHeader
        title="Expense reconciliation"
        description="The employee reimbursements account in the books against the approved claims still owed, each reimbursement against the bank statement, and what is owed to whom and for how long. Nothing is posted here."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/expenses`}>Expense claims</Link>}
      />
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setAsOf(input);
        }}
      >
        <Field label="As of" hint="Leave empty for today">{(p) => <Input {...p} type="date" className="w-44" value={input} onChange={(e) => setInput(e.target.value)} />}</Field>
        <Button type="submit" size="sm" disabled={!!input && !ISO.test(input)} loading={q.isFetching}>Reconcile</Button>
      </form>
      <ErrorAlert title="Could not reconcile expense claims" error={q.error as Error | null} />
      {r ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Owed to employees" value={<Money value={r.claims} currency={c} />} sub={`${r.owed.length} approved ${r.owed.length === 1 ? 'claim' : 'claims'} on ${date(r.asOf)}`} />
            <Stat label="In the books" value={<Money value={r.ledger} currency={c} />} sub={r.account ? `${r.account.code} · ${r.account.name}` : 'No reimbursements account yet'} />
            <Stat label="Difference" value={<Money value={r.difference} currency={c} />} tone={r.reconciled ? 'positive' : 'negative'} sub={r.reconciled ? 'The books agree with the claims' : `${r.items.length} ${r.items.length === 1 ? 'item' : 'items'} to look at`} />
            <Stat label="Owed over 30 days" value={<Money value={r.overdue.amount} currency={c} />} tone={r.overdue.claims ? 'warning' : 'positive'} sub={`${r.overdue.claims} ${r.overdue.claims === 1 ? 'claim' : 'claims'}; ${r.bank.notOnStatement} ${r.bank.notOnStatement === 1 ? 'payment' : 'payments'} not on the statement`} />
          </div>

          <Card className="mb-4">
            <CardHeader title="Books against claims" description="The reimbursements account balance on the date, against the approved claims not yet reimbursed or voided by then." />
            <div className="p-4 text-sm">
              {r.reconciled ? (
                <p><Badge tone="positive">Reconciled</Badge> <span className="text-fg-muted">The account shows <Money value={r.ledger} currency={c} />, exactly what the claims say is owed.</span></p>
              ) : (
                <Table aria-label="Reconciling items">
                  <thead><Tr><Th>Date</Th><Th>Reference</Th><Th>What</Th><Th numeric>Amount</Th></Tr></thead>
                  <tbody>
                    {r.items.map((i) => (
                      <Tr key={`${i.kind}-${i.entryId ?? i.claimId}`}>
                        <Td className="whitespace-nowrap">{date(i.date)}</Td>
                        <Td className="whitespace-nowrap">{i.claimId ? claimLink(i.claimId, i.reference) : i.entryId ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${i.entryId}`}>{i.reference}</Link> : i.reference}</Td>
                        <Td className="text-fg-muted">{i.description}</Td>
                        <Td numeric><Money value={i.amount} currency={c} /></Td>
                      </Tr>
                    ))}
                    <Tr><Td colSpan={3} className="font-medium">Difference (books less claims)</Td><Td numeric className="font-medium"><Money value={r.difference} currency={c} /></Td></Tr>
                  </tbody>
                </Table>
              )}
            </div>
          </Card>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Owed by employee" description="Approved claims not yet paid back, by employee; over 30 days since approval is overdue." />
              {!r.employees.length ? (
                <EmptyState title="Nothing owed">Every approved claim has been paid back.</EmptyState>
              ) : (
                <Table aria-label="Owed by employee">
                  <thead><Tr><Th>Employee</Th><Th numeric>Claims</Th><Th numeric>Owed</Th><Th numeric>Overdue</Th><Th numeric>Oldest</Th></Tr></thead>
                  <tbody>
                    {r.employees.map((e) => (
                      <Tr key={e.claimantId}>
                        <Td>{e.claimant}</Td>
                        <Td numeric>{e.claims}</Td>
                        <Td numeric><Money value={e.amount} currency={c} /></Td>
                        <Td numeric>{zero(e.overdue) ? '—' : <Money value={e.overdue} currency={c} />}</Td>
                        <Td numeric>{e.oldestDays} days</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card>
              <CardHeader title="Owed by age" description="Days since each claim was approved." />
              <Table aria-label="Owed by age">
                <thead><Tr><Th>Age</Th><Th numeric>Claims</Th><Th numeric>Owed</Th></Tr></thead>
                <tbody>
                  {r.ages.map((a) => (
                    <Tr key={a.key}><Td>{a.label}</Td><Td numeric>{a.claims}</Td><Td numeric><Money value={a.amount} currency={c} /></Td></Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>

          {r.owed.length ? (
            <Card className="mb-4">
              <CardHeader title="Claims still owed" description="Oldest first. Pay them back from the claim." />
              <Table aria-label="Claims still owed">
                <thead><Tr><Th>Claim</Th><Th>Employee</Th><Th>Title</Th><Th>Approved</Th><Th numeric>Days</Th><Th numeric>Amount</Th></Tr></thead>
                <tbody>
                  {r.owed.map((o) => (
                    <Tr key={o.id}>
                      <Td className="whitespace-nowrap">{claimLink(o.id, o.number)}</Td>
                      <Td>{o.claimant}</Td>
                      <Td>{o.title}</Td>
                      <Td className="whitespace-nowrap">{date(o.approvedOn)}</Td>
                      <Td numeric>{o.overdue ? <Badge tone="warning">{o.days}</Badge> : o.days}</Td>
                      <Td numeric><Money value={o.amount} currency={c} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Reimbursements and the bank" description="Claims paid back in the 90 days to the date, against the imported bank statements. Match a payment on the statement in Banking." />
            {!r.reimbursements.length ? (
              <EmptyState title="No reimbursements">No claim was paid back in the 90 days to {date(r.asOf)}.</EmptyState>
            ) : (
              <Table aria-label="Reimbursements and the bank">
                <thead><Tr><Th>Claim</Th><Th>Employee</Th><Th>Paid on</Th><Th>Bank</Th><Th numeric>Amount</Th><Th>On the statement</Th></Tr></thead>
                <tbody>
                  {r.reimbursements.map((x) => (
                    <Tr key={x.claimId}>
                      <Td className="whitespace-nowrap">{claimLink(x.claimId, x.number)}</Td>
                      <Td>{x.claimant}</Td>
                      <Td className="whitespace-nowrap">{date(x.date)}<div className="text-xs text-fg-muted">{x.days} days ago</div></Td>
                      <Td>{x.bankAccount}</Td>
                      <Td numeric><Money value={x.amount} currency={c} /></Td>
                      <Td><Badge tone={BANK_TONE[x.status]}>{x.statusLabel}</Badge></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : !q.error ? <p className="text-sm text-fg-muted">Reconciling…</p> : null}
    </>
  );
}
