'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';
import type { Batch, PayableBill } from '@/lib/payment-batches';

/** Prepare a new payment batch, or change a draft one: the bank account, the date and the bills. */
export function BatchForm({ batchId }: { batchId?: string }) {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const base = `/v1/orgs/${orgId}/purchases/payment-batches`;
  const existing = useQuery({ queryKey: ['payment-batch', orgId, batchId], queryFn: () => api<Batch>(`${base}/${batchId}`), enabled: !!batchId });
  const bills = useQuery({ queryKey: ['payable-bills', orgId], queryFn: () => api<PayableBill[]>(`${base}/payable-bills`) });
  const [bankId, setBankId] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const banks = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && a.subtype === 'BANK');
  useEffect(() => {
    if (!bankId && banks.length && !batchId) setBankId(banks[0]!.id);
  }, [banks, bankId, batchId]);
  useEffect(() => {
    const b = existing.data;
    if (!b) return;
    setBankId(b.bankAccount?.id ?? '');
    setPaymentDate(b.paymentDate);
    setMemo(b.memo ?? '');
    setPicked(Object.fromEntries(b.items.map((i) => [i.documentId, i.amount])));
  }, [existing.data]);
  const save = useMutation({
    mutationFn: () => {
      const body = { bankAccountId: bankId, paymentDate, memo: memo || null, items: Object.entries(picked).map(([documentId, amount]) => ({ documentId, amount: amount || null })) };
      return batchId ? api<Batch>(`${base}/${batchId}`, { method: 'PATCH', body }) : api<Batch>(base, { method: 'POST', body });
    },
    onSuccess: async (b) => {
      await qc.invalidateQueries({ queryKey: ['payment-batches', orgId] });
      await qc.invalidateQueries({ queryKey: ['payment-batch', orgId, b.id] });
      router.push(`/orgs/${orgId}/purchases/payment-batches/${b.id}`);
    },
  });
  if (!org) return null;
  const c = org.functionalCurrency;
  const own = existing.data?.reference ?? null;
  const rows = (bills.data ?? []).filter((b) => !b.inBatch || b.inBatch === own);
  const total = Object.values(picked).reduce((s, v) => s + (Number(v) || 0), 0);
  const toggle = (b: PayableBill) => setPicked((p) => {
    const next = { ...p };
    if (b.id in next) delete next[b.id];
    else next[b.id] = b.due;
    return next;
  });
  return (
    <>
      <PageHeader title={batchId ? `Change ${own ?? 'batch'}` : 'New payment batch'} description="Pick the bank account, the date the bank should pay, and the bills. Each bill can be paid in full or in part. Vendors without verified bank details are flagged; the batch cannot be approved until they are verified." />
      <Card className="mt-4">
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <Field label="Pay from">{(p) => (
            <Select {...p} value={bankId} onChange={(e) => setBankId(e.target.value)}>
              <option value="">Choose…</option>
              {banks.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </Select>
          )}</Field>
          <Field label="Payment date">{(p) => <Input {...p} type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />}</Field>
          <Field label="Note (optional)">{(p) => <Input {...p} maxLength={400} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Friday supplier run" />}</Field>
        </div>
      </Card>
      <Card className="mt-6">
        <CardHeader title="Bills to pay" description={`Posted bills in ${c} with something left to pay, earliest due first. Bills already in another open batch are left out.`} />
        <ErrorAlert title="Could not load the bills" error={bills.error} />
        {bills.data && rows.length === 0 ? (
          <EmptyState title="Nothing to pay">Every posted bill is paid or already in a batch.</EmptyState>
        ) : (
          <Table aria-label="Bills to pay">
            <thead><tr><Th><span className="sr-only">Pay</span></Th><Th>Bill</Th><Th>Vendor</Th><Th>Due</Th><Th numeric>Left to pay</Th><Th numeric>Pay now</Th><Th>Bank details</Th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <Tr key={b.id}>
                  <Td><input type="checkbox" aria-label={`Pay ${b.number}`} checked={b.id in picked} onChange={() => toggle(b)} /></Td>
                  <Td>{b.number}</Td>
                  <Td>{b.vendor.name}</Td>
                  <Td>{b.dueDate ? date(b.dueDate) : ''}</Td>
                  <Td numeric><Money value={b.due} currency={b.currency} /></Td>
                  <Td numeric>
                    {b.id in picked ? (
                      <Input aria-label={`Amount for ${b.number}`} inputMode="decimal" className="w-32 text-right" value={picked[b.id]} onChange={(e) => /^\d{0,18}(\.\d{0,2})?$/.test(e.target.value) && setPicked({ ...picked, [b.id]: e.target.value })} />
                    ) : null}
                  </Td>
                  <Td>{!b.bank ? <Badge tone="negative">None</Badge> : b.bank.verified ? <Badge tone="positive">Verified {b.bank.accountNumberMasked.slice(-4)}</Badge> : <Badge tone="warning">Not verified</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
          <p className="text-sm text-fg-muted">{Object.keys(picked).length} bills · <Money value={total.toFixed(2)} currency={c} /></p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
            <Button loading={save.isPending} disabled={!bankId || !paymentDate || Object.keys(picked).length === 0} onClick={() => save.mutate()}>{batchId ? 'Save changes' : 'Save batch'}</Button>
          </div>
        </div>
        <div className="px-5 pb-4"><ErrorAlert title="The batch was not saved" error={save.error} /></div>
      </Card>
    </>
  );
}
