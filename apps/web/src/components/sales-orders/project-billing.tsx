'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date, dateTime, today } from '@/lib/format';
import type { BillingMethod, OrderDetail, OrderInvoiceRef, OrderMilestone } from '@/lib/sales-orders';

const PCT = /^\d{0,3}(\.\d{0,2})?$/;
const METHOD: Record<BillingMethod, { label: string; help: string }> = {
  DELIVERY: { label: 'By delivery', help: 'Each invoice bills the quantities you choose, as you deliver them.' },
  MILESTONES: { label: 'By milestones', help: 'The order is split into milestones, each a share of its value. Invoice a milestone once it is reached.' },
  PROGRESS: { label: 'By progress', help: 'Each claim says how complete the work is. The invoice bills every line up to that share, less earlier claims.' },
};
const TONE = { DRAFT: 'neutral', POSTED: 'positive', VOID: 'negative' } as const;
const sum = (xs: string[]) => xs.reduce((t, x) => t + Math.round(Number(x || 0) * 100), 0) / 100;

function InvoiceLink({ orgId, inv }: { orgId: string; inv: OrderInvoiceRef }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${inv.id}`}>{inv.number ?? 'Draft invoice'}</Link>
      <Badge tone={TONE[inv.status as keyof typeof TONE] ?? 'neutral'}>{inv.status.charAt(0) + inv.status.slice(1).toLowerCase()}</Badge>
    </span>
  );
}

/** How a sales order is billed (AR-013 milestones, AR-014 progress), with its milestones or claims. */
export function ProjectBilling({ orgId, o, onChanged }: { orgId: string; o: OrderDetail; onChanged: () => Promise<void> }) {
  const qc = useQueryClient();
  const router = useRouter();
  const base = `/v1/orgs/${orgId}/sales/orders/${o.id}`;
  const cur = o.currency;
  const live = o.status === 'OPEN';
  const anyBilled = o.lines.some((l) => Number(l.billed) > 0);
  const canEdit = o.can.manage && live;
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<{ id: string | null; name: string; percent: string; dueDate: string; locked: boolean }[]>([]);
  const [invoicing, setInvoicing] = useState<OrderMilestone | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [issueDate, setIssueDate] = useState(today());
  const [percent, setPercent] = useState('');
  const [note, setNote] = useState('');

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['sales-orders', orgId] });
    await qc.invalidateQueries({ queryKey: ['documents', orgId] });
    await onChanged();
  };
  const toInvoice = async (r: { documentId: string }) => {
    await done();
    router.push(`/orgs/${orgId}/sales/invoices/${r.documentId}`);
  };
  const method = useMutation({ mutationFn: (m: BillingMethod) => api(`${base}/billing-method`, { method: 'PUT', body: { method: m } }), onSuccess: done });
  const savePlan = useMutation({
    mutationFn: () => api(`${base}/milestones`, { method: 'PUT', body: { milestones: plan.map((m) => ({ id: m.id, name: m.name, percent: m.percent || '0', dueDate: m.dueDate || null })) } }),
    onSuccess: async () => {
      setPlanning(false);
      await done();
    },
  });
  const reach = useMutation({ mutationFn: (v: { id: string; done: boolean }) => api(`${base}/milestones/${v.id}/complete`, { method: 'POST', body: { done: v.done } }), onSuccess: done });
  const invoice = useMutation({ mutationFn: () => api<{ documentId: string }>(`${base}/milestones/${invoicing!.id}/invoice`, { method: 'POST', body: { issueDate } }), onSuccess: toInvoice });
  const claim = useMutation({ mutationFn: () => api<{ documentId: string }>(`${base}/progress-claims`, { method: 'POST', body: { percentComplete: percent, issueDate, note: note || null } }), onSuccess: toInvoice });

  const startPlan = () => {
    setPlan(
      o.milestones.length
        ? o.milestones.map((m) => ({ id: m.id, name: m.name, percent: m.percent, dueDate: m.dueDate ?? '', locked: !!m.invoice }))
        : [{ id: null, name: '', percent: '', dueDate: '', locked: false }],
    );
    savePlan.reset();
    setPlanning(true);
  };
  const planTotal = sum(plan.map((m) => m.percent));
  const claimed = Number(o.progress.claimed);
  const preview = Number(percent || 0);
  const previewValue = Math.max(0, ((preview - claimed) * Number(o.total)) / 100);

  return (
    <>
      <Card>
        <CardHeader title="How this order is billed" description={METHOD[o.billingMethod].help} />
        <div className="flex flex-wrap items-end gap-3 px-5 pb-5">
          <Field label="Billing method">
            {(p) => (
              <Select {...p} value={o.billingMethod} disabled={!canEdit || anyBilled || method.isPending} onChange={(e) => method.mutate(e.target.value as BillingMethod)}>
                {(Object.keys(METHOD) as BillingMethod[]).map((m) => <option key={m} value={m}>{METHOD[m].label}</option>)}
              </Select>
            )}
          </Field>
          {anyBilled && live ? <p className="pb-2 text-sm text-fg-muted">Part of the order is billed, so the method is fixed. Void or delete its invoices to change it.</p> : null}
        </div>
        <div className="px-5 pb-5"><ErrorAlert title="Could not change the billing method" error={method.error} /></div>
      </Card>

      {o.billingMethod === 'MILESTONES' ? (
        <Card>
          <CardHeader
            title="Milestones"
            description={`${o.milestonesInvoiced}% of the order is invoiced; the plan covers ${o.milestonesTotal}%.`}
            actions={canEdit ? <Button variant="secondary" onClick={startPlan}>{o.milestones.length ? 'Edit milestones' : 'Plan milestones'}</Button> : null}
          />
          {o.milestones.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-fg-muted">No milestones yet. Plan them to split the order's value into shares, such as 30% on design, 50% on going live and 20% on handover.</p>
          ) : (
            <Table aria-label="Milestones">
              <thead><tr><Th>#</Th><Th>Milestone</Th><Th numeric>Share</Th><Th numeric>Value</Th><Th>Due</Th><Th>Reached</Th><Th>Invoice</Th><Th /></tr></thead>
              <tbody>
                {o.milestones.map((m) => (
                  <Tr key={m.id}>
                    <Td>{m.seq}</Td>
                    <Td>{m.name}</Td>
                    <Td numeric className="num">{m.percent}%</Td>
                    <Td numeric><Money value={m.value} currency={cur} /></Td>
                    <Td>{m.dueDate ? date(m.dueDate) : '—'}</Td>
                    <Td>{m.reached ? <span title={m.completedAt ? dateTime(m.completedAt) : undefined}>Yes</span> : <span className="text-fg-muted">Not yet</span>}</Td>
                    <Td>{m.invoice ? <InvoiceLink orgId={orgId} inv={m.invoice} /> : m.voidInvoice ? <span className="text-fg-muted">Voided, free to invoice again</span> : <span className="text-fg-muted">Not invoiced</span>}</Td>
                    <Td className="whitespace-nowrap text-right">
                      {canEdit && !m.invoice ? (
                        m.reached ? (
                          <span className="inline-flex gap-2">
                            <Button size="sm" variant="ghost" onClick={() => reach.mutate({ id: m.id, done: false })}>Not reached</Button>
                            <Button size="sm" onClick={() => { setIssueDate(today()); invoice.reset(); setInvoicing(m); }}>Make invoice…</Button>
                          </span>
                        ) : (
                          <Button size="sm" variant="secondary" loading={reach.isPending && reach.variables?.id === m.id} onClick={() => reach.mutate({ id: m.id, done: true })}>Mark reached</Button>
                        )
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="px-5 pb-5"><ErrorAlert title="Could not update the milestone" error={reach.error} /></div>
        </Card>
      ) : null}

      {o.billingMethod === 'PROGRESS' ? (
        <Card>
          <CardHeader
            title="Progress claims"
            description={`Claimed so far: ${o.progress.claimed}% complete. A claim bills every line up to its percent, less earlier claims.`}
            actions={canEdit && claimed < 100 ? <Button onClick={() => { setIssueDate(today()); setPercent(''); setNote(''); claim.reset(); setClaiming(true); }}>Claim progress…</Button> : null}
          />
          {o.progress.claims.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-fg-muted">No claims yet. Claim progress when part of the work is done, for example 40% complete after the foundations.</p>
          ) : (
            <Table aria-label="Progress claims">
              <thead><tr><Th>Claimed on</Th><Th numeric>Complete</Th><Th>Note</Th><Th>Invoice</Th><Th numeric>Invoice total</Th></tr></thead>
              <tbody>
                {o.progress.claims.map((c) => (
                  <Tr key={c.id} className={c.void ? 'text-fg-muted line-through' : undefined}>
                    <Td>{dateTime(c.createdAt)}</Td>
                    <Td numeric className="num">{c.percentComplete}%</Td>
                    <Td>{c.note ?? '—'}</Td>
                    <Td>{c.invoice ? <InvoiceLink orgId={orgId} inv={c.invoice} /> : '—'}</Td>
                    <Td numeric>{c.invoice ? <Money value={c.invoice.total} currency={cur} /> : '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : null}

      <Dialog open={planning} onOpenChange={setPlanning} title={`Milestones for ${o.reference}`} description="Each milestone is a share of the order's value; together they can be at most 100%. Invoiced milestones keep their name and share.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); savePlan.mutate(); }}>
          <Table aria-label="Milestone plan">
            <thead><tr><Th>Milestone</Th><Th numeric className="w-28">Share %</Th><Th className="w-40">Due</Th><Th /></tr></thead>
            <tbody>
              {plan.map((m, i) => (
                <Tr key={m.id ?? `new-${i}`}>
                  <Td><Input aria-label={`Milestone ${i + 1} name`} value={m.name} maxLength={200} disabled={m.locked} onChange={(e) => setPlan((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Design signed off" /></Td>
                  <Td numeric><Input aria-label={`Milestone ${i + 1} share`} className="num text-right" inputMode="decimal" value={m.percent} disabled={m.locked} onChange={(e) => PCT.test(e.target.value) && setPlan((p) => p.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} /></Td>
                  <Td><Input aria-label={`Milestone ${i + 1} due date`} type="date" value={m.dueDate} onChange={(e) => setPlan((p) => p.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} /></Td>
                  <Td className="text-right">
                    {m.locked ? <span className="text-xs text-fg-muted">Invoiced</span> : <Button size="sm" variant="ghost" type="button" aria-label={`Remove milestone ${i + 1}`} onClick={() => setPlan((p) => p.filter((_, j) => j !== i))}>Remove</Button>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <div className="flex items-center justify-between text-sm">
            <Button size="sm" variant="secondary" type="button" onClick={() => setPlan((p) => [...p, { id: null, name: '', percent: '', dueDate: '', locked: false }])}>Add milestone</Button>
            <span className={planTotal > 100 ? 'text-warning' : 'text-fg-muted'}>Total {planTotal}% of <Money value={o.total} currency={cur} /></span>
          </div>
          <ErrorAlert title="Could not save the milestones" error={savePlan.error} />
          <div className="flex justify-end"><Button type="submit" loading={savePlan.isPending} disabled={!plan.length || planTotal > 100}>Save milestones</Button></div>
        </form>
      </Dialog>

      <Dialog open={!!invoicing} onOpenChange={(v) => !v && setInvoicing(null)} title={invoicing ? `Invoice "${invoicing.name}"` : ''} description="Makes a draft invoice for this milestone's share of every line, at the order's prices and tax. Review and post it like any invoice.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); invoice.mutate(); }}>
          {invoicing ? <p className="text-sm">{invoicing.percent}% of the order, about <Money value={invoicing.value} currency={cur} />.</p> : null}
          <Field label="Invoice date">{(p) => <Input {...p} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />}</Field>
          <ErrorAlert title="Could not invoice the milestone" error={invoice.error} />
          <div className="flex justify-end"><Button type="submit" loading={invoice.isPending}>Make draft invoice</Button></div>
        </form>
      </Dialog>

      <Dialog open={claiming} onOpenChange={setClaiming} title={`Claim progress on ${o.reference}`} description={`Claimed so far: ${o.progress.claimed}% complete. The invoice bills every line up to the new percent, at the order's prices and tax.`}>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); claim.mutate(); }}>
          <Field label="Percent complete">{(p) => <Input {...p} className="num" inputMode="decimal" value={percent} onChange={(e) => PCT.test(e.target.value) && setPercent(e.target.value)} placeholder={claimed ? `More than ${o.progress.claimed}` : '40'} />}</Field>
          <Field label="Invoice date">{(p) => <Input {...p} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />}</Field>
          <Field label="Note (optional)">{(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Foundations and plinth done" />}</Field>
          {preview > claimed && preview <= 100 ? <p className="text-sm text-fg-muted">This claim bills {(preview - claimed).toFixed(2).replace(/\.?0+$/, '')}% more of the order, about <Money value={previewValue.toFixed(2)} currency={cur} />.</p> : null}
          {percent && (preview <= claimed || preview > 100) ? <p className="text-sm text-warning">Claim more than {o.progress.claimed}% and at most 100%.</p> : null}
          <ErrorAlert title="Could not make the claim" error={claim.error} />
          <div className="flex justify-end"><Button type="submit" loading={claim.isPending} disabled={!percent || preview <= claimed || preview > 100}>Make draft invoice</Button></div>
        </form>
      </Dialog>
    </>
  );
}
