'use client';
import { useQuery } from '@tanstack/react-query';
import type { PaymentAction } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
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
  vendorId: string;
  vendor: string;
  dueDate: string;
  due: string;
  inBatch: string | null;
  score: number;
  action: PaymentAction;
  actionLabel: string;
  daysToDue: number;
  factors: { key: string; label: string; points: number; max: number; detail: string }[];
  offer: { daysEarly: number; percent: string; discount: string; pay: string } | null;
}
interface Priorities {
  asOf: string;
  currency: string;
  rate: string;
  summary: { cash: string; buffer: string; inBatches: string; available: string; payNow: string; onDue: string; short: string; blocked: string; leftOver: string; offers: number; offerSavings: string; offerPay: string };
  bills: PBill[];
}

const TONE: Record<PaymentAction, 'negative' | 'warning' | 'accent' | 'neutral' | 'positive'> = { PAY_NOW: 'accent', PAY_ON_DUE: 'positive', CASH_SHORT: 'negative', BLOCKED: 'warning', IN_BATCH: 'neutral' };
const DEC = /^\d{1,18}(\.\d{1,10})?$/;

/** Intelligent payment prioritisation (AP-030) and early-payment discount offers (AP-029). */
export default function PaymentPrioritiesPage() {
  const { org, orgId } = useOrg();
  const [form, setForm] = useState({ buffer: '0', rate: '12' });
  const [asked, setAsked] = useState({ buffer: '0', rate: '12' });
  const q = useQuery({ queryKey: ['payment-priorities', orgId, asked], queryFn: () => api<Priorities>(`/v1/orgs/${orgId}/payment-priorities?buffer=${asked.buffer}&rate=${asked.rate}`) });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  const offers = d ? d.bills.filter((b) => b.offer) : [];
  return (
    <>
      <PageHeader
        title="Payment priorities"
        description="Which bills to pay now with the cash in the bank, which can wait for their due date, which the cash will not cover, and which vendors to offer early payment for a discount. Nothing is paid or planned here."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/payment-batches/new`}>Prepare a payment batch</Link>}
      />
      <Card className="mb-4">
        <CardHeader title="Cash to work with" description="Bank balances less the buffer you want to keep, less bills already in open payment batches." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(form);
          }}
        >
          <Field label="Keep in the bank" hint={c}>{(p) => <Input {...p} inputMode="decimal" className="w-40" value={form.buffer} onChange={(e) => setForm({ ...form, buffer: e.target.value })} />}</Field>
          <Field label="Target return for discounts" hint="% a year">{(p) => <Input {...p} inputMode="decimal" className="w-32" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />}</Field>
          <Button type="submit" size="sm" disabled={!DEC.test(form.buffer) || !DEC.test(form.rate)} loading={q.isFetching}>Work it out</Button>
        </form>
        <div className="px-4 pb-4"><ErrorAlert title="Could not work out payment priorities" error={q.error} /></div>
      </Card>
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Cash to work with" value={<Money value={d.summary.available} currency={c} />} sub={<>of <Money value={d.summary.cash} currency={c} /> in the bank</>} />
            <Stat label="Pay now" value={<Money value={d.summary.payNow} currency={c} />} tone="accent" sub="Past due or due within 7 days" />
            <Stat label="Cash will not cover" value={<Money value={d.summary.short} currency={c} />} tone={/^0(\.0+)?$/.test(d.summary.short) ? 'positive' : 'negative'} />
            <Stat label="Discounts to ask for" value={<Money value={d.summary.offerSavings} currency={c} />} tone="positive" sub={`${d.summary.offers} ${d.summary.offers === 1 ? 'offer' : 'offers'} at ${d.rate}% a year`} />
          </div>
          <Card className="mb-4">
            <CardHeader title="Bills in payment order" description="Pay now first, highest score first; open a score to see its points." />
            {!d.bills.length ? (
              <EmptyState title="No open bills">There are no posted bills left to pay in {c}.</EmptyState>
            ) : (
              <Table aria-label="Bills in payment order">
                <thead><Tr><Th>Bill</Th><Th>Vendor</Th><Th>Due</Th><Th numeric>Left to pay</Th><Th>Suggested</Th><Th>Score</Th></Tr></thead>
                <tbody>
                  {d.bills.map((b) => (
                    <Tr key={b.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${b.id}`}>{b.number}</Link></Td>
                      <Td><Link className="hover:underline" href={`/orgs/${orgId}/purchases/vendors/${b.vendorId}`}>{b.vendor}</Link></Td>
                      <Td className="whitespace-nowrap">{date(b.dueDate)}<div className={`text-xs ${b.daysToDue < 0 ? 'text-danger' : 'text-fg-muted'}`}>{b.factors[0]!.detail}</div></Td>
                      <Td numeric><Money value={b.due} currency={c} /></Td>
                      <Td><Badge tone={TONE[b.action]}>{b.actionLabel}</Badge>{b.inBatch ? <div className="text-xs text-fg-muted">{b.inBatch}</div> : null}</Td>
                      <Td>
                        <details>
                          <summary className="cursor-pointer font-mono">{b.score} / 100</summary>
                          <ul className="mt-1 space-y-0.5 text-xs">{b.factors.map((f) => <li key={f.key}><span className="font-mono">{f.points}/{f.max}</span> {f.label}: {f.detail}</li>)}</ul>
                        </details>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Early-payment discounts to ask for" description={`Offered only when the cash covers every bill. Each discount is worth ${d.rate}% a year over the days paid early.`} />
            {offers.length ? (
              <Table aria-label="Early-payment discounts to ask for">
                <thead><Tr><Th>Bill</Th><Th>Vendor</Th><Th numeric>Days early</Th><Th numeric>Discount</Th><Th numeric>Pay now</Th></Tr></thead>
                <tbody>
                  {offers.map((b) => (
                    <Tr key={b.id}>
                      <Td>{b.number}</Td>
                      <Td>{b.vendor}</Td>
                      <Td numeric>{b.offer!.daysEarly}</Td>
                      <Td numeric><Money value={b.offer!.discount} currency={c} /> <span className="text-xs text-fg-muted">({b.offer!.percent}%)</span></Td>
                      <Td numeric><Money value={b.offer!.pay} currency={c} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No offers">{/^0(\.0+)?$/.test(d.summary.short) ? 'No bill is due 10 or more days from now.' : 'The cash does not cover every bill, so paying any early is not suggested.'}</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
