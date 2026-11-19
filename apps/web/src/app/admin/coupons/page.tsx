'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMeWithRole } from '@/lib/admin';

interface Coupon {
  id: string;
  code: string;
  description: string;
  kind: 'PERCENT' | 'AMOUNT';
  percentOff: string | null;
  amountOff: string | null;
  currency: string | null;
  planCodes: string[];
  intervals: ('MONTHLY' | 'ANNUAL')[];
  cycles: number | null;
  maxRedemptions: number | null;
  redeemBy: string | null;
  isActive: boolean;
  autoApply: boolean;
  terms: string;
  createdAt: string;
  organisations: { orgId: string; name: string; since: string; payments: number; discount: string; currency: string | null; stillUsing: boolean; paymentsLeft: number | null }[];
  discountGiven: { currency: string; amount: string }[];
}
interface PlanRow { code: string; name: string }

const blank = { code: '', description: '', kind: 'PERCENT' as 'PERCENT' | 'AMOUNT', percentOff: '', amountOff: '', currency: 'INR', planCodes: [] as string[], interval: '', cycles: '1', maxRedemptions: '', redeemBy: '', autoApply: false };

/** Platform administration → Coupons: money off subscription payments, entered by organisations at checkout. */
export default function AdminCouponsPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const q = useQuery({ queryKey: ['admin-coupons'], queryFn: () => api<Coupon[]>('/v1/admin/coupons') });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api<PlanRow[]>('/v1/admin/plans') });
  const [f, setF] = useState(blank);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-coupons'] });
  const create = useMutation({
    mutationFn: () =>
      api<Coupon>('/v1/admin/coupons', {
        method: 'POST',
        body: {
          code: f.code,
          description: f.description,
          kind: f.kind,
          percentOff: f.kind === 'PERCENT' ? f.percentOff : null,
          amountOff: f.kind === 'AMOUNT' ? f.amountOff : null,
          currency: f.kind === 'AMOUNT' ? f.currency : null,
          planCodes: f.planCodes,
          intervals: f.interval ? [f.interval] : [],
          cycles: f.cycles === 'ALL' ? null : Number(f.cycles),
          maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : null,
          redeemBy: f.redeemBy || null,
          autoApply: f.autoApply,
        },
      }),
    onSuccess: async () => { setF(blank); await refresh(); },
  });
  const active = useMutation({ mutationFn: (c: { id: string; active: boolean }) => api(`/v1/admin/coupons/${c.id}/active`, { method: 'POST', body: { active: c.active } }), onSuccess: refresh });
  const togglePlan = (code: string) => setF((x) => ({ ...x, planCodes: x.planCodes.includes(code) ? x.planCodes.filter((p) => p !== code) : [...x.planCodes, code] }));
  return (
    <>
      <PageHeader
        title="Coupons"
        description="Money off subscription payments, before GST. An organisation enters the code at checkout; once paid, the coupon stays with its subscription for the payments it covers, renewals included. Terms cannot change once a coupon exists; switch it off and create another instead."
      />
      {manage ? (
        <Card className="mb-6" aria-label="New coupon">
          <CardHeader title="New coupon" description="A percentage off works in any currency; an amount off is for one currency. A coupon never takes a payment to nothing: give a complimentary subscription instead." />
          <form className="grid gap-4 px-5 pb-5 pt-4 sm:grid-cols-2 xl:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Code" hint="3 to 20 letters, digits or hyphens">{(p) => <Input {...p} className="uppercase" maxLength={20} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}</Field>
            <Field label="Description (optional)">{(p) => <Input {...p} maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
            <Field label="Money off">{(p) => <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'PERCENT' | 'AMOUNT' })}><option value="PERCENT">A percentage</option><option value="AMOUNT">A fixed amount</option></Select>}</Field>
            {f.kind === 'PERCENT' ? (
              <Field label="Percentage off">{(p) => <Input {...p} inputMode="decimal" value={f.percentOff} onChange={(e) => setF({ ...f, percentOff: e.target.value })} />}</Field>
            ) : (
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Field label="Amount off">{(p) => <Input {...p} inputMode="decimal" value={f.amountOff} onChange={(e) => setF({ ...f, amountOff: e.target.value })} />}</Field>
                <Field label="Currency">{(p) => <Select {...p} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>INR</option><option>USD</option></Select>}</Field>
              </div>
            )}
            <Field label="Payments it takes money off">{(p) => <Select {...p} value={f.cycles} onChange={(e) => setF({ ...f, cycles: e.target.value })}><option value="1">The first payment</option>{[2, 3, 6, 12].map((n) => <option key={n} value={n}>The first {n} payments</option>)}<option value="ALL">Every payment</option></Select>}</Field>
            <Field label="Billing">{(p) => <Select {...p} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="">Monthly or annual</option><option value="MONTHLY">Monthly only</option><option value="ANNUAL">Annual only</option></Select>}</Field>
            <Field label="Organisations that can use it" hint="Empty for no limit">{(p) => <Input {...p} inputMode="numeric" value={f.maxRedemptions} onChange={(e) => setF({ ...f, maxRedemptions: e.target.value })} />}</Field>
            <Field label="Use by (optional)" hint="New organisations can start using it until the end of this day">{(p) => <Input {...p} type="date" value={f.redeemBy} onChange={(e) => setF({ ...f, redeemBy: e.target.value })} />}</Field>
            <fieldset className="text-sm sm:col-span-2 xl:col-span-4">
              <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">For plans (none ticked: every plan)</legend>
              {plans.data?.map((p) => (
                <label key={p.code} className="mr-4 inline-flex items-center gap-2"><input type="checkbox" checked={f.planCodes.includes(p.code)} onChange={() => togglePlan(p.code)} /> {p.name}</label>
              ))}
            </fieldset>
            <label className="inline-flex items-center gap-2 text-sm sm:col-span-2 xl:col-span-4"><input type="checkbox" checked={f.autoApply} onChange={(e) => setF({ ...f, autoApply: e.target.checked })} /> Apply automatically at checkout: a promotion, no code needed, shown beside the plans</label>
            <div className="sm:col-span-2 xl:col-span-4"><ErrorAlert title="Coupon not created" error={create.error} /></div>
            <div className="sm:col-span-2 xl:col-span-4"><Button type="submit" loading={create.isPending} disabled={!f.code}>Create coupon</Button></div>
          </form>
        </Card>
      ) : null}

      <Card aria-label="Coupons">
        <CardHeader title="Coupons" description="Each coupon with the organisations using it and the money it has taken off paid invoices." />
        <ErrorAlert title="Could not load the coupons" error={q.error ?? active.error} />
        {q.data?.length ? (
          <div className="overflow-x-auto">
            <Table aria-label="Coupon list">
              <thead>
                <tr><Th>Code</Th><Th>Terms</Th><Th>For</Th><Th>Organisations</Th><Th numeric>Taken off</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr>
              </thead>
              <tbody>
                {q.data.map((c) => (
                  <Tr key={c.id}>
                    <Td className="align-top">
                      <span className="font-mono font-medium">{c.code}</span>{c.autoApply ? <Badge className="ml-2" tone="violet">Promotion</Badge> : null}
                      {c.description ? <p className="text-xs text-fg-muted">{c.description}</p> : null}
                    </Td>
                    <Td className="align-top text-sm">{c.terms}</Td>
                    <Td className="align-top text-sm">
                      {c.planCodes.length ? c.planCodes.join(', ') : 'Every plan'}
                      {c.intervals.length ? `, ${c.intervals.map((i) => (i === 'ANNUAL' ? 'annual' : 'monthly')).join(' or ')} billing` : ''}
                      {c.redeemBy ? <p className="text-xs text-fg-faint">Use by {dateTime(c.redeemBy)}</p> : null}
                    </Td>
                    <Td className="align-top text-sm">
                      <p>{c.organisations.length}{c.maxRedemptions !== null ? ` of ${c.maxRedemptions}` : ''}</p>
                      <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
                        {c.organisations.map((o) => (
                          <li key={o.orgId}>{o.name}: {o.payments} payment{o.payments === 1 ? '' : 's'}, {o.currency ? <Money value={o.discount} currency={o.currency} /> : 'nothing yet'}{o.stillUsing && o.paymentsLeft !== null ? `, ${o.paymentsLeft} left` : !o.stillUsing ? ', moved to another coupon' : ''}</li>
                        ))}
                      </ul>
                    </Td>
                    <Td numeric className="align-top">{c.discountGiven.length ? c.discountGiven.map((g) => <div key={g.currency}><Money value={g.amount} currency={g.currency} /></div>) : '—'}</Td>
                    <Td className="align-top"><Badge tone={c.isActive ? 'positive' : 'neutral'}>{c.isActive ? 'On offer' : 'Switched off'}</Badge></Td>
                    <Td className="align-top text-right">
                      {manage ? <Button size="sm" variant="ghost" loading={active.isPending && active.variables?.id === c.id} onClick={() => active.mutate({ id: c.id, active: !c.isActive })}>{c.isActive ? 'Switch off' : 'Switch on'}</Button> : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : q.data ? (
          <EmptyState title="No coupons yet">Create one above; organisations enter its code when they pay for a plan.</EmptyState>
        ) : null}
      </Card>
    </>
  );
}
