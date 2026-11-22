'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PredictedPaymentStatus } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface PBill {
  id: string;
  number: string;
  vendor: string;
  dueDate: string;
  due: string;
  score: number;
  inBatch: string | null;
  status: PredictedPaymentStatus;
  statusLabel: string;
  payOn: string | null;
  daysLate: number;
  reason: string;
  plannedOn: string | null;
}
interface Predicted {
  asOf: string;
  days: number;
  currency: string;
  summary: {
    cash: string;
    buffer: string;
    receipts: string;
    receiptsPredicted: number;
    onTime: { count: number; amount: string };
    delayed: { count: number; amount: string; averageDaysLate: number };
    notCovered: { count: number; amount: string };
    inBatches: string;
    endBalance: string;
    lowest: { balance: string; date: string };
    applicable: number;
  };
  weeks: { from: string; to: string; receipts: string; payments: string; closing: string }[];
  bills: PBill[];
  can: { apply: boolean };
}

const TONE: Record<PredictedPaymentStatus, 'negative' | 'warning' | 'accent' | 'neutral' | 'positive'> = { OVERDUE_NOW: 'accent', ON_DUE: 'positive', DELAYED: 'warning', NOT_COVERED: 'negative', IN_BATCH: 'neutral', BLOCKED: 'warning', AFTER_PERIOD: 'neutral' };
const DEC = /^\d{1,18}(\.\d{1,10})?$/;

/** Predictive payment scheduling (AP-034): a payment date for each open bill from expected cash. */
export default function PredictedPaymentDatesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [buffer, setBuffer] = useState('0');
  const [asked, setAsked] = useState({ buffer: '0', days: '60' });
  const key = ['predicted-payments', orgId, asked];
  const path = `/v1/orgs/${orgId}/purchases/payment-schedule/predicted`;
  const qs = `?days=${asked.days}&buffer=${asked.buffer}`;
  const q = useQuery({ queryKey: key, queryFn: () => api<Predicted>(`${path}${qs}`) });
  const apply = useMutation({
    mutationFn: (documentIds?: string[]) => api<{ planned: number; result: Predicted }>(`${path}/apply${qs}`, { method: 'POST', body: documentIds ? { documentIds } : {} }),
    onSuccess: (r) => qc.setQueryData(key, r.result),
  });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Predicted payment dates"
        description="A payment date for each open bill, from the cash in the bank and when customers are expected to pay their open invoices, keeping the balance you choose in the bank every day. Plan the dates to add them to the payment schedule; nothing is paid here."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/payment-schedule`}>Payment schedule</Link>}
      />
      <Card className="mb-4">
        <CardHeader title="Cash to keep" description="The balance to keep in the bank on every day, and how far ahead to plan." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked({ ...asked, buffer });
          }}
        >
          <Field label="Keep in the bank" hint={c}>{(p) => <Input {...p} inputMode="decimal" className="w-40" value={buffer} onChange={(e) => setBuffer(e.target.value)} />}</Field>
          <label className="flex flex-col gap-1 text-sm text-fg-muted">
            Plan ahead
            <Select aria-label="Plan ahead" className="w-40" value={asked.days} onChange={(e) => setAsked({ ...asked, days: e.target.value })}>
              {[['30', 'Next 30 days'], ['60', 'Next 60 days'], ['90', 'Next 90 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </label>
          <Button type="submit" size="sm" disabled={!DEC.test(buffer)} loading={q.isFetching}>Work it out</Button>
        </form>
        <div className="px-4 pb-4">
          <ErrorAlert title="Could not work out payment dates" error={q.error} />
          <ErrorAlert title="Could not plan the dates" error={apply.error} />
        </div>
      </Card>
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Paid on time" value={<Money value={d.summary.onTime.amount} currency={c} />} tone="positive" sub={`${d.summary.onTime.count} ${d.summary.onTime.count === 1 ? 'bill' : 'bills'}, overdue ones today`} />
            <Stat label="Paid late" value={<Money value={d.summary.delayed.amount} currency={c} />} tone={d.summary.delayed.count ? 'warning' : 'positive'} sub={d.summary.delayed.count ? `${d.summary.delayed.count} ${d.summary.delayed.count === 1 ? 'bill' : 'bills'}, ${d.summary.delayed.averageDaysLate} days late on average` : 'None'} />
            <Stat label="Not covered" value={<Money value={d.summary.notCovered.amount} currency={c} />} tone={d.summary.notCovered.count ? 'negative' : 'positive'} sub={`In the next ${d.days} days`} />
            <Stat label="Lowest balance" value={<Money value={d.summary.lowest.balance} currency={c} />} sub={`On ${date(d.summary.lowest.date)}; ${d.summary.receiptsPredicted} customer ${d.summary.receiptsPredicted === 1 ? 'receipt' : 'receipts'} expected`} />
          </div>
          <Card className="mb-4">
            <CardHeader
              title="Suggested payment dates"
              description="Overdue bills first, then by date. A bill waits past its due date only when paying it then would take the bank below the balance to keep on some later day."
              actions={d.can.apply && d.summary.applicable ? <Button size="sm" loading={apply.isPending && !apply.variables} onClick={() => apply.mutate(undefined)}>Plan these dates ({d.summary.applicable})</Button> : null}
            />
            {!d.bills.length ? (
              <EmptyState title="No open bills">There are no posted bills left to pay in {c}.</EmptyState>
            ) : (
              <Table aria-label="Suggested payment dates">
                <thead><Tr><Th>Bill</Th><Th>Vendor</Th><Th>Due</Th><Th numeric>Left to pay</Th><Th>Suggested</Th><Th>Pay on</Th><Th>Why</Th><Th>Planned</Th></Tr></thead>
                <tbody>
                  {d.bills.map((b) => (
                    <Tr key={b.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${b.id}`}>{b.number}</Link></Td>
                      <Td>{b.vendor}</Td>
                      <Td className="whitespace-nowrap">{date(b.dueDate)}</Td>
                      <Td numeric><Money value={b.due} currency={c} /></Td>
                      <Td><Badge tone={TONE[b.status]}>{b.statusLabel}</Badge></Td>
                      <Td className="whitespace-nowrap">{b.payOn ? date(b.payOn) : '—'}{b.daysLate && b.status === 'DELAYED' ? <div className="text-xs text-fg-muted">{b.daysLate} days late</div> : null}</Td>
                      <Td className="text-xs text-fg-muted">{b.reason}</Td>
                      <Td className="whitespace-nowrap">
                        {b.plannedOn ? date(b.plannedOn) : null}
                        {d.can.apply && b.payOn && b.plannedOn !== b.payOn ? (
                          <Button size="sm" variant="secondary" aria-label={`Plan ${b.number}`} loading={apply.isPending && apply.variables?.[0] === b.id} onClick={() => apply.mutate([b.id])}>Plan</Button>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Cash and payments by week" description="Customer receipts expected, suggested payments (and bills already in batches, in the first week) and the balance at the end of each week." />
            <Table aria-label="Cash and payments by week">
              <thead><Tr><Th>Week</Th><Th numeric>Receipts expected</Th><Th numeric>Payments</Th><Th numeric>Balance</Th></Tr></thead>
              <tbody>
                {d.weeks.map((w) => (
                  <Tr key={w.from}>
                    <Td className="whitespace-nowrap">{date(w.from)} to {date(w.to)}</Td>
                    <Td numeric><Money value={w.receipts} currency={c} /></Td>
                    <Td numeric><Money value={w.payments} currency={c} /></Td>
                    <Td numeric><Money value={w.closing} currency={c} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : !q.error ? <p className="text-sm text-fg-muted">Working out payment dates…</p> : null}
    </>
  );
}
