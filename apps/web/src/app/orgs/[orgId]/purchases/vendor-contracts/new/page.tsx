'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';

type PriceRow = { hsnCode: string; description: string; unitPrice: string };
const empty: PriceRow = { hsnCode: '', description: '', unitPrice: '' };

/** Record a vendor contract (AP-032). */
export default function NewVendorContractPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const vendors = useQuery({ queryKey: ['contacts', orgId, 'vendors'], queryFn: () => api<{ id: string; name: string }[]>(`/v1/orgs/${orgId}/contacts?role=vendor`) });
  const [f, setF] = useState({ contactId: '', title: '', vendorReference: '', startDate: '', endDate: '', paymentTermsDays: '', spendCap: '', itemsOnly: false, note: '' });
  const [prices, setPrices] = useState<PriceRow[]>([{ ...empty }]);
  const save = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/v1/orgs/${orgId}/purchases/vendor-contracts`, {
        method: 'POST',
        body: {
          contactId: f.contactId,
          title: f.title,
          vendorReference: f.vendorReference || null,
          startDate: f.startDate,
          endDate: f.endDate,
          paymentTermsDays: f.paymentTermsDays === '' ? null : Number.parseInt(f.paymentTermsDays, 10),
          spendCap: f.spendCap || null,
          itemsOnly: f.itemsOnly,
          prices: prices.filter((p) => p.unitPrice || p.hsnCode || p.description).map((p) => ({ hsnCode: p.hsnCode || null, description: p.description || null, unitPrice: p.unitPrice })),
          note: f.note || null,
        },
      }),
    onSuccess: (c) => router.push(`/orgs/${orgId}/purchases/vendor-contracts/${c.id}`),
  });
  if (!org) return null;
  const set = (i: number, k: keyof PriceRow, value: string) => setPrices(prices.map((p, n) => (n === i ? { ...p, [k]: value } : p)));
  return (
    <>
      <PageHeader title="Record a vendor contract" description="The terms agreed with a vendor. Posted bills from them are checked against the contract covering each bill's date. A contract cannot be edited once recorded: terminate it and record a new one." />
      <ErrorAlert title="Could not record the contract" error={save.error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Card className="mb-4">
          <CardHeader title="Contract terms" description={`Amounts in ${org.functionalCurrency}, before tax.`} />
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Vendor">
              {(p) => (
                <Select {...p} value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
                  <option value="">Choose a vendor</option>
                  {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Title">{(p) => <Input {...p} value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field>
            <Field label="Vendor's reference" hint="Optional">{(p) => <Input {...p} value={f.vendorReference} maxLength={100} onChange={(e) => setF({ ...f, vendorReference: e.target.value })} />}</Field>
            <Field label="Starts">{(p) => <Input {...p} type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />}</Field>
            <Field label="Ends">{(p) => <Input {...p} type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />}</Field>
            <Field label="Payment terms" hint="Days after the bill date; optional">{(p) => <Input {...p} inputMode="numeric" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value.replace(/\D/g, '') })} />}</Field>
            <Field label="Spend cap" hint="Optional">{(p) => <Input {...p} inputMode="decimal" value={f.spendCap} onChange={(e) => setF({ ...f, spendCap: e.target.value })} />}</Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.itemsOnly} onChange={(e) => setF({ ...f, itemsOnly: e.target.checked })} /> Contract items only</label>
          </div>
        </Card>
        <Card className="mb-4">
          <CardHeader title="Price list" description="Price per unit by HSN/SAC code, or by description when there is no code. Bill lines match by the same code or description." />
          <div className="space-y-3 p-4">
            {prices.map((p, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-[8rem_1fr_10rem_auto]">
                <Field label={`HSN/SAC ${i + 1}`}>{(x) => <Input {...x} value={p.hsnCode} maxLength={10} onChange={(e) => set(i, 'hsnCode', e.target.value)} />}</Field>
                <Field label={`Item ${i + 1}`}>{(x) => <Input {...x} value={p.description} maxLength={200} onChange={(e) => set(i, 'description', e.target.value)} />}</Field>
                <Field label={`Unit price ${i + 1}`}>{(x) => <Input {...x} inputMode="decimal" value={p.unitPrice} onChange={(e) => set(i, 'unitPrice', e.target.value)} />}</Field>
                <Button type="button" variant="secondary" size="sm" className="self-end" disabled={prices.length === 1} onClick={() => setPrices(prices.filter((_, n) => n !== i))}>Remove</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" size="sm" onClick={() => setPrices([...prices, { ...empty }])}>Add an item</Button>
          </div>
        </Card>
        <Card className="mb-4">
          <CardHeader title="Contract note" description="Anything else agreed, for the record." />
          <div className="p-4"><Field label="Note">{(p) => <Textarea {...p} rows={3} maxLength={1000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field></div>
        </Card>
        <Button type="submit" loading={save.isPending} disabled={!f.contactId || !f.title.trim() || !f.startDate || !f.endDate}>Record contract</Button>
      </form>
    </>
  );
}
