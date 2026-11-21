'use client';
import { addAmounts } from '@talk2tax/accounting-engine';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, SectionHelpSlot, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Head = 'igst' | 'cgst' | 'sgst';
type Heads = Record<Head, string>;
interface Use { from: Head; against: Head; amount: string; label: string }
interface Preview {
  period: string;
  from: string;
  to: string;
  currency: string;
  liability: Heads;
  credit: Heads;
  uses: Use[];
  creditUsed: Heads;
  paidByCredit: Heads;
  cash: Heads;
  reverseCharge: Heads;
  creditLeft: Heads;
  totalCash: string;
  nothingToPay: boolean;
  blocked: string | null;
}
interface AccountRef { id: string; code: string; name: string }
interface Payment {
  id: string;
  number: string;
  period: string;
  paymentDate: string;
  uses: Use[];
  cash: Heads;
  totalCash: string;
  interest: string;
  lateFee: string;
  totalPaid: string;
  bankAccount: AccountRef | null;
  cpin: string | null;
  cin: string | null;
  memo: string | null;
  journalEntryId: string;
  status: 'POSTED' | 'VOID';
  voidReason: string | null;
  createdBy: string | null;
  canVoid: boolean;
}

const HEADS: Head[] = ['igst', 'cgst', 'sgst'];
const LABEL: Record<Head, string> = { igst: 'IGST', cgst: 'CGST', sgst: 'SGST' };
const lastMonth = () => {
  const d = new Date(`${today().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const monthLabel = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** GST payments (TAX-022): a month's tax and credit from the books, set off in the Act's order, and the PMT-06 cash recorded. */
export default function GstPaymentsPage() {
  const { org, orgId } = useOrg();
  const [period, setPeriod] = useState(lastMonth);
  const [recording, setRecording] = useState(false);
  const p = useQuery({ queryKey: ['gst-payment-preview', orgId, period], queryFn: () => api<Preview>(`/v1/orgs/${orgId}/gst/payments/preview?period=${period}`), enabled: /^\d{4}-\d{2}$/.test(period) });
  const list = useQuery({ queryKey: ['gst-payments', orgId], queryFn: () => api<Payment[]>(`/v1/orgs/${orgId}/gst/payments`) });
  if (!org) return null;
  const d = p.data;
  const c = d?.currency ?? 'INR';
  const post = can(org.role, 'journals.post');
  const sum = (h: Heads) => addAmounts(HEADS.map((k) => h[k]));
  return (
    <>
      <PageHeader
        title="GST payments"
        description="Settle a month's GST: the tax payable and input tax credit in your books, credit set off in the order the CGST Act requires, and the rest paid in cash by PMT-06 challan. Recording it posts the set-off and the payment."
        actions={<Field label="Month">{(f) => <Input {...f} type="month" value={period} max={today().slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} />}</Field>}
      />
      <ErrorAlert title="Could not work out the month" error={p.error as Error | null} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Tax payable" value={<Money value={sum(d.liability).toFixed(2)} currency={c} />} sub={`Output tax at the end of ${monthLabel(d.period)}`} />
            <Stat label="Credit available" value={<Money value={sum(d.credit).toFixed(2)} currency={c} />} sub="Input tax credit in the books" />
            <Stat label="Cash to pay" value={<Money value={d.totalCash} currency={c} />} sub={d.nothingToPay ? 'Nothing to pay for this month' : 'By PMT-06 challan'} tone={Number(d.totalCash) > 0 ? 'warning' : undefined} />
            <Stat label="Credit carried forward" value={<Money value={sum(d.creditLeft).toFixed(2)} currency={c} />} sub="Left after set-off" tone="violet" />
          </div>
          <Card className="mb-4">
            <CardHeader
              title="GST to settle"
              help={<SectionHelpSlot title="GST to settle" />}
              description="IGST credit is used first, against IGST and then CGST and SGST; CGST credit then pays CGST and IGST, SGST credit SGST and IGST. Reverse-charge tax is paid in cash only."
              actions={post && !d.nothingToPay && !d.blocked ? <Button size="sm" onClick={() => setRecording(true)}>Record payment</Button> : null}
            />
            {d.blocked ? <div className="px-5 pt-4"><Alert tone="warning" title="Months are settled in order">{d.blocked}</Alert></div> : null}
            <Table aria-label="GST to settle">
              <thead><tr><Th>Head</Th><Th numeric>Payable</Th><Th numeric>Paid by credit</Th><Th numeric>Of which reverse charge</Th><Th numeric>Cash</Th><Th numeric>Credit available</Th><Th numeric>Credit left</Th></tr></thead>
              <tbody>
                {HEADS.map((h) => (
                  <Tr key={h}>
                    <Td>{LABEL[h]}</Td>
                    <Td numeric><Money value={d.liability[h]} currency={c} /></Td>
                    <Td numeric><Money value={d.paidByCredit[h]} currency={c} /></Td>
                    <Td numeric><Money value={d.reverseCharge[h]} currency={c} /></Td>
                    <Td numeric className="font-medium"><Money value={d.cash[h]} currency={c} /></Td>
                    <Td numeric><Money value={d.credit[h]} currency={c} /></Td>
                    <Td numeric><Money value={d.creditLeft[h]} currency={c} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <div className="px-5 py-3 text-sm text-fg-muted">
              {d.uses.length ? <>Set-off: {d.uses.map((u, i) => <span key={i}>{i ? '; ' : ''}{u.label} <Money value={u.amount} currency={c} /></span>)}.</> : 'No credit to set off.'}
            </div>
          </Card>
          {recording ? <RecordDialog orgId={orgId} preview={d} onClose={() => setRecording(false)} /> : null}
        </>
      ) : null}
      <Payments orgId={orgId} rows={list.data ?? []} c={c} canVoid={post} />
    </>
  );
}

function RecordDialog({ orgId, preview: d, onClose }: { orgId: string; preview: Preview; onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [f, setF] = useState({ paymentDate: today(), bankAccountId: '', cpin: '', cin: '', interest: '', lateFee: '', chargesAccountId: '', memo: '' });
  const cash = Number(d.totalCash) > 0 || !!f.interest || !!f.lateFee;
  const charges = !!f.interest || !!f.lateFee;
  const save = useMutation({
    mutationFn: () =>
      api<Payment>(`/v1/orgs/${orgId}/gst/payments`, {
        method: 'POST',
        body: { period: d.period, paymentDate: f.paymentDate, bankAccountId: cash ? f.bankAccountId || null : null, cpin: f.cpin || null, cin: f.cin || null, interest: f.interest || '0', lateFee: f.lateFee || '0', chargesAccountId: charges ? f.chargesAccountId || null : null, memo: f.memo || null },
      }),
    onSuccess: async () => {
      for (const k of ['gst-payments', 'gst-payment-preview', 'compliance']) await qc.invalidateQueries({ queryKey: [k, orgId] });
      onClose();
    },
  });
  const banks = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && (a.subtype === 'BANK' || a.subtype === 'CASH'));
  const expenses = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && a.type === 'EXPENSE');
  const amount = (k: 'interest' | 'lateFee') => (e: React.ChangeEvent<HTMLInputElement>) => /^\d{0,12}(\.\d{0,2})?$/.test(e.target.value) && setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Record GST payment for ${monthLabel(d.period)}`} description={Number(d.totalCash) > 0 ? `Cash of ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(d.totalCash))} by PMT-06, and the credit set off as shown. Enter the challan as the GST portal and the bank issued it.` : 'Credit covers all of it: no challan is needed.'}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Paid on" hint="After the month ends.">{(p) => <Input {...p} type="date" value={f.paymentDate} onChange={(e) => setF({ ...f, paymentDate: e.target.value })} />}</Field>
        {cash ? (
          <>
            <Field label="Paid from">{(p) => <Select {...p} value={f.bankAccountId} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}><option value="">Choose a bank account…</option>{banks.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field>
            <Field label="CPIN (optional)" hint="The 14-character challan number from the GST portal.">{(p) => <Input {...p} value={f.cpin} maxLength={14} onChange={(e) => setF({ ...f, cpin: e.target.value })} />}</Field>
            <Field label="CIN" hint="The challan identification number the bank gave.">{(p) => <Input {...p} value={f.cin} maxLength={30} onChange={(e) => setF({ ...f, cin: e.target.value })} />}</Field>
          </>
        ) : null}
        <Field label="Interest (optional)">{(p) => <Input {...p} className="num" inputMode="decimal" placeholder="0.00" value={f.interest} onChange={amount('interest')} />}</Field>
        <Field label="Late fee (optional)">{(p) => <Input {...p} className="num" inputMode="decimal" placeholder="0.00" value={f.lateFee} onChange={amount('lateFee')} />}</Field>
        {charges ? <Field label="Interest and late fee account">{(p) => <Select {...p} value={f.chargesAccountId} onChange={(e) => setF({ ...f, chargesAccountId: e.target.value })}><option value="">Choose an expense account…</option>{expenses.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select>}</Field> : null}
        <div className="sm:col-span-2"><Field label="Note (optional)">{(p) => <Input {...p} value={f.memo} maxLength={500} onChange={(e) => setF({ ...f, memo: e.target.value })} />}</Field></div>
        {save.error ? <div className="sm:col-span-2"><Alert title="Not recorded">{save.error.message}{save.error instanceof ApiError && save.error.issues.length ? <ul className="mt-1 list-inside list-disc">{save.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert></div> : null}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Record and post</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Payments({ orgId, rows, c, canVoid }: { orgId: string; rows: Payment[]; c: string; canVoid: boolean }) {
  const qc = useQueryClient();
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [reason, setReason] = useState('');
  const v = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/gst/payments/${voiding!.id}/void`, { method: 'POST', body: { date: today(), reason } }),
    onSuccess: async () => {
      for (const k of ['gst-payments', 'gst-payment-preview', 'compliance']) await qc.invalidateQueries({ queryKey: [k, orgId] });
      setVoiding(null);
    },
  });
  return (
    <Card>
      <CardHeader title="GST payments recorded" help={<SectionHelpSlot title="GST payments recorded" />} description={<>Newest month first. Each shows on its month's GSTR-3B in the <Link className="text-accent underline" href={`/orgs/${orgId}/tax/compliance`}>Compliance calendar</Link>. Only the latest can be voided.</>} />
      <div className="overflow-x-auto">
        <Table className="min-w-[900px]" aria-label="GST payments recorded">
          <thead><tr><Th>Payment</Th><Th>Month</Th><Th>Paid on</Th><Th>Challan</Th><Th numeric>Cash</Th><Th numeric>Interest and fee</Th><Th>Credit used</Th><Th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'VOID' ? 'opacity-60' : ''}>
                <Td className="whitespace-nowrap"><Link className="num text-accent hover:underline" href={`/orgs/${orgId}/journals/${r.journalEntryId}`}>{r.number}</Link>{r.status === 'VOID' ? <Badge className="ml-1">Void</Badge> : null}</Td>
                <Td className="whitespace-nowrap">{monthLabel(r.period)}</Td>
                <Td className="whitespace-nowrap">{date(r.paymentDate)}</Td>
                <Td className="num text-sm">{r.cin ? `${r.cin}${r.cpin ? ` · ${r.cpin}` : ''}` : 'By credit only'}</Td>
                <Td numeric><Money value={r.totalCash} currency={c} /></Td>
                <Td numeric><Money value={addAmounts([r.interest, r.lateFee]).toFixed(2)} currency={c} /></Td>
                <Td className="text-xs text-fg-muted">{r.uses.length ? r.uses.map((u) => `${u.label} ${new Intl.NumberFormat('en-IN').format(Number(u.amount))}`).join('; ') : 'None'}{r.voidReason ? <p>Void: {r.voidReason}</p> : null}</Td>
                <Td className="text-right">{canVoid && r.canVoid ? <Button size="sm" variant="ghost" onClick={() => { v.reset(); setReason(''); setVoiding(r); }}>Void</Button> : null}</Td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><Td colSpan={8} className="py-6 text-center text-fg-muted">No GST payments recorded yet.</Td></tr> : null}
          </tbody>
        </Table>
      </div>
      <Dialog open={!!voiding} onOpenChange={(o) => !o && setVoiding(null)} title={`Void ${voiding?.number}`} description="Posts a reversal dated today, which puts the month's tax and credit back.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); v.mutate(); }}>
          <Field label="Reason">{(p) => <Input {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
          {v.error ? <Alert title="Not voided">{v.error.message}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setVoiding(null)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={v.isPending} disabled={reason.trim().length < 3}>Void payment</Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
