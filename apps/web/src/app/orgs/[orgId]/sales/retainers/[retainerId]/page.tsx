'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { RetainerTermsFields, type TermsValue } from '@/components/retainers/retainer-terms';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, today } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';
import { RETAINER_STATE, type RetainerDetail } from '@/lib/retainers';

const MONEY = /^\d{0,15}(\.\d{0,2})?$/;
const cents = (s: string) => Math.round(Number(s || 0) * 100);
type Dlg = null | 'receipt' | 'existing' | 'pay' | 'edit' | 'close';

export default function RetainerPage() {
  const { org, orgId } = useOrg();
  const { retainerId } = useParams<{ retainerId: string }>();
  const qc = useQueryClient();
  const key = ['retainer', orgId, retainerId];
  const base = `/v1/orgs/${orgId}/sales/retainers/${retainerId}`;
  const q = useQuery({ queryKey: key, queryFn: () => api<RetainerDetail>(base) });
  const accounts = useAccounts();
  const banks = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && (a.subtype === 'BANK' || a.subtype === 'CASH'));
  const [dlg, setDlg] = useState<Dlg>(null);
  const [when, setWhen] = useState(today());
  const [bankId, setBankId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [pay, setPay] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState<TermsValue>({ name: '', amount: '', minimumBalance: '', startDate: '', terms: '' });
  const [reason, setReason] = useState('');
  const done = async () => {
    setDlg(null);
    await qc.invalidateQueries({ queryKey: ['retainers', orgId] });
    await qc.invalidateQueries({ queryKey: ['documents', orgId] });
    await qc.invalidateQueries({ queryKey: key });
  };
  const run = useMutation({ mutationFn: (v: { path: string; method?: string; body: Record<string, unknown> }) => api(`${base}${v.path}`, { method: v.method ?? 'POST', body: v.body }), onSuccess: done });

  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the retainer" error={q.error} />;
  const r = q.data;
  if (!r) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = r.currency;
  const active = r.status === 'ACTIVE' && r.can.manage;
  const open = (d: Dlg) => {
    run.reset();
    setWhen(today());
    setAmount(d === 'receipt' && Number(r.topUpDue) > 0 ? r.topUpDue : '');
    setReference('');
    setPaymentId(r.otherReceipts[0]?.id ?? '');
    setBankId(bankId || (banks.find((b) => b.subtype === 'BANK') ?? banks[0])?.id || '');
    if (d === 'pay') {
      let left = cents(r.held);
      setPay(Object.fromEntries(r.openInvoices.map((i) => { const take = Math.min(left, cents(i.open)); left -= take; return [i.id, take > 0 ? (take / 100).toFixed(2) : '']; })));
    }
    if (d === 'edit') setTerms({ name: r.name, amount: r.amount, minimumBalance: r.minimumBalance, startDate: r.startDate, terms: r.terms ?? '' });
    setReason('');
    setDlg(d);
  };
  const chosen = r.openInvoices.filter((i) => cents(pay[i.id] ?? '') > 0);
  const payTotal = chosen.reduce((t, i) => t + cents(pay[i.id]!), 0);
  const over = r.openInvoices.filter((i) => cents(pay[i.id] ?? '') > cents(i.open));
  const s = RETAINER_STATE[r.state];
  return (
    <>
      <PageHeader
        title={`Retainer ${r.reference}`}
        description={[r.contact?.name, r.name, `since ${date(r.startDate)}`].filter(Boolean).join(' · ')}
        actions={
          active ? (
            <>
              <Button variant="ghost" onClick={() => open('edit')}>Edit terms</Button>
              {Number(r.held) === 0 ? <Button variant="ghost" onClick={() => open('close')}>Close retainer</Button> : null}
              {r.otherReceipts.length ? <Button variant="secondary" onClick={() => open('existing')}>Add a receipt already recorded…</Button> : null}
              <Button variant="secondary" onClick={() => open('receipt')}>Record receipt…</Button>
              {Number(r.held) > 0 && r.openInvoices.length ? <Button onClick={() => open('pay')}>Pay invoices…</Button> : null}
            </>
          ) : null
        }
      />
      {r.status === 'CLOSED' ? <Alert tone="neutral" title="Closed">{r.closeReason}{r.closedAt ? ` (${dateTime(r.closedAt)})` : ''}</Alert> : null}
      {r.state === 'LOW' || r.state === 'EMPTY' ? (
        <Alert tone="warning" title="Top-up due">The retainer holds <Money value={r.held} currency={cur} />, below the <Money value={r.minimumBalance} currency={cur} /> agreed. Ask {r.contact?.name ?? 'the customer'} for <Money value={r.topUpDue} currency={cur} /> to bring it back to <Money value={r.amount} currency={cur} />.</Alert>
      ) : null}
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader title="Retainer" />
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">Status</dt><dd><Badge tone={s.tone}>{s.label}</Badge></dd>
            <dt className="text-fg-muted">Customer</dt><dd>{r.contact ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${r.contact.id}`}>{r.contact.name}</Link> : '—'}</dd>
            <dt className="text-fg-muted">Agreed amount</dt><dd><Money value={r.amount} currency={cur} /></dd>
            <dt className="text-fg-muted">Top up below</dt><dd><Money value={r.minimumBalance} currency={cur} /></dd>
            <dt className="text-fg-muted">Held now</dt><dd className="font-medium"><Money value={r.held} currency={cur} /></dd>
            <dt className="text-fg-muted">Top-up due</dt><dd className="font-medium">{Number(r.topUpDue) > 0 ? <Money value={r.topUpDue} currency={cur} /> : 'None'}</dd>
            {r.terms ? <><dt className="text-fg-muted">Terms</dt><dd>{r.terms}</dd></> : null}
          </dl>
        </Card>
        <div className="flex flex-col gap-4 xl:col-span-2">
          <Card>
            <CardHeader title="Retainer receipts" description="The customer's receipts that make up the retainer, oldest first. Invoices are paid from the oldest receipt first; voiding a receipt takes it out of the balance." />
            {r.receipts.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">No receipts yet. Record what the customer pays into the retainer.</p> : (
              <Table aria-label="Retainer receipts">
                <thead><tr><Th>Receipt</Th><Th>Date</Th><Th>Bank</Th><Th>Status</Th><Th numeric>Amount</Th><Th numeric>Applied</Th><Th numeric>Held</Th></tr></thead>
                <tbody>
                  {r.receipts.map((p) => (
                    <Tr key={p.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/receipts/${p.id}`}>{p.number}</Link></Td>
                      <Td>{date(p.date)}</Td>
                      <Td>{p.bankAccount.name}</Td>
                      <Td><Badge tone={p.status === 'VOID' ? 'negative' : 'positive'}>{p.status === 'VOID' ? 'Void' : 'Posted'}</Badge></Td>
                      <Td numeric><Money value={p.amount} currency={cur} /></Td>
                      <Td numeric><Money value={p.applied} currency={cur} /></Td>
                      <Td numeric><Money value={p.left} currency={cur} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Invoices paid from the retainer" description="Each part is an ordinary allocation of a retainer receipt to an invoice; remove one on the receipt to put the money back in the retainer." />
            {r.drawdowns.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">Nothing paid from the retainer yet.</p> : (
              <Table aria-label="Invoices paid from the retainer">
                <thead><tr><Th>Date</Th><Th>Invoice</Th><Th>From receipt</Th><Th numeric>Amount</Th></tr></thead>
                <tbody>
                  {r.drawdowns.map((d) => (
                    <Tr key={d.id}>
                      <Td>{date(d.date)}</Td>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${d.invoice.id}`}>{d.invoice.number}</Link></Td>
                      <Td>{d.receipt}</Td>
                      <Td numeric><Money value={d.amount} currency={cur} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Open invoices of this customer" description="Invoices still owed that the retainer can pay, oldest due first." />
            {r.openInvoices.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">This customer owes nothing now.</p> : (
              <Table aria-label="Open invoices of this customer">
                <thead><tr><Th>Invoice</Th><Th>Date</Th><Th>Due</Th><Th numeric>Total</Th><Th numeric>Owed</Th></tr></thead>
                <tbody>
                  {r.openInvoices.map((i) => (
                    <Tr key={i.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${i.id}`}>{i.number}</Link></Td>
                      <Td>{date(i.issueDate)}</Td>
                      <Td>{i.dueDate ? date(i.dueDate) : '—'}</Td>
                      <Td numeric><Money value={i.total} currency={cur} /></Td>
                      <Td numeric><Money value={i.open} currency={cur} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      </div>

      <Dialog open={dlg === 'receipt'} onOpenChange={(o) => !o && setDlg(null)} title={`Record a receipt into ${r.reference}`} description="Posts an ordinary customer receipt (bank debited, receivables credited) and keeps it unapplied in the retainer.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run.mutate({ path: '/receipts', body: { date: when, bankAccountId: bankId, amount, reference: reference || null } }); }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date received">{(p) => <Input {...p} type="date" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
            <Field label="Amount received">{(p) => <Input {...p} className="num" inputMode="decimal" value={amount} onChange={(e) => MONEY.test(e.target.value) && setAmount(e.target.value)} />}</Field>
          </div>
          <Field label="Into account">{(p) => <Select {...p} value={bankId} onChange={(e) => setBankId(e.target.value)}>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</Select>}</Field>
          <Field label="Reference (optional)" hint={`Left empty, the receipt is referenced ${r.reference}.`}>{(p) => <Input {...p} value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} placeholder="UTR or cheque number" />}</Field>
          <ErrorAlert title="Could not record the receipt" error={run.error} />
          <div className="flex justify-end"><Button type="submit" loading={run.isPending} disabled={!bankId || !(Number(amount) > 0)}>Record receipt</Button></div>
        </form>
      </Dialog>

      <Dialog open={dlg === 'existing'} onOpenChange={(o) => !o && setDlg(null)} title={`Add a receipt to ${r.reference}`} description="A receipt from this customer that is not yet applied to invoices; what is left of it joins the retainer.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run.mutate({ path: '/receipts', body: { paymentId } }); }}>
          <Field label="Receipt">{(p) => <Select {...p} value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>{r.otherReceipts.map((x) => <option key={x.id} value={x.id}>{x.number} · {date(x.date)} · {x.unapplied} not applied</option>)}</Select>}</Field>
          <ErrorAlert title="Could not add the receipt" error={run.error} />
          <div className="flex justify-end"><Button type="submit" loading={run.isPending} disabled={!paymentId}>Add to retainer</Button></div>
        </form>
      </Dialog>

      <Dialog open={dlg === 'pay'} onOpenChange={(o) => !o && setDlg(null)} title={`Pay invoices from ${r.reference}`} description="Filled oldest due first, up to what the retainer holds. Change the amounts to pay other invoices or parts of them.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run.mutate({ path: '/drawdown', body: { invoices: chosen.map((i) => ({ documentId: i.id, amount: pay[i.id] })) } }); }}>
          <Table aria-label="Invoices to pay">
            <thead><tr><Th>Invoice</Th><Th>Due</Th><Th numeric>Owed</Th><Th numeric className="w-36">Pay now</Th></tr></thead>
            <tbody>
              {r.openInvoices.map((i) => (
                <Tr key={i.id}>
                  <Td>{i.number}</Td>
                  <Td>{i.dueDate ? date(i.dueDate) : '—'}</Td>
                  <Td numeric><Money value={i.open} currency={cur} /></Td>
                  <Td numeric><Input aria-label={`Pay now for ${i.number}`} className="num text-right" inputMode="decimal" value={pay[i.id] ?? ''} onChange={(e) => MONEY.test(e.target.value) && setPay((x) => ({ ...x, [i.id]: e.target.value }))} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <p className={`text-sm ${payTotal > cents(r.held) ? 'text-warning' : 'text-fg-muted'}`}>Paying <Money value={(payTotal / 100).toFixed(2)} currency={cur} /> of <Money value={r.held} currency={cur} /> held.</p>
          {over.length ? <p className="text-sm text-warning">{over.map((i) => i.number).join(', ')}: more than is owed.</p> : null}
          <ErrorAlert title="Could not pay the invoices" error={run.error} />
          <div className="flex justify-end"><Button type="submit" loading={run.isPending} disabled={!chosen.length || over.length > 0 || payTotal > cents(r.held)}>Pay from retainer</Button></div>
        </form>
      </Dialog>

      <Dialog open={dlg === 'edit'} onOpenChange={(o) => !o && setDlg(null)} title={`Terms of ${r.reference}`} description="Change the agreed amount or minimum when the customer agrees new terms. Receipts and payments stay as they are.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run.mutate({ path: '', method: 'PUT', body: { name: terms.name, amount: terms.amount || '0', minimumBalance: terms.minimumBalance || '0', startDate: terms.startDate, terms: terms.terms || null } }); }}>
          <RetainerTermsFields v={terms} set={setTerms} />
          <ErrorAlert title="Could not save the terms" error={run.error} />
          <div className="flex justify-end"><Button type="submit" loading={run.isPending}>Save terms</Button></div>
        </form>
      </Dialog>

      <Dialog open={dlg === 'close'} onOpenChange={(o) => !o && setDlg(null)} title={`Close ${r.reference}`} description="Only a retainer that holds nothing can be closed. It stays on record with the reason.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run.mutate({ path: '/close', body: { reason } }); }}>
          <Field label="Why is it closed?">{(p) => <Textarea {...p} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Engagement ended" />}</Field>
          <ErrorAlert title="Could not close it" error={run.error} />
          <div className="flex justify-end"><Button type="submit" variant="danger" loading={run.isPending} disabled={!reason.trim()}>Close retainer</Button></div>
        </form>
      </Dialog>
    </>
  );
}
