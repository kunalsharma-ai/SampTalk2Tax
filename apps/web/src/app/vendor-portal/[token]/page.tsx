'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VENDOR_SUBMISSION_LABEL, type VendorSubmissionStatus } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Money } from '@/components/money';
import { date, dateTime } from '@/lib/format';

/**
 * The vendor portal (AP-013): what a vendor sees when they open the private link a business sent
 * them. No sign-in: the secret in the link is the check. They see their bills and when they fall
 * due, payments made to them, open purchase orders and their statement, and can send an invoice.
 */
type BillState = 'TO_BE_PAID' | 'DUE' | 'PART_PAID' | 'PAID' | 'VOID' | 'UNUSED_CREDIT' | 'USED';
interface Portal {
  from: { name: string; tradeName: string; gstin: string | null };
  vendor: { name: string; gstin: string | null };
  link: { expiresAt: string | null };
  today: string;
  currency: string;
  balances: { currency: string; owed: string; due: string; credits: string; balance: string }[];
  bills: { id: string; kind: 'BILL' | 'VENDOR_CREDIT'; number: string | null; yourReference: string | null; issueDate: string; dueDate: string | null; currency: string; total: string; tdsDeducted: string | null; open: string; state: BillState }[];
  payments: { id: string; number: string; date: string; amount: string; currency: string; status: string; reference: string | null }[];
  orders: { id: string; reference: string; orderDate: string; expectedDate: string | null; currency: string; total: string; toBill: string; state: string; yourReference: string | null }[];
  sent: { id: string; invoiceNumber: string; invoiceDate: string; currency: string; amount: string; purchaseOrder: string | null; file: string | null; canAddFile: boolean; status: VendorSubmissionStatus; bill: string | null; rejectReason: string | null; sentAt: string }[];
}
interface Statement {
  currency: string;
  currencies: string[];
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  lines: { date: string; kind: string; number: string; description: string; charge: string | null; credit: string | null; balance: string }[];
}
const STATE: Record<BillState, { label: string; tone: 'neutral' | 'positive' | 'warning' | 'negative' | 'accent' }> = {
  TO_BE_PAID: { label: 'To be paid', tone: 'accent' },
  DUE: { label: 'Due', tone: 'warning' },
  PART_PAID: { label: 'Part paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'positive' },
  VOID: { label: 'Cancelled', tone: 'neutral' },
  UNUSED_CREDIT: { label: 'Credit to use', tone: 'accent' },
  USED: { label: 'Credit used', tone: 'neutral' },
};
const SENT_TONE = { RECEIVED: 'accent', RECORDED: 'positive', REJECTED: 'negative' } as const;
const ORDER_STATE: Record<string, string> = { ISSUED: 'Open', PARTLY_RECEIVED: 'Part received', RECEIVED: 'Received', PARTLY_BILLED: 'Part billed', BILLED: 'Billed', CLOSED: 'Closed' };

class PortalError extends Error {}
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new PortalError(body?.message ?? 'This page could not be loaded. Try again in a minute.');
  return body as T;
}

export default function VendorPortalPage() {
  const { token } = useParams<{ token: string }>();
  const base = `/api/vendor-portal/${encodeURIComponent(token)}`;
  const q = useQuery({ queryKey: ['vendor-portal', token], queryFn: () => call<Portal>(base), retry: false });
  const [show, setShow] = useState<'open' | 'all'>('open');
  if (q.error) {
    return (
      <Shell>
        <div className="mx-auto mt-16 max-w-md rounded-[var(--t2t-radius-lg)] border border-line bg-surface p-8 text-center">
          <h1 className="text-lg font-semibold">This link cannot be opened</h1>
          <p className="mt-3 text-sm text-fg-muted">{q.error.message}</p>
        </div>
      </Shell>
    );
  }
  const p = q.data;
  if (!p) return <Shell><p className="mt-16 text-center text-sm text-fg-muted">Loading…</p></Shell>;
  const rows = show === 'open' ? p.bills.filter((b) => ['TO_BE_PAID', 'DUE', 'PART_PAID', 'UNUSED_CREDIT'].includes(b.state)) : p.bills;
  return (
    <Shell>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-sm text-fg-muted">Supplier account with</p>
          <h1 className="text-2xl font-semibold">{p.from.name}</h1>
          {p.from.gstin ? <p className="mt-1 text-sm text-fg-muted">GSTIN <span className="num">{p.from.gstin}</span></p> : null}
        </div>
        <div className="sm:text-right">
          <p className="text-sm text-fg-muted">For</p>
          <p className="text-lg font-medium">{p.vendor.name}</p>
          {p.vendor.gstin ? <p className="text-sm text-fg-muted">GSTIN <span className="num">{p.vendor.gstin}</span></p> : null}
        </div>
      </header>

      <section aria-label="What you are owed" className="mt-6 grid gap-4 sm:grid-cols-3">
        {(p.balances.length ? p.balances : [{ currency: p.currency, owed: '0.00', due: '0.00', credits: '0.00', balance: '0.00' }]).map((b) => (
          <BalanceCards key={b.currency} b={b} multi={p.balances.length > 1} />
        ))}
      </section>

      <Card className="mt-6" role="region" aria-label="Your bills">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Your invoices as recorded</h2>
            <p className="text-sm text-fg-muted">Each of your invoices {p.from.tradeName} has recorded, with when it falls due and what is still to be paid. Tax deducted at source is taken off the total.</p>
          </div>
          <div className="w-40">
            <Select aria-label="Which invoices" value={show} onChange={(e) => setShow(e.target.value as 'open' | 'all')}>
              <option value="open">Still to be paid</option>
              <option value="all">All</option>
            </Select>
          </div>
        </div>
        {rows.length ? (
          <Table aria-label="Bills">
            <thead><Tr><Th>Your invoice</Th><Th>Date</Th><Th>Due</Th><Th numeric>Amount</Th><Th numeric>Still to be paid</Th><Th>Status</Th></Tr></thead>
            <tbody>
              {rows.map((b) => (
                <Tr key={b.id}>
                  <Td>{b.yourReference ?? '—'}<span className="block text-xs text-fg-muted">{b.kind === 'VENDOR_CREDIT' ? 'Credit' : 'Bill'}{b.number ? ` ${b.number}` : ''}</span></Td>
                  <Td>{date(b.issueDate)}</Td>
                  <Td>{b.dueDate ? date(b.dueDate) : '—'}</Td>
                  <Td numeric><Money value={b.total} currency={b.currency} />{b.tdsDeducted ? <span className="block text-xs text-fg-muted">after TDS <Money value={b.tdsDeducted} currency={b.currency} /></span> : null}</Td>
                  <Td numeric>{b.kind === 'BILL' ? <Money value={b.open} currency={b.currency} /> : <span className="text-fg-muted">−<Money value={b.open} currency={b.currency} /></span>}</Td>
                  <Td><Badge tone={STATE[b.state].tone}>{STATE[b.state].label}</Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 py-5 text-sm text-fg-muted">{show === 'open' ? 'Nothing waiting to be paid.' : 'No invoices recorded yet.'}</p>}
      </Card>

      <SendInvoiceCard base={base} portal={p} />

      <Card className="mt-6" role="region" aria-label="Payments made to you">
        <div className="px-5 pt-5">
          <h2 className="text-base font-semibold">Payments made to you</h2>
          <p className="text-sm text-fg-muted">Payments {p.from.tradeName} has recorded to you, with the bank reference.</p>
        </div>
        {p.payments.length ? (
          <Table aria-label="Payments">
            <thead><Tr><Th>Date</Th><Th>Payment</Th><Th>Bank reference</Th><Th numeric>Amount</Th></Tr></thead>
            <tbody>
              {p.payments.map((r) => (
                <Tr key={r.id}>
                  <Td>{date(r.date)}</Td>
                  <Td className="num">{r.number}{r.status === 'VOID' ? <> <Badge tone="neutral">Cancelled</Badge></> : null}</Td>
                  <Td>{r.reference ?? '—'}</Td>
                  <Td numeric><Money value={r.amount} currency={r.currency} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 py-5 text-sm text-fg-muted">No payments recorded yet.</p>}
      </Card>

      <Card className="mt-6" role="region" aria-label="Purchase orders">
        <div className="px-5 pt-5">
          <h2 className="text-base font-semibold">Purchase orders</h2>
          <p className="text-sm text-fg-muted">Orders {p.from.tradeName} has placed with you. Quote the order number on your invoice.</p>
        </div>
        {p.orders.length ? (
          <Table aria-label="Orders">
            <thead><Tr><Th>Order</Th><Th>Date</Th><Th>Expected</Th><Th numeric>Total</Th><Th numeric>Still to invoice</Th><Th>Status</Th></Tr></thead>
            <tbody>
              {p.orders.map((o) => (
                <Tr key={o.id}>
                  <Td className="num">{o.reference}{o.yourReference ? <span className="block text-xs text-fg-muted">Your quote {o.yourReference}</span> : null}</Td>
                  <Td>{date(o.orderDate)}</Td>
                  <Td>{o.expectedDate ? date(o.expectedDate) : '—'}</Td>
                  <Td numeric><Money value={o.total} currency={o.currency} /></Td>
                  <Td numeric><Money value={o.toBill} currency={o.currency} /></Td>
                  <Td><Badge tone="neutral">{ORDER_STATE[o.state] ?? o.state}</Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 py-5 text-sm text-fg-muted">No purchase orders.</p>}
      </Card>

      <StatementCard base={base} today={p.today} />

      <footer className="mt-10 border-t border-line pt-4 text-xs text-fg-faint">
        <p>This page is private to {p.vendor.name}. Anyone with the link can see it, so do not forward it.{p.link.expiresAt ? ` The link works until ${date(p.link.expiresAt.slice(0, 10))}.` : ''} To change your bank details, contact {p.from.tradeName} directly; they cannot be changed here.</p>
        <p className="mt-1">Vendor portal by Talk2Tax.</p>
      </footer>
    </Shell>
  );
}

function BalanceCards({ b, multi }: { b: Portal['balances'][number]; multi: boolean }) {
  const label = (s: string) => (multi ? `${s} (${b.currency})` : s);
  return (
    <>
      <Card className="p-4"><p className="text-sm text-fg-muted">{label('Owed to you')}</p><p className="mt-1 text-2xl font-semibold"><Money value={b.balance} currency={b.currency} /></p>{b.credits !== '0.00' ? <p className="text-xs text-fg-muted">after <Money value={b.credits} currency={b.currency} /> of credits and payments not yet matched</p> : null}</Card>
      <Card className="p-4"><p className="text-sm text-fg-muted">{label('Due now')}</p><p className="mt-1 text-2xl font-semibold"><Money value={b.due} currency={b.currency} /></p><p className="text-xs text-fg-muted">due on or before today</p></Card>
      <Card className="p-4"><p className="text-sm text-fg-muted">{label('Open invoices')}</p><p className="mt-1 text-2xl font-semibold"><Money value={b.owed} currency={b.currency} /></p></Card>
    </>
  );
}

function SendInvoiceCard({ base, portal }: { base: string; portal: Portal }) {
  const qc = useQueryClient();
  const blank = { invoiceNumber: '', invoiceDate: portal.today, amount: '', currency: portal.currency, purchaseOrderId: '', note: '' };
  const [f, setF] = useState(blank);
  const [file, setFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: async () => {
      const s = await call<{ id: string }>(`${base}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, purchaseOrderId: f.purchaseOrderId || null, note: f.note || null }) });
      if (file) {
        try {
          await call(`${base}/invoices/${s.id}/file?fileName=${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
        } catch (e) {
          throw new PortalError(`Invoice ${f.invoiceNumber} was sent, but its file was not: ${(e as Error).message}`);
        }
      }
      return s;
    },
    onSuccess: () => {
      setDone(`Invoice ${f.invoiceNumber} was sent. ${portal.from.tradeName} will check it and record it.`);
      setF(blank);
      setFile(null);
      setFormKey((k) => k + 1);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['vendor-portal'] }),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const orders = portal.orders.filter((o) => o.state !== 'CLOSED');
  return (
    <Card className="mt-6" role="region" aria-label="Send an invoice">
      <div className="px-5 pt-5">
        <h2 className="text-base font-semibold">Send an invoice</h2>
        <p className="text-sm text-fg-muted">Send your invoice with its PDF or a photo. {portal.from.tradeName} checks it and records it; until then it shows below as received. Nothing is paid from here.</p>
      </div>
      <form key={formKey} className="grid gap-4 px-5 py-5 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); setDone(null); send.mutate(); }}>
        {send.error ? <div className="sm:col-span-3"><Alert title="Could not send">{send.error.message}</Alert></div> : null}
        {done ? <div className="sm:col-span-3"><Alert tone="positive" title="Sent">{done}</Alert></div> : null}
        <Field label="Your invoice number">{(p) => <Input {...p} required maxLength={40} value={f.invoiceNumber} onChange={set('invoiceNumber')} />}</Field>
        <Field label="Invoice date">{(p) => <Input {...p} type="date" required max={portal.today} value={f.invoiceDate} onChange={set('invoiceDate')} />}</Field>
        <Field label="Total, with tax" hint={f.currency}>{(p) => <Input {...p} required inputMode="decimal" value={f.amount} onChange={set('amount')} />}</Field>
        {orders.length ? (
          <Field label="Purchase order">{(p) => <Select {...p} value={f.purchaseOrderId} onChange={set('purchaseOrderId')}><option value="">None</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.reference}</option>)}</Select>}</Field>
        ) : null}
        <Field label="Invoice file" hint="PDF, PNG, JPEG or WebP, at most 5 MB">{(p) => <Input {...p} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />}</Field>
        <div className={orders.length ? '' : 'sm:col-span-2'}><Field label="Note">{(p) => <Textarea {...p} rows={1} maxLength={500} value={f.note} onChange={set('note')} />}</Field></div>
        <div className="flex justify-end sm:col-span-3"><Button type="submit" loading={send.isPending}>Send invoice</Button></div>
      </form>
      {portal.sent.length ? (
        <Table aria-label="Invoices you sent">
          <thead><Tr><Th>Invoice</Th><Th>Sent</Th><Th numeric>Amount</Th><Th>Status</Th></Tr></thead>
          <tbody>
            {portal.sent.map((s) => (
              <Tr key={s.id}>
                <Td>{s.invoiceNumber}<span className="block text-xs text-fg-muted">dated {date(s.invoiceDate)}{s.purchaseOrder ? ` · ${s.purchaseOrder}` : ''}{s.file ? ` · ${s.file}` : ' · no file'}</span></Td>
                <Td className="text-sm">{dateTime(s.sentAt)}</Td>
                <Td numeric><Money value={s.amount} currency={s.currency} /></Td>
                <Td><Badge tone={SENT_TONE[s.status]}>{VENDOR_SUBMISSION_LABEL[s.status]}</Badge>{s.bill && s.status === 'RECORDED' ? <span className="block text-xs text-fg-muted">as bill {s.bill}</span> : null}{s.rejectReason ? <span className="block max-w-xs text-xs text-fg-muted">{s.rejectReason}</span> : null}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}

function StatementCard({ base, today }: { base: string; today: string }) {
  const [from, setFrom] = useState(`${Number(today.slice(0, 4)) - 1}${today.slice(4, 8)}01`);
  const [to, setTo] = useState(today);
  const [currency, setCurrency] = useState('');
  const q = useQuery({ queryKey: ['vendor-portal-statement', base, from, to, currency], queryFn: () => call<Statement>(`${base}/statement?from=${from}&to=${to}${currency ? `&currency=${currency}` : ''}`), enabled: !!from && !!to, retry: false });
  const s = q.data;
  return (
    <Card className="mt-6" role="region" aria-label="Statement">
      <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Statement</h2>
          <p className="text-sm text-fg-muted">Every invoice, credit and payment in the period, with the running balance owed to you.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44"><Input aria-label="Statement from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
          <span className="text-sm text-fg-muted">to</span>
          <div className="w-44"><Input aria-label="Statement to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
          {s && s.currencies.length > 1 ? (
            <Select aria-label="Currency" value={currency || s.currency} onChange={(e) => setCurrency(e.target.value)}>{s.currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          ) : null}
          <button type="button" className="text-sm text-accent hover:underline" onClick={() => window.print()}>Print</button>
        </div>
      </div>
      {q.error ? <p className="px-5 py-4 text-sm text-negative">{q.error.message}</p> : null}
      {s ? (
        <Table aria-label="Statement lines">
          <thead><Tr><Th>Date</Th><Th>Number</Th><Th>Details</Th><Th numeric>Invoiced</Th><Th numeric>Paid or credited</Th><Th numeric>Balance</Th></Tr></thead>
          <tbody>
            <Tr><Td className="text-fg-muted">{date(s.from)}</Td><Td /><Td className="text-fg-muted">Opening balance</Td><Td /><Td /><Td numeric><Money value={s.openingBalance} currency={s.currency} /></Td></Tr>
            {s.lines.map((l, n) => (
              <Tr key={`${l.kind}-${l.number}-${n}`}>
                <Td>{date(l.date)}</Td>
                <Td className="num">{l.number}</Td>
                <Td>{l.description}</Td>
                <Td numeric>{l.charge ? <Money value={l.charge} currency={s.currency} /> : null}</Td>
                <Td numeric>{l.credit ? <Money value={l.credit} currency={s.currency} /> : null}</Td>
                <Td numeric><Money value={l.balance} currency={s.currency} /></Td>
              </Tr>
            ))}
          </tbody>
          <tfoot><tr><Td colSpan={5} className="text-right font-semibold">Balance on {date(s.to)}</Td><Td numeric className="font-semibold"><Money value={s.closingBalance} currency={s.currency} /></Td></tr></tfoot>
        </Table>
      ) : null}
    </Card>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <main id="main" className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8"><div className="mx-auto max-w-5xl">{children}</div></main>;
}
