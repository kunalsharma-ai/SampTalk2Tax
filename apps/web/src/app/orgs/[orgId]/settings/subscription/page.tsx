'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Input, Table, Td, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, SubscriptionAccess } from '@/lib/types';

interface Plan {
  code: string;
  name: string;
  description: string;
  price: { currency: string; monthly: string; annual: string };
  limits: { members: number | null; aiCreditsPerMonth: number | null; documentUploadsPerMonth: number | null };
  features: string[];
}
interface Sub {
  plan: Plan;
  status: 'TRIALING' | 'ACTIVE' | 'CANCELLED' | 'COMPLIMENTARY';
  access: SubscriptionAccess;
  billingInterval: 'MONTHLY' | 'ANNUAL' | null;
  currency: string;
  price: string | null;
  addOns: string[];
  features: string[];
  addOnOffers: { feature: string; label: string; monthly: string; annual: string }[];
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  request: { plan: Plan; interval: 'MONTHLY' | 'ANNUAL'; addOns: string[]; at: string } | null;
  coupon: { code: string; description: string; terms: string; paymentsUsed: number; paymentsLeft: number | null } | null;
  contract: { reference: string; interval: 'MONTHLY' | 'ANNUAL'; currency: string; price: string; startsOn: string; lastDay: string; limits: Record<string, number> } | null;
  promotions: { code: string; description: string; terms: string; planCodes: string[]; intervals: string[]; redeemBy: string | null }[];
  usage: { members: number; openInvitations: number };
  plans: Plan[];
  featureLabels: Record<string, string>;
  history: { kind: string; at: string; data: Record<string, unknown> }[];
}
interface Quote {
  kind: 'NEW' | 'RENEWAL' | 'UPGRADE' | 'SCHEDULED';
  reason?: string;
  plan: Plan;
  interval: 'MONTHLY' | 'ANNUAL';
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
  addOns?: string[];
  addOnLines?: { feature: string; label: string; price: string }[];
  listPrice?: string;
  amount?: string;
  discount?: string;
  coupon?: { code: string; description: string; terms: string; continuing: boolean; promotion: boolean } | null;
  couponNote?: string | null;
  subtotal?: string;
  lines?: { code: string; rate: string; amount: string }[];
  total?: string;
  note?: string;
  payOnline?: boolean;
}
interface SubscriptionInvoice {
  id: string;
  creditPack?: { name: string; requests: number } | null;
  reference: string;
  number: string | null;
  kind: 'NEW' | 'RENEWAL' | 'UPGRADE' | 'CREDITS';
  status: 'OPEN' | 'PAID' | 'VOID';
  plan: { code: string; name: string };
  billingInterval: 'MONTHLY' | 'ANNUAL';
  periodStart: string;
  periodEnd: string;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  voidReason: string | null;
  checkout: { url: string; expiresAt: string | null } | null;
}
interface Checkout { scheduled: boolean; reason: string | null; url: string | null }

const STATE: Record<string, { label: string; tone: 'positive' | 'warning' | 'negative' | 'neutral' | 'violet' }> = {
  TRIAL: { label: 'Free trial', tone: 'violet' },
  ACTIVE: { label: 'Active', tone: 'positive' },
  GRACE: { label: 'Payment due', tone: 'warning' },
  CANCELLING: { label: 'Cancelled, running to period end', tone: 'warning' },
  COMPLIMENTARY: { label: 'Complimentary', tone: 'positive' },
  TRIAL_ENDED: { label: 'Trial ended: read only', tone: 'negative' },
  LAPSED: { label: 'Lapsed: read only', tone: 'negative' },
  CANCELLED: { label: 'Cancelled: read only', tone: 'negative' },
};
const EVENT: Record<string, string> = {
  TRIAL_STARTED: 'Trial started',
  TRIAL_EXTENDED: 'Trial extended',
  PLAN_REQUESTED: 'Plan requested',
  REQUEST_WITHDRAWN: 'Request withdrawn',
  ACTIVATED: 'Plan activated',
  CANCELLED: 'Cancelled',
  COMPLIMENTARY: 'Made complimentary',
  INVOICE_ISSUED: 'Invoice issued',
  INVOICE_VOIDED: 'Invoice voided',
  CHECKOUT_STARTED: 'Payment started',
  PAYMENT_RECEIVED: 'Payment received',
  PAYMENT_MISMATCH: 'Payment not applied (amount differs)',
  PAYMENT_ON_VOID_INVOICE: 'Payment on a replaced invoice',
  CONTRACT_STARTED: 'Enterprise contract started',
  CONTRACT_ENDED: 'Enterprise contract ended',
  AI_CREDITS_ADDED: 'Extra AI requests added',
  REMINDER_UPCOMING: 'Renewal reminder',
  REMINDER_DUE: 'Payment due reminder',
  REMINDER_FINAL: 'Final reminder',
  REMINDER_LAPSED: 'Read-only notice',
};
const KIND: Record<string, string> = { NEW: 'New plan', RENEWAL: 'Renewal', UPGRADE: 'Upgrade', CREDITS: 'Extra AI requests' };
const INVOICE_TONE = { OPEN: 'warning', PAID: 'positive', VOID: 'neutral' } as const;
const limit = (n: number | null, unit: string) => (n === null ? `Unlimited ${unit}` : `${n.toLocaleString('en-IN')} ${unit}`);

export default function SubscriptionPage() {
  return (
    <Suspense>
      <Subscription />
    </Suspense>
  );
}

function Subscription() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [interval, setInterval] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY');
  const q = useQuery({ queryKey: ['subscription', orgId], queryFn: () => api<Sub>(`/v1/orgs/${orgId}/subscription`) });
  const done = async () => { await qc.invalidateQueries({ queryKey: ['subscription', orgId] }); await qc.invalidateQueries({ queryKey: ['orgs'] }); };
  const request = useMutation({ mutationFn: (plan: string) => api(`/v1/orgs/${orgId}/subscription/request`, { method: 'POST', body: { plan, interval, addOns: extras } }), onSuccess: done });
  const withdraw = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/subscription/request`, { method: 'DELETE' }), onSuccess: done });
  const invoices = useQuery({ queryKey: ['subscription-invoices', orgId], queryFn: () => api<SubscriptionInvoice[]>(`/v1/orgs/${orgId}/subscription/invoices`) });
  const [choice, setChoice] = useState<string | null>(null);
  // Add-on modules chosen with the plan (SUBS-017).
  const [extras, setExtras] = useState<string[]>([]);
  // The coupon code being typed, and the one the price is worked out with.
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState('');
  const quote = useQuery({ queryKey: ['subscription-quote', orgId, choice, interval, coupon, extras.join()], queryFn: () => api<Quote>(`/v1/orgs/${orgId}/subscription/quote?plan=${choice}&interval=${interval}${coupon ? `&coupon=${encodeURIComponent(coupon)}` : ''}${extras.length ? `&addOns=${extras.join(',')}` : ''}`), enabled: !!choice, retry: false });
  const all = async () => { await done(); await qc.invalidateQueries({ queryKey: ['subscription-invoices', orgId] }); };
  const checkout = useMutation({
    mutationFn: (plan: string) => api<Checkout>(`/v1/orgs/${orgId}/subscription/checkout`, { method: 'POST', body: { plan, interval, coupon: coupon || null, addOns: extras } }),
    onSuccess: async (r) => {
      if (r.url) window.location.assign(r.url);
      else { setChoice(null); await all(); }
    },
  });
  const pay = useMutation({ mutationFn: (id: string) => api<{ url: string }>(`/v1/orgs/${orgId}/subscription/invoices/${id}/pay`, { method: 'POST' }), onSuccess: (r) => window.location.assign(r.url) });
  // Coming back from the gateway's payment page: ask it whether the payment went through.
  const params = useSearchParams();
  const router = useRouter();
  const returned = params.get('invoice');
  const cancelled = params.get('cancelled') === '1';
  const check = useMutation({ mutationFn: (id: string) => api<{ invoice: SubscriptionInvoice; state: string }>(`/v1/orgs/${orgId}/subscription/invoices/${id}/check`, { method: 'POST' }), onSuccess: all });
  const { mutate: checkNow } = check;
  useEffect(() => {
    if (returned && !cancelled) checkNow(returned);
  }, [returned, cancelled, checkNow]);
  if (!org) return null;
  const s = q.data;
  const manage = can(org.role, 'org.manage');
  const state = s ? STATE[s.access.state] : null;
  return (
    <>
      <PageHeader
        title="Subscription"
        description="Your Talk2Tax plan, what it includes and how much of it you use. This is the bill for Talk2Tax itself and never appears in your books. Reading and exporting your records is never blocked, whatever the plan."
      />
      <ErrorAlert title="Could not load the subscription" error={q.error} />
      {s && state ? (
        <>
          <Card className="mb-6" aria-label="Current plan">
            <CardHeader title={`${s.plan.name} plan`} description={s.plan.description} />
            <div className="grid gap-4 px-5 pb-5 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-fg-faint">Status</p>
                <p className="mt-1"><Badge tone={state.tone}>{state.label}</Badge></p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-fg-faint">{s.access.level === 'FULL' && s.access.until ? (s.access.state === 'TRIAL' ? 'Trial ends' : s.access.state === 'GRACE' ? 'Read-only from' : 'Paid until') : s.access.level === 'READ_ONLY' ? 'Read-only since' : 'Ends'}</p>
                <p className="mt-1 font-medium">
                  {s.access.level === 'FULL' ? (s.access.until ? `${dateTime(s.access.until)} (${s.access.daysLeft} days)` : 'No end') : s.access.since ? dateTime(s.access.since) : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-fg-faint">Price</p>
                <p className="mt-1 font-medium">{s.price ? <><Money value={s.price} currency={s.currency} /> {s.billingInterval === 'ANNUAL' ? 'a year' : 'a month'}</> : s.status === 'TRIALING' ? 'Free during the trial' : '—'}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-fg-faint">Members</p>
                <p className="mt-1 font-medium" data-testid="member-usage">
                  {s.usage.members}{s.plan.limits.members !== null ? ` of ${s.plan.limits.members}` : ''}{s.usage.openInvitations ? ` (+${s.usage.openInvitations} invited)` : ''}
                </p>
              </div>
            </div>
            {s.addOns.length ? (
              <p className="border-t border-line px-5 py-3 text-sm" data-testid="subscription-add-ons">
                <span className="font-medium">Add-ons:</span> {s.addOns.map((f) => s.featureLabels[f] ?? f).join(', ')}
              </p>
            ) : null}
            {s.coupon ? (
              <p className="border-t border-line px-5 py-3 text-sm" data-testid="subscription-coupon">
                <Badge tone="violet">Coupon {s.coupon.code}</Badge> <span className="ml-1">{s.coupon.terms}{s.coupon.description ? ` (${s.coupon.description})` : ''}: used on {s.coupon.paymentsUsed} payment{s.coupon.paymentsUsed === 1 ? '' : 's'}{s.coupon.paymentsLeft === null ? ', and on every renewal' : s.coupon.paymentsLeft ? `, ${s.coupon.paymentsLeft} more to come` : ', none left'}.</span>
              </p>
            ) : null}
            {s.access.level === 'READ_ONLY' ? (
              <div className="px-5 pb-5"><Alert tone="warning" title="Read only">Your records can be read and exported. Choose a plan below to make changes again.</Alert></div>
            ) : null}
          </Card>

          {returned ? (
            <div className="mb-6" aria-label="Payment result">
              {cancelled ? (
                <Alert tone="warning" title="Payment cancelled">Nothing was charged. You can pay again below whenever you are ready.</Alert>
              ) : check.data?.state === 'paid' ? (
                <Alert tone="positive" title="Payment received">
                  Tax invoice {check.data.invoice.number} for <Money value={check.data.invoice.total} currency={check.data.invoice.currency} />. {check.data.invoice.plan.name} runs until {dateTime(s.currentPeriodEnd ?? check.data.invoice.periodEnd)}.{' '}
                  <Link className="underline" href={`/orgs/${orgId}/settings/subscription/invoices/${check.data.invoice.id}`}>View the invoice</Link>
                </Alert>
              ) : check.data ? (
                <Alert tone="warning" title="Waiting for the payment to be confirmed">
                  The payment gateway has not confirmed the payment yet ({check.data.state}). This usually takes a few seconds.{' '}
                  <Button variant="ghost" size="sm" loading={check.isPending} onClick={() => check.mutate(returned)}>Check again</Button>
                </Alert>
              ) : (
                <ErrorAlert title="Could not check the payment" error={check.error} />
              )}
              <button type="button" className="mt-2 text-xs text-fg-muted underline" onClick={() => router.replace(`/orgs/${orgId}/settings/subscription`)}>Dismiss</button>
            </div>
          ) : null}

          {s.request ? (
            <div className="mb-6">
              <Alert tone="warning" title={`${s.request.plan.name} ${s.status === 'ACTIVE' ? 'from the renewal' : 'requested'}, billed ${s.request.interval === 'ANNUAL' ? 'annually' : 'monthly'}`}>
                {s.status === 'ACTIVE' && s.currentPeriodEnd ? <>Your current plan runs to {dateTime(s.currentPeriodEnd)}; the renewal is for {s.request.plan.name}, <Money value={s.request.interval === 'ANNUAL' ? s.request.plan.price.annual : s.request.plan.price.monthly} currency={s.currency} /> {s.request.interval === 'ANNUAL' ? 'a year' : 'a month'} plus tax.</> : <>Requested {dateTime(s.request.at)}: <Money value={s.request.interval === 'ANNUAL' ? s.request.plan.price.annual : s.request.plan.price.monthly} currency={s.currency} /> {s.request.interval === 'ANNUAL' ? 'a year' : 'a month'}. Talk2Tax activates it when payment is received.</>}{' '}
                {manage ? <Button variant="ghost" size="sm" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw</Button> : null}
              </Alert>
            </div>
          ) : null}

          {invoices.data?.some((i) => i.status === 'OPEN') ? (
            <div className="mb-6">
              {invoices.data.filter((i) => i.status === 'OPEN').map((i) => (
                <Alert key={i.id} tone="warning" title={i.kind === 'CREDITS' ? `${KIND.CREDITS} to pay: ${i.creditPack?.name ?? ''}` : `${KIND[i.kind]} to pay: ${i.plan.name}, ${dateTime(i.periodStart)} to ${dateTime(i.periodEnd)}`}>
                  Payment request {i.reference} for <Money value={i.total} currency={i.currency} /> including tax, due {dateTime(i.dueAt)}.{' '}
                  {manage ? <Button size="sm" loading={pay.isPending} onClick={() => pay.mutate(i.id)}>Pay now</Button> : null}
                </Alert>
              ))}
              <ErrorAlert title="Could not start the payment" error={pay.error} />
            </div>
          ) : null}

          {s.contract ? (
            <div className="mb-6">
              <Alert tone="accent" title={`Enterprise contract ${s.contract.reference}`}>
                Your plan, price and limits are set by this contract from {date(s.contract.startsOn)} to {date(s.contract.lastDay)}: <Money value={s.contract.price} currency={s.contract.currency} /> {s.contract.interval === 'ANNUAL' ? 'a year' : 'a month'} plus tax, invoiced at each renewal. To change them, write to your Talk2Tax account manager.
              </Alert>
            </div>
          ) : (
          <Card className="mb-6" aria-label="Plans">
            <CardHeader
              title="Plans"
              description={`Prices in ${s.currency}, before any tax on the subscription. Annual billing costs ten months. Proposed launch prices: they may change before general availability.`}
            />
            <div className="flex gap-2 px-5 pt-4" role="group" aria-label="Billing">
              {(['MONTHLY', 'ANNUAL'] as const).map((i) => (
                <button key={i} type="button" aria-pressed={interval === i} onClick={() => setInterval(i)} className={cn('rounded-full border px-3 py-1 text-sm', interval === i ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted hover:text-fg')}>
                  {i === 'MONTHLY' ? 'Monthly' : 'Annual'}
                </button>
              ))}
            </div>
            <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-4">
              {s.plans.map((p) => {
                const current = p.code === s.plan.code && s.status !== 'TRIALING';
                const requested = s.request?.plan.code === p.code && s.request.interval === interval;
                return (
                  <section key={p.code} aria-label={`${p.name} plan`} className={cn('flex flex-col rounded-[var(--t2t-radius-lg)] border p-4', current ? 'border-accent' : 'border-line')}>
                    <h3 className="text-base font-semibold">{p.name} {current ? <Badge tone="positive">Current</Badge> : null}</h3>
                    <p className="mt-1 text-sm text-fg-muted">{p.description}</p>
                    <p className="mt-3 text-2xl font-semibold"><Money value={interval === 'MONTHLY' ? p.price.monthly : p.price.annual} currency={s.currency} /></p>
                    <p className="text-xs text-fg-faint">{interval === 'MONTHLY' ? 'a month' : 'a year'}</p>
                    {s.promotions.filter((o) => (!o.planCodes.length || o.planCodes.includes(p.code)) && (!o.intervals.length || o.intervals.includes(interval))).slice(0, 1).map((o) => (
                      <p key={o.code} className="mt-2 rounded bg-accent/10 px-2 py-1 text-xs" data-testid="plan-offer"><span className="font-medium">Offer:</span> {o.terms}{o.description ? ` (${o.description})` : ''}{o.redeemBy ? `, until ${dateTime(o.redeemBy)}` : ''}. Taken off at checkout.</p>
                    ))}
                    <ul className="mt-3 flex-1 space-y-1 text-sm">
                      <li>{limit(p.limits.members, 'members')}</li>
                      <li>{p.limits.aiCreditsPerMonth === null ? (p.features.includes('AI') ? 'Unlimited AI requests' : 'No AI requests') : `${p.limits.aiCreditsPerMonth.toLocaleString('en-IN')} AI requests a month`}</li>
                      <li>{limit(p.limits.documentUploadsPerMonth, 'uploads a month')}</li>
                      {Object.entries(s.featureLabels).map(([k, label]) => (
                        <li key={k} className={p.features.includes(k) ? '' : 'text-fg-faint line-through'}>{label}</li>
                      ))}
                    </ul>
                    {manage && s.status !== 'COMPLIMENTARY' ? (
                      <Button className="mt-4" variant={choice === p.code ? 'secondary' : requested ? 'secondary' : 'primary'} disabled={requested || (current && s.billingInterval === interval && s.access.state === 'ACTIVE' && !invoices.data?.length && !s.addOnOffers.length)} onClick={() => { setChoice(p.code); setExtras(s.addOns.filter((f) => !p.features.includes(f))); }}>
                        {requested ? (s.status === 'ACTIVE' ? 'Chosen for the renewal' : 'Requested') : current && s.billingInterval === interval ? (s.access.state === 'ACTIVE' ? (s.addOnOffers.length ? 'Renew or change add-ons' : 'Renew early') : 'Renew') : `Choose ${p.name}`}
                      </Button>
                    ) : null}
                  </section>
                );
              })}
            </div>
            {choice ? (
              <div className="mx-5 mb-5 rounded-[var(--t2t-radius-lg)] border border-accent/60 bg-accent/5 p-4" aria-label="Checkout">
                <form className="mb-3 flex flex-wrap items-end gap-2 text-sm" aria-label="Coupon" onSubmit={(e) => { e.preventDefault(); setCoupon(code.trim().toUpperCase()); }}>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">Coupon code</span>
                    <Input className="w-48 uppercase" maxLength={20} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Optional" />
                  </label>
                  <Button type="submit" variant="secondary" size="sm" disabled={!code.trim() || code.trim().toUpperCase() === coupon}>Apply</Button>
                  {coupon ? <Button type="button" variant="ghost" size="sm" onClick={() => { setCoupon(''); setCode(''); }}>Remove coupon</Button> : null}
                </form>
                {(() => {
                  const chosen = s.plans.find((p) => p.code === choice);
                  const offers = s.addOnOffers.filter((o) => !chosen?.features.includes(o.feature));
                  return offers.length ? (
                    <fieldset className="mb-3 text-sm" aria-label="Add-on modules">
                      <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Add modules {chosen?.name} does not include</legend>
                      {offers.map((o) => (
                        <label key={o.feature} className="mr-5 inline-flex items-center gap-2">
                          <input type="checkbox" checked={extras.includes(o.feature)} onChange={(e) => setExtras(e.target.checked ? [...extras, o.feature] : extras.filter((f) => f !== o.feature))} />
                          {o.label} <span className="text-fg-muted">(+<Money value={interval === 'ANNUAL' ? o.annual : o.monthly} currency={s.currency} /> {interval === 'ANNUAL' ? 'a year' : 'a month'})</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : null;
                })()}
                <ErrorAlert title={coupon ? 'Coupon not applied' : 'Could not price the plan'} error={quote.error} />
                {quote.data ? (
                  quote.data.kind === 'SCHEDULED' ? (
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <p className="flex-1"><span className="font-medium">{quote.data.plan.name}, billed {interval === 'ANNUAL' ? 'annually' : 'monthly'}.</span> {quote.data.reason}. Nothing is charged now.</p>
                      <Button loading={checkout.isPending} onClick={() => checkout.mutate(quote.data!.plan.code)}>Switch at the renewal</Button>
                      <Button variant="ghost" onClick={() => setChoice(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="grid gap-4 text-sm md:grid-cols-[1fr_auto]">
                      <div>
                        <p className="font-medium">{quote.data.plan.name}, billed {interval === 'ANNUAL' ? 'annually' : 'monthly'}: {quote.data.kind === 'UPGRADE' ? 'upgrade now, charged for the days left in this period' : quote.data.kind === 'RENEWAL' ? 'the next period, straight after this one' : s.status === 'TRIALING' && s.access.level === 'FULL' ? 'starts when your trial ends, so no trial days are lost' : 'starts today'}</p>
                        <p className="text-fg-muted">{dateTime(quote.data.periodStart!)} to {dateTime(quote.data.periodEnd!)}</p>
                        <table className="mt-2 w-full max-w-sm text-sm" aria-label="Amount">
                          <tbody>
                            <tr><td>Subscription{quote.data.addOnLines?.length ? <span className="block text-xs text-fg-muted">{quote.data.kind === 'UPGRADE' ? 'The difference for the days left, with ' : `${quote.data.plan.name} with `}{quote.data.addOnLines.map((l) => `${l.label} (+${l.price})`).join(', ')}</span> : null}</td><td className="text-right num align-top"><Money value={quote.data.amount!} currency={quote.data.currency!} /></td></tr>
                            {quote.data.coupon ? (
                              <>
                                <tr><td>{quote.data.coupon.promotion ? 'Offer' : 'Coupon'} {quote.data.coupon.code} <span className="text-xs text-fg-muted">({quote.data.coupon.terms})</span></td><td className="text-right num">−<Money value={quote.data.discount!} currency={quote.data.currency!} /></td></tr>
                                <tr className="border-t border-line"><td>Taxable value</td><td className="text-right num"><Money value={quote.data.subtotal!} currency={quote.data.currency!} /></td></tr>
                              </>
                            ) : null}
                            {quote.data.lines!.map((l) => <tr key={l.code}><td>{l.code} {l.rate}%</td><td className="text-right num"><Money value={l.amount} currency={quote.data!.currency!} /></td></tr>)}
                            <tr className="border-t border-line font-semibold"><td>Total</td><td className="text-right num"><Money value={quote.data.total!} currency={quote.data.currency!} /></td></tr>
                          </tbody>
                        </table>
                        {quote.data.note ? <p className="mt-1 text-xs text-fg-faint">{quote.data.note}</p> : null}
                        {quote.data.couponNote ? <p className="mt-1 text-xs text-fg-muted">Your coupon is not used on this payment: {quote.data.couponNote}.</p> : null}
                      </div>
                      <div className="flex flex-col items-stretch gap-2 md:w-56">
                        {quote.data.payOnline ? (
                          <Button loading={checkout.isPending} onClick={() => checkout.mutate(quote.data!.plan.code)}>Pay <Money value={quote.data.total!} currency={quote.data.currency!} /> now</Button>
                        ) : (
                          <>
                            <p className="text-xs text-fg-muted">Online payment in {quote.data.currency} is not set up yet. Request the plan and Talk2Tax sends payment details.</p>
                            <Button loading={request.isPending} onClick={() => request.mutate(quote.data!.plan.code, { onSuccess: () => setChoice(null) })}>Request {quote.data.plan.name}</Button>
                          </>
                        )}
                        <Button variant="ghost" onClick={() => setChoice(null)}>Cancel</Button>
                        <p className="text-xs text-fg-faint">You pay on the payment provider’s page; card and UPI details never reach Talk2Tax.</p>
                      </div>
                    </div>
                  )
                ) : quote.isLoading ? <p className="text-sm text-fg-muted">Working out the price…</p> : null}
              </div>
            ) : null}
            <div className="px-5 pb-5"><ErrorAlert title="Plan not changed" error={checkout.error ?? request.error ?? withdraw.error} /></div>
            {!manage ? <p className="px-5 pb-5 text-sm text-fg-muted">Owners and admins choose the plan.</p> : null}
          </Card>
          )}

          <Card className="mb-6" aria-label="Invoices">
            <CardHeader title="Invoices" description="Payment requests and the tax invoices for what you paid. Prices exclude tax; GST is added for organisations in India." />
            {invoices.data?.length ? (
              <Table>
                <thead><tr><Th>Number</Th><Th>For</Th><Th>Period</Th><Th numeric>Total</Th><Th>Status</Th><Th><span className="sr-only">Open</span></Th></tr></thead>
                <tbody>
                  {invoices.data.map((i) => (
                    <Tr key={i.id}>
                      <Td className="num">{i.number ?? i.reference}</Td>
                      <Td>{i.kind === 'CREDITS' ? `${KIND.CREDITS}: ${i.creditPack?.name ?? ''}` : `${KIND[i.kind]}: ${i.plan.name}, ${i.billingInterval === 'ANNUAL' ? 'annual' : 'monthly'}`}</Td>
                      <Td className="whitespace-nowrap text-sm">{dateTime(i.periodStart)} to {dateTime(i.periodEnd)}</Td>
                      <Td numeric><Money value={i.total} currency={i.currency} /></Td>
                      <Td><Badge tone={INVOICE_TONE[i.status]}>{i.status === 'OPEN' ? 'To pay' : i.status === 'PAID' ? `Paid ${dateTime(i.paidAt!)}` : 'Void'}</Badge></Td>
                      <Td className="text-right"><Link className="text-sm underline" href={`/orgs/${orgId}/settings/subscription/invoices/${i.id}`}>{i.status === 'PAID' ? 'Tax invoice' : 'View'}</Link></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : invoices.data ? <p className="px-5 pb-5 pt-3 text-sm text-fg-muted">No invoices yet.</p> : null}
          </Card>

          <Card aria-label="Subscription history">
            <CardHeader title="History" />
            <Table>
              <thead><tr><Th>When</Th><Th>What</Th><Th>Details</Th></tr></thead>
              <tbody>
                {s.history.map((h, i) => (
                  <Tr key={i}>
                    <Td className="whitespace-nowrap">{dateTime(h.at)}</Td>
                    <Td>{EVENT[h.kind] ?? h.kind}</Td>
                    <Td className="text-sm text-fg-muted">{[h.data.contract ? `contract ${String(h.data.contract)}` : null, h.data.pack ? `${String(h.data.pack)}` : null, h.data.plan, h.data.interval, h.data.price ? `${h.data.price} ${h.data.currency ?? ''}` : null, h.data.paymentReference ? `ref ${h.data.paymentReference}` : null, h.data.invoice ? String(h.data.invoice) : null, h.data.number ? String(h.data.number) : null, h.data.total ? `${h.data.total} ${h.data.currency ?? ''}` : null, h.data.coupon ? `coupon ${String(h.data.coupon)} −${String(h.data.discount)}` : null, h.data.gateway ? String(h.data.gateway).toLowerCase() : null, h.data.stage ? (h.data.emailed ? 'emailed' : `not emailed${h.data.error ? `: ${h.data.error}` : ''}`) : null, h.data.reason, h.data.days ? `${h.data.days} days` : null].filter(Boolean).join(' · ')}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : null}
    </>
  );
}
