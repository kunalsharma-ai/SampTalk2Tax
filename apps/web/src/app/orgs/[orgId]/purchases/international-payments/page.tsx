'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { CHARGES, FORM15_LABEL, REMIT_STATUS, type Charges, type ForeignBill, type RemitList, type Remittance } from '@/lib/international-payments';
import { useAccounts, useOrg } from '@/lib/org';

/** Prepare a remittance: a vendor with foreign-currency bills, the bills, the purpose and the charges. */
function NewPayment({ orgId, list }: { orgId: string; list: RemitList }) {
  const router = useRouter();
  const qc = useQueryClient();
  const bills = useQuery({ queryKey: ['foreign-bills', orgId], queryFn: () => api<ForeignBill[]>(`/v1/orgs/${orgId}/purchases/international-payments/payable`) });
  const accounts = useAccounts();
  const banks = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && a.subtype === 'BANK');
  const vendors = useMemo(() => {
    const m = new Map<string, { id: string; name: string; currency: string }>();
    for (const b of bills.data ?? []) if (!b.inPayment) m.set(`${b.vendor.id}:${b.currency}`, { ...b.vendor, currency: b.currency });
    return [...m.entries()];
  }, [bills.data]);
  const [vendorKey, setVendorKey] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({ bankAccountId: '', paymentDate: today(), purposeCode: '', otherCode: '', charges: 'OUR' as Charges, taxableInIndia: true, hasTaxOrder: false, estimateRate: '' });
  const v = vendors.find(([k]) => k === vendorKey)?.[1];
  const theirs = (bills.data ?? []).filter((b) => v && b.vendor.id === v.id && b.currency === v.currency && !b.inPayment);
  const create = useMutation({
    mutationFn: () =>
      api<Remittance>(`/v1/orgs/${orgId}/purchases/international-payments`, {
        method: 'POST',
        body: {
          contactId: v!.id,
          currency: v!.currency,
          bankAccountId: form.bankAccountId || banks[0]?.id,
          paymentDate: form.paymentDate,
          items: [...picked].map((documentId) => ({ documentId })),
          purposeCode: form.purposeCode === 'OTHER' ? form.otherCode : form.purposeCode || null,
          charges: form.charges,
          taxableInIndia: form.taxableInIndia,
          hasTaxOrder: form.hasTaxOrder,
          estimateRate: form.estimateRate || null,
        },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['international-payments', orgId] });
      router.push(`/orgs/${orgId}/purchases/international-payments/${r.id}`);
    },
  });
  return (
    <Card className="mb-6" role="region" aria-label="Prepare an international payment">
      <CardHeader title="Prepare an international payment" description="Choose a vendor with bills in a foreign currency, the bills to pay, and the purpose of the payment. It is approved by a second person before the instruction goes to the bank." />
      <div className="space-y-4 px-5 pb-5">
        {bills.data && !vendors.length ? <p className="text-sm text-fg-muted">No posted bills in a foreign currency are waiting to be paid. Bills already in an open international payment are not listed again.</p> : null}
        {vendors.length ? <>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Vendor and currency">{(p) => <Select {...p} value={vendorKey} onChange={(e) => { setVendorKey(e.target.value); setPicked(new Set()); }}><option value="">Choose…</option>{vendors.map(([k, x]) => <option key={k} value={k}>{x.name} · {x.currency}</option>)}</Select>}</Field>
          <Field label="Pay from">{(p) => <Select {...p} value={form.bankAccountId || banks[0]?.id || ''} onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</Select>}</Field>
          <Field label="Value date">{(p) => <Input {...p} type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} />}</Field>
          <Field label="Expected rate (optional)" hint="Today's rate from Exchange rates is used if left empty.">{(p) => <Input {...p} inputMode="decimal" value={form.estimateRate} onChange={(e) => setForm({ ...form, estimateRate: e.target.value })} />}</Field>
        </div>
        {theirs.length ? (
          <Table>
            <thead><tr><Th>Pay</Th><Th>Bill</Th><Th>Vendor invoice</Th><Th>Due</Th><Th numeric>Left to pay</Th></tr></thead>
            <tbody>
              {theirs.map((b) => (
                <Tr key={b.id}>
                  <Td><input type="checkbox" aria-label={`Pay ${b.number}`} checked={picked.has(b.id)} onChange={(e) => { const s = new Set(picked); if (e.target.checked) s.add(b.id); else s.delete(b.id); setPicked(s); }} /></Td>
                  <Td>{b.number}</Td>
                  <Td>{b.vendorInvoice ?? '—'}</Td>
                  <Td>{b.dueDate ? date(b.dueDate) : '—'}</Td>
                  <Td numeric><Money value={b.due} currency={b.currency} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        {v ? (
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Purpose (RBI purpose code)">{(p) => <Select {...p} value={form.purposeCode} onChange={(e) => setForm({ ...form, purposeCode: e.target.value })}><option value="">Choose…</option>{list.purposeCodes.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.label}</option>)}<option value="OTHER">Another code…</option></Select>}</Field>
            {form.purposeCode === 'OTHER' ? <Field label="Purpose code">{(p) => <Input {...p} maxLength={5} value={form.otherCode} onChange={(e) => setForm({ ...form, otherCode: e.target.value.toUpperCase() })} placeholder="S1099" />}</Field> : null}
            <Field label="Charges">{(p) => <Select {...p} value={form.charges} onChange={(e) => setForm({ ...form, charges: e.target.value as Charges })}>{(Object.keys(CHARGES) as Charges[]).map((c) => <option key={c} value={c}>{CHARGES[c]}</option>)}</Select>}</Field>
            <div className="flex flex-col justify-end gap-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.taxableInIndia} onChange={(e) => setForm({ ...form, taxableInIndia: e.target.checked })} /> Chargeable to tax in India</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={form.hasTaxOrder} onChange={(e) => setForm({ ...form, hasTaxOrder: e.target.checked })} /> Covered by an order or certificate</label>
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Button disabled={!v || !picked.size} loading={create.isPending} onClick={() => create.mutate()}>Prepare payment</Button>
          <ErrorAlert title="Not prepared" error={create.error} />
        </div>
        </> : null}
      </div>
    </Card>
  );
}

/** Purchases → International payments: outward remittances to vendors abroad. */
export default function InternationalPaymentsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['international-payments', orgId], queryFn: () => api<RemitList>(`/v1/orgs/${orgId}/purchases/international-payments`) });
  if (!org) return null;
  const d = q.data;
  return (
    <>
      <PageHeader
        title="International payments"
        description="Payments to vendors abroad in their currency: the bills, the purpose of payment, who pays the charges and, from India, the Form 15CA and 15CB position. Approved by a second person, sent to the bank as a remittance instruction, then recorded at the bank's rate. Talk2Tax never moves money itself."
      />
      <ErrorAlert title="Could not load international payments" error={q.error} />
      {d ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Drafts" value={String(d.counts.DRAFT)} />
          <Stat label="Approved, not sent" value={String(d.counts.APPROVED)} tone="accent" />
          <Stat label="With the bank" value={String(d.counts.SENT)} tone="warning" />
          <Stat label="Paid" value={String(d.counts.PAID)} tone="positive" />
        </div>
      ) : null}
      {d?.can.manage ? <NewPayment orgId={orgId} list={d} /> : null}
      <Card>
        <CardHeader title="Remittances" description="Every international payment, newest first." />
        {d && !d.payments.length ? (
          <EmptyState title="No international payments yet">Prepare one above for a vendor with bills in a foreign currency.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Reference</Th><Th>Vendor</Th><Th>Value date</Th><Th numeric>Amount</Th><Th numeric>{org.functionalCurrency} (est. or paid)</Th><Th>Purpose</Th><Th>Form 15CA</Th><Th>Status</Th></tr></thead>
            <tbody>
              {(d?.payments ?? []).map((p) => (
                <Tr key={p.id}>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/international-payments/${p.id}`}>{p.reference}</Link></Td>
                  <Td>{p.vendor.name}</Td>
                  <Td>{date(p.paymentDate)}</Td>
                  <Td numeric><Money value={p.amount} currency={p.currency} /></Td>
                  <Td numeric>{p.inr ? <Money value={p.inr} currency={org.functionalCurrency} /> : '—'}</Td>
                  <Td>{p.purposeCode ?? '—'}</Td>
                  <Td className="text-sm">{FORM15_LABEL[p.form15Part]}</Td>
                  <Td><Badge tone={REMIT_STATUS[p.status].tone}>{REMIT_STATUS[p.status].label}</Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
