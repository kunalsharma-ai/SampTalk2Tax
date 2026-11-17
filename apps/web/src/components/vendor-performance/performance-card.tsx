'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { GRADE_TONE, pct, REVIEW_ASPECTS, SCORE_RULES, stars, type VendorPerformance, type VendorReview } from '@/lib/vendor-performance';

const OUTCOME = { ON_TIME: { label: 'On time', tone: 'positive' }, LATE: { label: 'Late', tone: 'warning' }, OVERDUE: { label: 'Overdue', tone: 'negative' } } as const;

function ReviewRow({ r, orgId, contactId, onDone }: { r: VendorReview; orgId: string; contactId: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const w = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/purchases/vendors/${contactId}/reviews/${r.id}/withdraw`, { method: 'POST', body: { reason } }),
    onSuccess: onDone,
  });
  return (
    <li className={`border-t border-line py-3 text-sm ${r.withdrawn ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span aria-label={`${r.rating} out of 5`} className="text-warning">{stars(r.rating)}</span>
        <Badge>{r.aspect}</Badge>
        {r.order ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders/${r.order.id}`}>{r.order.ref}</Link> : null}
        <span className="text-fg-muted">{r.by}, {date(r.reviewDate)}</span>
        {r.withdrawn ? <Badge tone="neutral">Withdrawn</Badge> : null}
        {r.mine && !r.withdrawn && !open ? <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Withdraw</Button> : null}
      </div>
      {r.note ? <p className="mt-1">{r.note}</p> : null}
      {r.withdrawn ? <p className="mt-1 text-xs text-fg-muted">Withdrawn by {r.withdrawn.by}, {dateTime(r.withdrawn.at)}: {r.withdrawn.reason}</p> : null}
      {open ? (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); w.mutate(); }}>
          <div className="min-w-64 flex-1"><Field label="Why withdraw it">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field></div>
          <Button type="submit" size="sm" loading={w.isPending}>Withdraw review</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <ErrorAlert title="Not withdrawn" error={w.error} />
        </form>
      ) : null}
    </li>
  );
}

/** On a vendor's page: their scorecard for the last twelve months, order deliveries and the team's reviews. */
export function VendorPerformanceCard({ orgId, contactId, currency }: { orgId: string; contactId: string; currency: string }) {
  const qc = useQueryClient();
  const key = ['vendor-performance', orgId, contactId];
  const q = useQuery({ queryKey: key, queryFn: () => api<VendorPerformance>(`/v1/orgs/${orgId}/purchases/vendors/${contactId}/performance`) });
  const [form, setForm] = useState({ aspect: 'Overall', rating: '4', note: '', orderId: '' });
  const add = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/purchases/vendors/${contactId}/reviews`, { method: 'POST', body: { aspect: form.aspect, rating: Number(form.rating), note: form.note || null, orderId: form.orderId || null } }),
    onSuccess: async () => {
      setForm({ aspect: 'Overall', rating: '4', note: '', orderId: '' });
      await qc.invalidateQueries({ queryKey: key });
    },
  });
  const d = q.data;
  if (!d) return <ErrorAlert title="Could not load vendor performance" error={q.error} />;
  const s = d.scorecard;
  return (
    <Card className="mt-6" role="region" aria-label="Vendor performance">
      <CardHeader
        title="Vendor performance"
        description={`From ${date(d.from)} to ${date(d.to)}: deliveries against expected dates, goods rejected, prices billed against the order, bills that needed differences accepted, and the team's reviews.`}
        actions={s.grade ? <Badge tone={GRADE_TONE[s.grade]}>Grade {s.grade} · {s.score}</Badge> : <Badge>Not enough to score</Badge>}
      />
      <div className="space-y-5 px-5 pb-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-fg-muted">On-time delivery</dt><dd className="num text-lg">{pct(s.delivery.onTimePercent)}</dd><dd className="text-xs text-fg-muted">{s.delivery.onTime} of {s.delivery.measured} {s.delivery.measured === 1 ? 'order' : 'orders'}{s.delivery.averageDaysLate ? `, late ones ${s.delivery.averageDaysLate} days on average` : ''}</dd></div>
          <div><dt className="text-fg-muted">Rejected on receipt</dt><dd className="num text-lg">{pct(s.quality.rejectedPercent)}</dd><dd className="text-xs text-fg-muted"><Money value={s.quality.rejectedValue} currency={currency} /> of <Money value={s.quality.receivedValue} currency={currency} /></dd></div>
          <div><dt className="text-fg-muted">Billing accuracy</dt><dd className="num text-lg">{pct(s.billing.accuracyPercent)}</dd><dd className="text-xs text-fg-muted">{s.billing.withAcceptedDifferences} of {s.billing.linkedBills} order bills needed differences accepted</dd></div>
          <div><dt className="text-fg-muted">Billed above order price</dt><dd className="num text-lg"><Money value={s.price.overcharge} currency={currency} /></dd><dd className="text-xs text-fg-muted">{s.price.linesAbovePrice} of {s.price.billedLines} lines; net {pct(s.price.variancePercent)}</dd></div>
          <div><dt className="text-fg-muted">Spend (before tax)</dt><dd className="num text-lg"><Money value={s.billing.spend} currency={currency} /></dd><dd className="text-xs text-fg-muted">{s.billing.bills} {s.billing.bills === 1 ? 'bill' : 'bills'}, {s.orders} {s.orders === 1 ? 'order' : 'orders'}</dd></div>
          <div><dt className="text-fg-muted">Vendor credits</dt><dd className="num text-lg"><Money value={s.billing.vendorCreditValue} currency={currency} /></dd><dd className="text-xs text-fg-muted">{s.billing.vendorCredits} {s.billing.vendorCredits === 1 ? 'credit' : 'credits'}</dd></div>
          <div><dt className="text-fg-muted">Team reviews</dt><dd className="num text-lg">{s.reviews.average ?? '—'}</dd><dd className="text-xs text-fg-muted">{s.reviews.count} {s.reviews.count === 1 ? 'review' : 'reviews'}</dd></div>
        </dl>
        {s.parts.length ? (
          <ul className="flex flex-wrap gap-2 text-xs" aria-label="Score parts">
            {s.parts.map((p) => <li key={p.key} className="rounded-full border border-line px-3 py-1">{p.label} <span className="num">{p.score}</span> × {p.weight}</li>)}
          </ul>
        ) : null}
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">How the score is worked out</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">{SCORE_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
        {s.delivery.detail.length ? (
          <Table>
            <thead><tr><Th>Order</Th><Th>Expected</Th><Th>Delivered</Th><Th>Outcome</Th><Th numeric>Days late</Th></tr></thead>
            <tbody>
              {s.delivery.detail.map((o) => (
                <Tr key={o.orderId}>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders/${o.orderId}`}>{o.ref}</Link></Td>
                  <Td>{date(o.expectedDate)}</Td>
                  <Td>{o.deliveredOn ? date(o.deliveredOn) : '—'}</Td>
                  <Td><Badge tone={OUTCOME[o.outcome].tone}>{OUTCOME[o.outcome].label}</Badge></Td>
                  <Td numeric className="num">{o.daysLate}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        <section aria-label="Reviews">
          <h3 className="text-sm font-medium">Reviews</h3>
          {d.reviews.length ? (
            <ul>{d.reviews.map((r) => <ReviewRow key={r.id} r={r} orgId={orgId} contactId={contactId} onDone={() => void qc.invalidateQueries({ queryKey: key })} />)}</ul>
          ) : <EmptyState title="No reviews yet">Rate how this vendor did on an order or overall.</EmptyState>}
          {d.can.review ? (
            <form className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-4" aria-label="Add a review" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
              <Field label="About">{(p) => <Select {...p} value={form.aspect} onChange={(e) => setForm({ ...form, aspect: e.target.value })}>{REVIEW_ASPECTS.map((a) => <option key={a}>{a}</option>)}</Select>}</Field>
              <Field label="Rating">{(p) => <Select {...p} value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value })}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} {stars(n)}</option>)}</Select>}</Field>
              <div className="sm:col-span-2"><Field label="Purchase order (optional)">{(p) => <Select {...p} value={form.orderId} onChange={(e) => setForm({ ...form, orderId: e.target.value })}><option value="">None</option>{d.orders.map((o) => <option key={o.id} value={o.id}>{o.ref} · {date(o.orderDate)}</option>)}</Select>}</Field></div>
              <div className="sm:col-span-4"><Field label="Note" hint="Needed for a rating of 1 or 2. Reviews are kept for good; you can withdraw your own.">{(p) => <Textarea {...p} rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field></div>
              <div className="sm:col-span-4 flex items-center gap-2"><Button type="submit" loading={add.isPending}>Add review</Button><ErrorAlert title="Not added" error={add.error} /></div>
            </form>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
