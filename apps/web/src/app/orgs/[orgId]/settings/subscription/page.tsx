'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th, Tr, cn } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
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
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  request: { plan: Plan; interval: 'MONTHLY' | 'ANNUAL'; at: string } | null;
  usage: { members: number; openInvitations: number };
  plans: Plan[];
  featureLabels: Record<string, string>;
  history: { kind: string; at: string; data: Record<string, unknown> }[];
}

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
};
const limit = (n: number | null, unit: string) => (n === null ? `Unlimited ${unit}` : `${n.toLocaleString('en-IN')} ${unit}`);

export default function SubscriptionPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [interval, setInterval] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY');
  const q = useQuery({ queryKey: ['subscription', orgId], queryFn: () => api<Sub>(`/v1/orgs/${orgId}/subscription`) });
  const done = async () => { await qc.invalidateQueries({ queryKey: ['subscription', orgId] }); await qc.invalidateQueries({ queryKey: ['orgs'] }); };
  const request = useMutation({ mutationFn: (plan: string) => api(`/v1/orgs/${orgId}/subscription/request`, { method: 'POST', body: { plan, interval } }), onSuccess: done });
  const withdraw = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/subscription/request`, { method: 'DELETE' }), onSuccess: done });
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
            {s.access.level === 'READ_ONLY' ? (
              <div className="px-5 pb-5"><Alert tone="warning" title="Read only">Your records can be read and exported. Choose a plan below to make changes again.</Alert></div>
            ) : null}
          </Card>

          {s.request ? (
            <div className="mb-6">
              <Alert tone="warning" title={`${s.request.plan.name} requested, billed ${s.request.interval === 'ANNUAL' ? 'annually' : 'monthly'}`}>
                Requested {dateTime(s.request.at)}: <Money value={s.request.interval === 'ANNUAL' ? s.request.plan.price.annual : s.request.plan.price.monthly} currency={s.currency} /> {s.request.interval === 'ANNUAL' ? 'a year' : 'a month'}.{' '}
                Online payment is not available yet: Talk2Tax sends an invoice and activates the plan when payment is received. Nothing changes until then.{' '}
                {manage ? <Button variant="ghost" size="sm" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw request</Button> : null}
              </Alert>
            </div>
          ) : null}

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
                    <ul className="mt-3 flex-1 space-y-1 text-sm">
                      <li>{limit(p.limits.members, 'members')}</li>
                      <li>{p.limits.aiCreditsPerMonth === null ? (p.features.includes('AI') ? 'Unlimited AI requests' : 'No AI requests') : `${p.limits.aiCreditsPerMonth.toLocaleString('en-IN')} AI requests a month`}</li>
                      <li>{limit(p.limits.documentUploadsPerMonth, 'uploads a month')}</li>
                      {Object.entries(s.featureLabels).map(([k, label]) => (
                        <li key={k} className={p.features.includes(k) ? '' : 'text-fg-faint line-through'}>{label}</li>
                      ))}
                    </ul>
                    {manage ? (
                      <Button className="mt-4" variant={requested ? 'secondary' : 'primary'} disabled={requested || (current && s.billingInterval === interval)} loading={request.isPending && request.variables === p.code} onClick={() => request.mutate(p.code)}>
                        {requested ? 'Requested' : current && s.billingInterval === interval ? 'Current plan' : `Choose ${p.name}`}
                      </Button>
                    ) : null}
                  </section>
                );
              })}
            </div>
            <div className="px-5 pb-5"><ErrorAlert title="Plan not requested" error={request.error ?? withdraw.error} /></div>
            {!manage ? <p className="px-5 pb-5 text-sm text-fg-muted">Owners and admins choose the plan.</p> : null}
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
                    <Td className="text-sm text-fg-muted">{[h.data.plan, h.data.interval, h.data.price ? `${h.data.price} ${h.data.currency ?? ''}` : null, h.data.paymentReference ? `ref ${h.data.paymentReference}` : null, h.data.reason, h.data.days ? `${h.data.days} days` : null].filter(Boolean).join(' · ')}</Td>
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
