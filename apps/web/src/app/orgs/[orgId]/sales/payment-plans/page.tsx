'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanProgressStatus } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Instalment { no: number; dueDate: string; amount: string }
interface Suggestion {
  invoices: { id: string; number: string; dueDate: string; outstanding: string; daysOverdue: number }[];
  leftOut: { id: string; number: string; outstanding: string }[];
  total: string;
  monthlyReceipts: string | null;
  oldestOverdueDays: number;
  recommended: number;
  instalments: number;
  firstDueDate: string;
  schedule: Instalment[];
  options: { instalments: number; amount: string; lastDueDate: string; recommended: boolean }[];
  reasons: string[];
}
interface Candidate extends Suggestion { contactId: string; customer: string }
interface Plan {
  id: string;
  reference: string;
  contactId: string;
  customer: string;
  total: string;
  invoices: { id: string; number: string; outstanding: string }[];
  suggestedInstalments: number;
  note: string | null;
  status: PlanProgressStatus;
  statusLabel: string;
  progress: { paid: string; remaining: string; behindBy: string; instalments: (Instalment & { paid: string; status: string })[]; next: { no: number; dueDate: string; amount: string } | null };
  createdAt: string;
  cancelReason: string | null;
}
interface Plans {
  asOf: string;
  currency: string;
  summary: { running: number; onTrack: number; behind: number; broken: number; completed: number; remaining: string; behindBy: string; candidates: number };
  candidates: Candidate[];
  plans: Plan[];
}

const TONE: Record<PlanProgressStatus, 'positive' | 'warning' | 'negative' | 'neutral' | 'accent'> = { ON_TRACK: 'positive', BEHIND: 'warning', BROKEN: 'negative', COMPLETED: 'accent', CANCELLED: 'neutral' };
const INSTALMENT: Record<string, string> = { PAID: 'Paid', PART_PAID: 'Part paid', LATE: 'Late', DUE: 'Due this week', UPCOMING: 'Upcoming' };

/** Suggested payment plans (AR-040): instalment plans for customers behind on paying, and how agreed plans are going. */
export default function PaymentPlansPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payment-plans', orgId], queryFn: () => api<Plans>(`/v1/orgs/${orgId}/payment-plans`) });
  const [offer, setOffer] = useState<Candidate | null>(null);
  const [instalments, setInstalments] = useState('');
  const [first, setFirst] = useState('');
  const [note, setNote] = useState('');
  const [cancelling, setCancelling] = useState<Plan | null>(null);
  const [reason, setReason] = useState('');
  const preview = useQuery({
    queryKey: ['payment-plans', orgId, 'suggest', offer?.contactId, instalments, first],
    enabled: !!offer && !!instalments && !!first,
    queryFn: () => api<{ suggestion: Suggestion | null }>(`/v1/orgs/${orgId}/payment-plans/suggest?contactId=${offer!.contactId}&instalments=${instalments}&firstDueDate=${first}`),
  });
  const agree = useMutation({
    mutationFn: () => api<Plan>(`/v1/orgs/${orgId}/payment-plans`, { method: 'POST', body: { contactId: offer!.contactId, instalments: Number(instalments), firstDueDate: first, note: note.trim() || null } }),
    onSuccess: async () => {
      setOffer(null);
      await qc.invalidateQueries({ queryKey: ['payment-plans', orgId] });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<Plan>(`/v1/orgs/${orgId}/payment-plans/${cancelling!.id}/cancel`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: async () => {
      setCancelling(null);
      await qc.invalidateQueries({ queryKey: ['payment-plans', orgId] });
    },
  });
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  const canManage = can(org.role, 'collections.manage');
  const open = (x: Candidate) => {
    setOffer(x);
    setInstalments(String(x.recommended));
    setFirst(x.firstDueDate);
    setNote('');
    agree.reset();
  };
  const schedule = preview.data?.suggestion?.schedule ?? offer?.schedule ?? [];
  return (
    <>
      <PageHeader
        title="Payment plans"
        description="Instalment plans for customers behind on paying, sized to what each has paid a month lately, and how every agreed plan is going from the money received since. Agreeing a plan does not change the invoices or the books."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/sales/collection-priorities`}>Collection priorities</Link>}
      />
      <ErrorAlert title="Could not load payment plans" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Plans running" value={d.summary.running} sub={`${d.summary.onTrack} on track`} />
            <Stat label="Behind or broken" value={d.summary.behind + d.summary.broken} tone={d.summary.behind + d.summary.broken ? 'negative' : 'positive'} sub={<>Behind by <Money value={d.summary.behindBy} currency={c} /></>} />
            <Stat label="Still to come on plans" value={<Money value={d.summary.remaining} currency={c} />} tone="accent" />
            <Stat label="Customers to offer a plan" value={d.summary.candidates} tone={d.summary.candidates ? 'warning' : 'positive'} sub="Overdue, not disputed, no plan" />
          </div>
          <Card>
            <CardHeader title="Customers to offer a plan" description="Biggest overdue balance first. The suggested plan clears what is overdue and not disputed in monthly instalments close to what the customer has paid a month over the last 6 months." />
            {!d.candidates.length ? (
              <EmptyState title="No one to offer a plan">No customer without a plan has an overdue balance that is not in dispute.</EmptyState>
            ) : (
              <Table aria-label="Customers to offer a plan">
                <thead><Tr><Th>Customer</Th><Th numeric>Overdue</Th><Th numeric>Paid a month lately</Th><Th>Suggested plan</Th><Th>Why</Th>{canManage ? <Th>{''}</Th> : null}</Tr></thead>
                <tbody>
                  {d.candidates.map((x) => (
                    <Tr key={x.contactId}>
                      <Td>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${x.contactId}`}>{x.customer}</Link>
                        <div className="text-xs text-fg-muted">{x.invoices.map((i) => i.number).join(', ')} · oldest {x.oldestOverdueDays} days overdue</div>
                      </Td>
                      <Td numeric><Money value={x.total} currency={c} /></Td>
                      <Td numeric>{x.monthlyReceipts ? <Money value={x.monthlyReceipts} currency={c} /> : <span className="text-fg-muted">Nothing received</span>}</Td>
                      <Td>{x.recommended} × <Money value={x.schedule[0]!.amount} currency={c} /><div className="text-xs text-fg-muted">From {date(x.schedule[0]!.dueDate)} to {date(x.schedule[x.schedule.length - 1]!.dueDate)}</div></Td>
                      <Td><ul className="space-y-0.5 text-xs">{x.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Td>
                      {canManage ? <Td><Button size="sm" onClick={() => open(x)}>Set up plan</Button></Td> : null}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card className="mt-6">
            <CardHeader title="Agreed payment plans" description="Money received against a plan's invoices since it was agreed pays its instalments in order. Behind: an instalment past its date is not fully paid. Broken: one is more than 7 days late." />
            {!d.plans.length ? (
              <EmptyState title="No plans yet">Set up a plan for a customer above once they agree to it.</EmptyState>
            ) : (
              <Table aria-label="Agreed payment plans">
                <thead><Tr><Th>Plan</Th><Th>Customer</Th><Th>Status</Th><Th numeric>Total</Th><Th numeric>Paid</Th><Th>Next instalment</Th><Th>Instalments</Th>{canManage ? <Th>{''}</Th> : null}</Tr></thead>
                <tbody>
                  {d.plans.map((p) => (
                    <Tr key={p.id}>
                      <Td className="num">{p.reference}<div className="text-xs text-fg-muted">Agreed {date(p.createdAt.slice(0, 10))}</div></Td>
                      <Td>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${p.contactId}`}>{p.customer}</Link>
                        <div className="text-xs text-fg-muted">{p.invoices.map((i) => i.number).join(', ')}</div>
                        {p.note ? <div className="text-xs text-fg-muted">{p.note}</div> : null}
                      </Td>
                      <Td><Badge tone={TONE[p.status]} className="whitespace-nowrap">{p.statusLabel}</Badge>{p.cancelReason ? <div className="text-xs text-fg-muted">{p.cancelReason}</div> : null}{!/^0(\.0+)?$/.test(p.progress.behindBy) && p.status !== 'CANCELLED' ? <div className="text-xs text-fg-muted">Behind by <Money value={p.progress.behindBy} currency={c} /></div> : null}</Td>
                      <Td numeric><Money value={p.total} currency={c} /></Td>
                      <Td numeric><Money value={p.progress.paid} currency={c} /></Td>
                      <Td>{p.progress.next ? <><Money value={p.progress.next.amount} currency={c} /> on {date(p.progress.next.dueDate)}</> : <span className="text-fg-muted">None</span>}</Td>
                      <Td>
                        <details>
                          <summary className="cursor-pointer">{p.progress.instalments.filter((i) => i.status === 'PAID').length} of {p.progress.instalments.length} paid</summary>
                          <ul className="mt-1 space-y-0.5 text-xs">
                            {p.progress.instalments.map((i) => <li key={i.no}>{i.no}. {date(i.dueDate)}: <Money value={i.amount} currency={c} /> · {INSTALMENT[i.status]}{i.status === 'PART_PAID' || i.status === 'LATE' ? <> (<Money value={i.paid} currency={c} /> paid)</> : null}</li>)}
                          </ul>
                          {p.suggestedInstalments !== p.progress.instalments.length ? <div className="mt-1 text-xs text-fg-muted">Suggested: {p.suggestedInstalments} instalments</div> : null}
                        </details>
                      </Td>
                      {canManage ? <Td>{p.status !== 'CANCELLED' && p.status !== 'COMPLETED' ? <Button size="sm" variant="ghost" onClick={() => { setCancelling(p); setReason(''); cancel.reset(); }}>Cancel plan</Button> : null}</Td> : null}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : !q.error ? <p className="text-sm text-fg-muted">Loading payment plans…</p> : null}
      <Dialog open={!!offer} onOpenChange={(o) => !o && setOffer(null)} title={offer ? `Payment plan for ${offer.customer}` : 'Payment plan'} description="Agree the plan with the customer first. The amounts are worked out from what they owe today.">
        {offer ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); agree.mutate(); }}>
            <p className="text-sm">Overdue and not disputed: <Money value={offer.total} currency={c} /> on {offer.invoices.map((i) => i.number).join(', ')}.{offer.leftOut.length ? ` Left out as disputed: ${offer.leftOut.map((i) => i.number).join(', ')}.` : ''}</p>
            <Field label="Instalments">
              {(p) => (
                <Select {...p} value={instalments} onChange={(e) => setInstalments(e.target.value)}>
                  {Array.from({ length: 12 }, (_, k) => k + 1).map((n) => <option key={n} value={n}>{n}{n === offer.recommended ? ' (suggested)' : ''}</option>)}
                </Select>
              )}
            </Field>
            <Field label="First instalment due">{(p) => <Input {...p} type="date" value={first} min={d?.asOf} onChange={(e) => setFirst(e.target.value)} required />}</Field>
            <Field label="Note (optional)">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Who agreed it and how" />}</Field>
            <ErrorAlert title="Could not work out the plan" error={preview.error} />
            <Table aria-label="Instalment schedule">
              <thead><Tr><Th numeric>#</Th><Th>Due</Th><Th numeric>Amount</Th></Tr></thead>
              <tbody>{schedule.map((i) => <Tr key={i.no}><Td numeric>{i.no}</Td><Td>{date(i.dueDate)}</Td><Td numeric><Money value={i.amount} currency={c} /></Td></Tr>)}</tbody>
            </Table>
            <ErrorAlert title="Plan not agreed" error={agree.error} />
            <div className="flex gap-2"><Button type="submit" loading={agree.isPending} disabled={!!preview.error}>Agree plan</Button><Button type="button" variant="ghost" onClick={() => setOffer(null)}>Close</Button></div>
          </form>
        ) : null}
      </Dialog>
      <Dialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)} title={cancelling ? `Cancel ${cancelling.reference}` : 'Cancel plan'} description="The plan is kept as a record. The invoices stay owed in full until paid.">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
          <Field label="Why is it cancelled?">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={1000} required />}</Field>
          <ErrorAlert title="Not cancelled" error={cancel.error} />
          <div className="flex gap-2"><Button type="submit" variant="danger" loading={cancel.isPending}>Cancel plan</Button><Button type="button" variant="ghost" onClick={() => setCancelling(null)}>Keep it</Button></div>
        </form>
      </Dialog>
    </>
  );
}
