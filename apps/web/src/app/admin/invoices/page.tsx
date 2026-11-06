'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMeWithRole } from '@/lib/admin';

interface Invoice {
  id: string;
  orgId: string;
  organisation: string;
  reference: string;
  number: string | null;
  kind: string;
  status: 'OPEN' | 'PAID' | 'VOID';
  plan: { name: string };
  billingInterval: string;
  currency: string;
  total: string;
  taxTotal: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  gateway: string | null;
  paymentRef: string | null;
  voidReason: string | null;
}
interface Webhook { provider: string; type: string; signatureOk: boolean; outcome: string; receivedAt: string }
const KIND: Record<string, string> = { NEW: 'New plan', RENEWAL: 'Renewal', UPGRADE: 'Upgrade' };

/** Every subscription invoice, with payments recorded by hand and the gateways' recent notices. */
export default function AdminInvoicesPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [filter, setFilter] = useState<'all' | 'open' | 'paid' | 'void'>('all');
  const [note, setNote] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['admin-invoices', filter], queryFn: () => api<{ invoices: Invoice[]; webhooks: Webhook[] }>(`/v1/admin/invoices?filter=${filter}`) });
  const act = useMutation({
    mutationFn: async (a: { kind: 'mark-paid' | 'void' | 'check'; inv: Invoice; body?: Record<string, unknown> }) => ({ a, r: await api<Invoice | { invoice: Invoice; state: string }>(`/v1/admin/invoices/${a.inv.id}/${a.kind}`, { method: 'POST', body: a.body }) }),
    onSuccess: async ({ a, r }) => {
      const inv = 'invoice' in r ? r.invoice : r;
      setNote(a.kind === 'void' ? `${a.inv.reference} is void.` : inv.status === 'PAID' ? `${a.inv.organisation}: paid, tax invoice ${inv.number}.` : `${a.inv.reference}: the gateway says ${'state' in r ? r.state : 'not paid'}.`);
      await qc.invalidateQueries({ queryKey: ['admin-invoices'] });
      await qc.invalidateQueries({ queryKey: ['admin-subscriptions'] });
    },
  });
  const run = useMutation({ mutationFn: () => api<{ issued: number; reminded: number }>('/v1/admin/billing/run-renewals', { method: 'POST' }), onSuccess: async (r) => { setNote(`Renewals issued: ${r.issued}. Reminders sent: ${r.reminded}.`); await qc.invalidateQueries({ queryKey: ['admin-invoices'] }); } });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const ask = (t: string) => window.prompt(t)?.trim() || null;
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Subscription charges for every organisation. Unpaid ones are payment requests; a tax invoice number is given when the payment is received. Renewals are issued 7 days before a period ends."
        actions={
          <>
            <Select className="w-40" aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All</option>
              <option value="open">To pay</option>
              <option value="paid">Paid</option>
              <option value="void">Void</option>
            </Select>
            {manage ? <Button variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>Issue due renewals now</Button> : null}
          </>
        }
      />
      <ErrorAlert title="Not done" error={q.error ?? act.error ?? run.error} />
      {note ? <p role="status" className="mb-4 text-sm text-positive">{note}</p> : null}
      <Card className="mb-6" aria-label="Invoices">
        {q.data?.invoices.length ? (
          <Table>
            <thead><tr><Th>Organisation</Th><Th>Number</Th><Th>For</Th><Th numeric>Total</Th><Th>Status</Th><Th>Paid</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {q.data.invoices.map((i) => (
                <Tr key={i.id}>
                  <Td><Link className="font-medium hover:text-accent" href={`/admin/organisations/${i.orgId}`}>{i.organisation}</Link></Td>
                  <Td className="num">{i.number ?? i.reference}{i.number ? <span className="block text-xs text-fg-faint">{i.reference}</span> : null}</Td>
                  <Td>{KIND[i.kind] ?? i.kind}: {i.plan.name}<span className="block text-xs text-fg-muted">{i.billingInterval === 'ANNUAL' ? 'Annual' : 'Monthly'} · issued {dateTime(i.issuedAt)}</span></Td>
                  <Td numeric><Money value={i.total} currency={i.currency} />{Number(i.taxTotal) ? <span className="block text-xs text-fg-faint">tax <Money value={i.taxTotal} currency={i.currency} /></span> : null}</Td>
                  <Td><Badge tone={i.status === 'PAID' ? 'positive' : i.status === 'OPEN' ? 'warning' : 'neutral'}>{i.status === 'OPEN' ? 'To pay' : i.status === 'PAID' ? 'Paid' : 'Void'}</Badge>{i.voidReason ? <span className="block text-xs text-fg-faint">{i.voidReason}</span> : null}</Td>
                  <Td className="text-sm">{i.paidAt ? <>{dateTime(i.paidAt)}<span className="block text-xs text-fg-muted">{i.gateway === 'MANUAL' ? 'By hand' : i.gateway?.toLowerCase()} · {i.paymentRef}</span></> : i.gateway ? <span className="text-xs text-fg-muted">via {i.gateway.toLowerCase()}</span> : '—'}</Td>
                  <Td className="text-right">
                    {manage && i.status === 'OPEN' ? (
                      <div className="flex justify-end gap-1">
                        {i.gateway && i.gateway !== 'MANUAL' ? <Button size="sm" variant="ghost" onClick={() => act.mutate({ kind: 'check', inv: i })}>Ask gateway</Button> : null}
                        <Button size="sm" variant="ghost" onClick={() => { const r = ask(`Payment reference for ${i.reference} (bank transfer UTR, cheque number)`); if (r) act.mutate({ kind: 'mark-paid', inv: i, body: { reference: r } }); }}>Record payment</Button>
                        <Button size="sm" variant="ghost" onClick={() => { const r = ask(`Why is ${i.reference} voided?`); if (r) act.mutate({ kind: 'void', inv: i, body: { reason: r } }); }}>Void</Button>
                      </div>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? <EmptyState title="No invoices">They appear when an organisation pays for a plan or a renewal is issued.</EmptyState> : null}
      </Card>
      <Card aria-label="Gateway notices">
        <CardHeader title="Gateway notices" description="The latest webhooks received. A notice with a wrong signature is refused and kept here." />
        {q.data?.webhooks.length ? (
          <Table>
            <thead><tr><Th>Received</Th><Th>Gateway</Th><Th>Event</Th><Th>Signature</Th><Th>Outcome</Th></tr></thead>
            <tbody>
              {q.data.webhooks.map((w, n) => (
                <Tr key={n}>
                  <Td className="whitespace-nowrap">{dateTime(w.receivedAt)}</Td>
                  <Td>{w.provider === 'STRIPE' ? 'Stripe' : 'Razorpay'}</Td>
                  <Td className="text-sm">{w.type || '—'}</Td>
                  <Td>{w.signatureOk ? <Badge tone="positive">Valid</Badge> : <Badge tone="negative">Refused</Badge>}</Td>
                  <Td className="text-sm text-fg-muted">{w.outcome}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? <p className="px-5 pb-5 pt-3 text-sm text-fg-muted">None yet.</p> : null}
      </Card>
    </>
  );
}
