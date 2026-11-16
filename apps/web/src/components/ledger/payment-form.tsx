'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D, dec } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import type { LedgerConfig } from '@/lib/ledgers';
import { useAccounts, useContacts, useOrg } from '@/lib/org';
import type { DocumentSummary, Payment } from '@/lib/types';

const AMT = /^\d{0,18}(\.\d{0,2})?$/;
const parse = (s: string) => (s && /^\d+(\.\d+)?$/.test(s) ? dec(s) : new D(0));

function Form({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const contacts = useContacts(l.contactRole);
  const accounts = useAccounts();
  const idem = useRef(newIdempotencyKey(`web-${l.payment.kind.toLowerCase()}`));
  const [contactId, setContactId] = useState(params.get('contactId') ?? '');
  const [pdate, setDate] = useState(today());
  const [bankId, setBankId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const preselect = params.get('documentId');

  const banks = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && (a.subtype === 'BANK' || a.subtype === 'CASH'));
  useEffect(() => {
    if (!bankId && banks.length) setBankId((banks.find((b) => b.subtype === 'BANK') ?? banks[0]).id);
  }, [banks, bankId]);

  const open = useQuery({
    enabled: !!contactId,
    queryKey: ['documents', orgId, l.api, 'open-for', contactId],
    queryFn: () => api<{ items: DocumentSummary[] }>(`/v1/orgs/${orgId}/${l.api}/documents?view=open&kind=${l.charge.kind}&contactId=${contactId}&limit=200`),
  });
  const openItems = useMemo(() => [...(open.data?.items ?? [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate)), [open.data]);
  useEffect(() => {
    if (preselect && openItems.length && Object.keys(alloc).length === 0) {
      const doc = openItems.find((x) => x.id === preselect);
      if (doc) {
        setAlloc({ [doc.id]: doc.amountDue });
        setAmount(doc.amountDue);
      }
    }
  }, [preselect, openItems, alloc]);

  const allocated = Object.values(alloc).reduce((s, v) => s.plus(parse(v)), new D(0));
  const total = parse(amount);
  const unallocated = total.minus(allocated);
  const issues: string[] = [];
  if (!contactId) issues.push(`Choose a ${l.contact.toLowerCase()}`);
  if (!bankId) issues.push('Choose the bank or cash account');
  if (total.lte(0)) issues.push('Enter the amount');
  if (unallocated.isNegative()) issues.push(`Allocated ${allocated.toFixed(2)} is more than the ${l.payment.label.toLowerCase()} amount`);
  for (const d of openItems) if (parse(alloc[d.id] ?? '').gt(d.amountDue)) issues.push(`${d.number}: more than the ${d.amountDue} still due`);

  // Fill oldest due first, up to the amount.
  const autoAllocate = () => {
    let left = total;
    const next: Record<string, string> = {};
    for (const d of openItems) {
      if (left.lte(0)) break;
      const take = D.min(left, d.amountDue);
      next[d.id] = take.toFixed(2);
      left = left.minus(take);
    }
    setAlloc(next);
  };

  const save = useMutation({
    mutationFn: () =>
      api<Payment>(`/v1/orgs/${orgId}/${l.api}/payments`, {
        method: 'POST',
        idempotencyKey: idem.current,
        body: {
          contactId,
          date: pdate,
          bankAccountId: bankId,
          amount: total.toFixed(2),
          reference: reference || null,
          memo: memo || null,
          allocations: Object.entries(alloc).filter(([, v]) => parse(v).gt(0)).map(([documentId, v]) => ({ documentId, amount: parse(v).toFixed(2) })),
        },
      }),
    onSuccess: async (p) => {
      for (const k of ['payments', 'documents', 'document', 'contacts', 'contact', 'dashboard', 'ageing']) await qc.invalidateQueries({ queryKey: [k, orgId] });
      router.push(`/orgs/${orgId}/${l.paymentsPath}/${p.id}`);
    },
  });

  if (!org) return null;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader title={l.payment.verb} description={`Posts ${l.ledger === 'SALES' ? 'Dr bank / Cr receivables' : 'Dr payables / Cr bank'} and settles the ${l.charge.plural.toLowerCase()} you choose. Anything not allocated stays as a credit for this ${l.contact.toLowerCase()}.`} />
      <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Card className="grid gap-4 p-5 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            {l.contact}
            <Select value={contactId} onChange={(e) => { setContactId(e.target.value); setAlloc({}); }}>
              <option value="">Choose…</option>
              {(contacts.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Date
            <Input type="date" value={pdate} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            {l.ledger === 'SALES' ? 'Deposited to' : 'Paid from'}
            <Select value={bankId} onChange={(e) => setBankId(e.target.value)}>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Amount ({c})
            <Input className="num" inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => AMT.test(e.target.value) && setAmount(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Bank reference
            <Input value={reference} maxLength={100} placeholder="UTR, cheque number…" onChange={(e) => setReference(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Memo
            <Input value={memo} maxLength={1000} onChange={(e) => setMemo(e.target.value)} />
          </label>
        </Card>

        <Card>
          <CardHeader
            title={`Open ${l.charge.plural.toLowerCase()}`}
            description="Oldest due first."
            actions={openItems.length ? <Button type="button" variant="secondary" size="sm" disabled={total.lte(0)} onClick={autoAllocate}>Allocate oldest first</Button> : null}
          />
          {!contactId ? (
            <p className="px-5 py-4 text-sm text-fg-muted">Choose a {l.contact.toLowerCase()} to see what they {l.ledger === 'SALES' ? 'owe' : 'are owed'}.</p>
          ) : openItems.length === 0 ? (
            <p className="px-5 py-4 text-sm text-fg-muted">No open {l.charge.plural.toLowerCase()}. The full amount will be kept as a credit.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Number</Th>
                  <Th>Date</Th>
                  <Th>Due</Th>
                  <Th numeric>Total</Th>
                  <Th numeric>Still due</Th>
                  <Th numeric className="w-40">Allocate</Th>
                </tr>
              </thead>
              <tbody>
                {openItems.map((d) => (
                  <Tr key={d.id}>
                    <Td className="num">{d.number}{d.reference ? <p className="text-xs text-fg-muted">{d.reference}</p> : null}</Td>
                    <Td>{date(d.issueDate)}</Td>
                    <Td className={d.isOverdue ? 'text-negative' : ''}>{date(d.dueDate)}</Td>
                    <Td numeric><Money value={d.total} currency={c} /></Td>
                    <Td numeric><Money value={d.amountDue} currency={c} /></Td>
                    <Td numeric>
                      <Input aria-label={`Allocate to ${d.number}`} className="num text-right" inputMode="decimal" placeholder="0.00" value={alloc[d.id] ?? ''} onChange={(e) => AMT.test(e.target.value) && setAlloc({ ...alloc, [d.id]: e.target.value })} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="flex flex-wrap justify-end gap-6 border-t border-line px-5 py-3 text-sm">
            <span className="text-fg-muted">Allocated <span className="num text-fg">{money(allocated.toFixed(2), c)}</span></span>
            <span className="text-fg-muted">Kept as credit <span className={unallocated.isNegative() ? 'num text-negative' : 'num text-fg'}>{money(unallocated.toFixed(2), c)}</span></span>
          </div>
          {issues.length && (amount || contactId) ? (
            <ul className="list-inside list-disc border-t border-line px-5 py-3 text-sm text-warning" aria-live="polite">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
          ) : null}
        </Card>

        {save.error ? <Alert title="The server rejected this payment">{save.error instanceof ApiError ? save.error.message : 'Try again.'}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={issues.length > 0}>Record {l.payment.label.toLowerCase()}</Button>
        </div>
      </form>
    </>
  );
}

export function PaymentForm({ l }: { l: LedgerConfig }) {
  return (
    <Suspense>
      <Form l={l} />
    </Suspense>
  );
}
