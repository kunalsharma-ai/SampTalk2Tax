'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReimbursementRoute } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Group {
  claimantId: string;
  claimant: string;
  employee: { id: string; name: string } | null;
  claims: { id: string; number: string; total: string; approvedOn: string }[];
  total: string;
  approvedOn: string;
  daysWaiting: number;
  overdue: boolean;
  route: ReimbursementRoute;
  routeLabel: string;
  account: { id: string; code: string; name: string } | null;
  reason: string;
}
interface Plan {
  asOf: string;
  currency: string;
  buffer: string;
  groups: Group[];
  accounts: { id: string; code: string; name: string; kind: 'BANK' | 'CASH'; balance: string; planned: string; left: string }[];
  totals: { claims: number; people: number; total: string; ready: string; waiting: string; overdue: number };
}
interface PayResult {
  paid: { claimantId: string; claimant: string; claims: string[]; total: string; account: { name: string } }[];
  skipped: { claimant: string; reason: string }[];
}

const TONE: Record<ReimbursementRoute, 'accent' | 'positive' | 'warning' | 'negative'> = { BANK_TRANSFER: 'accent', CASH: 'positive', WAIT_FOR_CASH: 'warning', NEEDS_BANK_DETAILS: 'negative' };
const DEC = /^\d{1,15}(\.\d{1,2})?$/;

/** Intelligent reimbursement routing (EXP-026): how and when to pay each person's approved claims. */
export default function ReimbursementRoutingPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [buffer, setBuffer] = useState('0');
  const [asked, setAsked] = useState('0');
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [reference, setReference] = useState('');
  const [result, setResult] = useState<PayResult | null>(null);
  const q = useQuery({ queryKey: ['expense-routing', orgId, asked], queryFn: () => api<Plan>(`/v1/orgs/${orgId}/expense-routing?buffer=${asked}`) });
  const d = q.data;
  const ready = d ? d.groups.filter((g) => g.account) : [];
  const picked = chosen ?? ready.map((g) => g.claimantId);
  const pay = useMutation({
    mutationFn: () => api<PayResult>(`/v1/orgs/${orgId}/expense-routing/pay`, { method: 'POST', body: { claimantIds: picked, buffer: asked, reference: reference.trim() || null } }),
    onSuccess: (r) => {
      setResult(r);
      setChosen(null);
      void qc.invalidateQueries({ queryKey: ['expense-routing', orgId] });
      void qc.invalidateQueries({ queryKey: ['expense-claims'] });
    },
  });
  if (!org) return null;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader title="Reimbursement routing" description="Approved expense claims still to be paid, one payment per person: a bank transfer to the salary account on their employee record, cash when there is none, or wait when no account has room after the amount you keep. Bank account numbers are never shown." />
      <Card className="mb-4">
        <CardHeader title="Money to keep" description="Each account keeps this much back; claims are paid from what is left." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(buffer);
            setChosen(null);
          }}
        >
          <Field label="Keep in each account" hint={c}>{(p) => <Input {...p} inputMode="decimal" className="w-40" value={buffer} onChange={(e) => setBuffer(e.target.value)} />}</Field>
          <Button type="submit" size="sm" disabled={!DEC.test(buffer)} loading={q.isFetching}>Route claims</Button>
        </form>
      </Card>
      <ErrorAlert title="Could not route reimbursements" error={q.error} />
      <ErrorAlert title="Could not pay" error={pay.error} />
      {result ? (
        <div className="mb-4">
          <Alert tone="positive" title={`Paid ${result.paid.length} ${result.paid.length === 1 ? 'person' : 'people'}`}>
            {result.paid.map((p) => `${p.claimant}: ${p.claims.join(', ')} from ${p.account.name}`).join('; ')}
            {result.skipped.length ? `. Not paid: ${result.skipped.map((s) => s.claimant).join(', ')}.` : ''}
          </Alert>
        </div>
      ) : null}
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="To reimburse" value={<Money value={d.totals.total} currency={d.currency} />} sub={`${d.totals.claims} claims, ${d.totals.people} people`} />
            <Stat label="Ready to pay" value={<Money value={d.totals.ready} currency={d.currency} />} tone="positive" />
            <Stat label="Waiting" value={<Money value={d.totals.waiting} currency={d.currency} />} tone={/[1-9]/.test(d.totals.waiting) ? 'warning' : 'neutral'} sub="No room or no bank details" />
            <Stat label="Waiting over 7 days" value={d.totals.overdue} tone={d.totals.overdue ? 'negative' : 'positive'} sub="Since approval" />
          </div>
          <Card className="mb-4">
            <CardHeader title="Payments by person" description="People waiting over 7 days first, then the earliest approval. Tick the ready ones to pay; each claim is reimbursed today through the usual journal." />
            {!d.groups.length ? (
              <EmptyState title="Nothing to reimburse">Every approved claim has been paid. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses`}>Expense claims</Link></EmptyState>
            ) : (
              <>
                <Table aria-label="Payments by person">
                  <thead><Tr><Th>Pay</Th><Th>Person</Th><Th>Claims</Th><Th numeric>Amount</Th><Th>Waiting</Th><Th>Route</Th><Th>From</Th><Th>Why</Th></Tr></thead>
                  <tbody>
                    {d.groups.map((g) => (
                      <Tr key={g.claimantId}>
                        <Td>
                          <input
                            type="checkbox"
                            aria-label={`Pay ${g.claimant}`}
                            disabled={!g.account}
                            checked={!!g.account && picked.includes(g.claimantId)}
                            onChange={(e) => setChosen(e.target.checked ? [...picked, g.claimantId] : picked.filter((x) => x !== g.claimantId))}
                          />
                        </Td>
                        <Td>{g.claimant}{g.employee ? <div className="text-xs text-fg-muted">Employee: {g.employee.name}</div> : null}</Td>
                        <Td className="whitespace-nowrap">{g.claims.map((x) => <div key={x.id}><Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/${x.id}`}>{x.number}</Link></div>)}</Td>
                        <Td numeric><Money value={g.total} currency={d.currency} /></Td>
                        <Td className="whitespace-nowrap">{g.daysWaiting} {g.daysWaiting === 1 ? 'day' : 'days'}{g.overdue ? <div><Badge tone="negative">Over 7 days</Badge></div> : null}<div className="text-xs text-fg-muted">Approved {date(g.approvedOn)}</div></Td>
                        <Td className="whitespace-nowrap"><Badge tone={TONE[g.route]}>{g.routeLabel}</Badge></Td>
                        <Td>{g.account ? `${g.account.code} ${g.account.name}` : '—'}</Td>
                        <Td className="max-w-md text-sm text-fg-muted">{g.reason}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
                <div className="flex flex-wrap items-end gap-3 p-4">
                  <Field label="Reference" hint="Optional, on every reimbursement">{(p) => <Input {...p} className="w-56" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />}</Field>
                  <Button size="sm" disabled={!picked.some((id) => ready.some((g) => g.claimantId === id))} loading={pay.isPending} onClick={() => pay.mutate()}>
                    Pay {picked.filter((id) => ready.some((g) => g.claimantId === id)).length} selected
                  </Button>
                </div>
              </>
            )}
          </Card>
          <Card>
            <CardHeader title="Accounts to pay from" description="Active bank and cash accounts in your currency, with what this plan takes from each." />
            <Table aria-label="Accounts to pay from">
              <thead><Tr><Th>Account</Th><Th>Kind</Th><Th numeric>Balance</Th><Th numeric>This plan</Th><Th numeric>Left</Th></Tr></thead>
              <tbody>
                {d.accounts.map((a) => (
                  <Tr key={a.id}>
                    <Td>{a.code} {a.name}</Td>
                    <Td>{a.kind === 'CASH' ? 'Cash' : 'Bank'}</Td>
                    <Td numeric><Money value={a.balance} currency={d.currency} /></Td>
                    <Td numeric><Money value={a.planned} currency={d.currency} /></Td>
                    <Td numeric><Money value={a.left} currency={d.currency} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : null}
    </>
  );
}
