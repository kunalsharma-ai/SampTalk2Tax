'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useMeWithRole } from '@/lib/admin';
import type { SubscriptionAccess } from '@/lib/types';

interface Row {
  orgId: string;
  organisation: string;
  countryCode: string;
  isDemo: boolean;
  plan: { code: string; name: string };
  status: string;
  access: SubscriptionAccess;
  billingInterval: string | null;
  currency: string;
  price: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  paymentReference: string | null;
  request: { plan: { code: string; name: string }; interval: string; at: string } | null;
}
const STATE: Record<string, { label: string; tone: 'positive' | 'warning' | 'negative' | 'neutral' | 'violet' }> = {
  TRIAL: { label: 'Trial', tone: 'violet' }, ACTIVE: { label: 'Active', tone: 'positive' }, GRACE: { label: 'Payment due', tone: 'warning' }, CANCELLING: { label: 'Cancelling', tone: 'warning' },
  COMPLIMENTARY: { label: 'Complimentary', tone: 'positive' }, TRIAL_ENDED: { label: 'Trial ended', tone: 'negative' }, LAPSED: { label: 'Lapsed', tone: 'negative' }, CANCELLED: { label: 'Cancelled', tone: 'negative' },
};

export default function AdminSubscriptionsPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [filter, setFilter] = useState<'all' | 'requested' | 'trial' | 'active' | 'read_only'>('all');
  const [note, setNote] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['admin-subscriptions', filter], queryFn: () => api<Row[]>(`/v1/admin/subscriptions?filter=${filter}`) });
  const act = useMutation({
    mutationFn: async (a: { kind: 'activate' | 'extend-trial' | 'cancel' | 'complimentary'; row: Row; body: Record<string, unknown> }) => ({ a, r: await api<Row>(`/v1/admin/subscriptions/${a.row.orgId}/${a.kind}`, { method: 'POST', body: a.body }) }),
    onSuccess: async ({ a, r }) => {
      setNote(a.kind === 'activate' ? `${r.organisation} is on ${r.plan.name} until ${date(r.currentPeriodEnd!.slice(0, 10))}.` : a.kind === 'extend-trial' ? `${r.organisation}'s trial now ends ${date(r.trialEndsAt!.slice(0, 10))}.` : a.kind === 'cancel' ? `${r.organisation} is cancelled; it runs to its period end.` : `${r.organisation} is complimentary.`);
      await qc.invalidateQueries({ queryKey: ['admin-subscriptions'] });
    },
  });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const ask = (q: string) => window.prompt(q)?.trim() || null;
  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Each organisation's plan, status and any plan it has asked for. Activate a request when its payment is received (bank transfer, invoice or contract), with the payment reference. Online checkout comes next."
        actions={
          <Select className="w-48" aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All</option>
            <option value="requested">Plan requested</option>
            <option value="trial">On trial</option>
            <option value="active">Paid</option>
            <option value="read_only">Read only</option>
          </Select>
        }
      />
      <ErrorAlert title="Not done" error={list.error ?? act.error} />
      {note ? <p role="status" className="mb-4 text-sm text-positive">{note}</p> : null}
      <Card aria-label="Subscriptions">
        {list.data?.length ? (
          <Table>
            <thead><tr><Th>Organisation</Th><Th>Plan</Th><Th>Status</Th><Th>Until</Th><Th numeric>Price</Th><Th>Requested</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {list.data.map((r) => {
                const st = STATE[r.access.state];
                const until = r.access.level === 'FULL' ? r.access.until : r.access.since;
                return (
                  <Tr key={r.orgId}>
                    <Td><Link className="font-medium hover:text-accent" href={`/admin/organisations/${r.orgId}`}>{r.organisation}</Link> <span className="text-xs text-fg-faint">{r.countryCode}</span>{r.isDemo ? <Badge tone="warning" className="ml-2">Demo</Badge> : null}</Td>
                    <Td>{r.plan.name}{r.billingInterval ? <span className="block text-xs text-fg-muted">{r.billingInterval === 'ANNUAL' ? 'Annual' : 'Monthly'}{r.paymentReference ? ` · ref ${r.paymentReference}` : ''}</span> : null}</Td>
                    <Td>{st ? <Badge tone={st.tone}>{st.label}</Badge> : r.status}</Td>
                    <Td className="whitespace-nowrap">{until ? dateTime(until) : '—'}</Td>
                    <Td numeric>{r.price ? <Money value={r.price} currency={r.currency} /> : '—'}</Td>
                    <Td className="text-sm">{r.request ? <>{r.request.plan.name}, {r.request.interval === 'ANNUAL' ? 'annual' : 'monthly'}<span className="block text-xs text-fg-muted">{date(r.request.at.slice(0, 10))}</span></> : '—'}</Td>
                    <Td className="whitespace-nowrap text-right">
                      {manage ? (
                        <>
                          {r.request ? <Button size="sm" aria-label={`Activate ${r.organisation}`} onClick={() => { const ref = ask(`Payment reference for ${r.organisation} (${r.request!.plan.name}, ${r.request!.interval.toLowerCase()})`); if (ref) act.mutate({ kind: 'activate', row: r, body: { paymentReference: ref } }); }}>Activate</Button> : null}
                          {r.status === 'TRIALING' ? <Button variant="ghost" size="sm" aria-label={`Extend trial of ${r.organisation}`} onClick={() => { const d = Number(ask('Extend the trial by how many days? (1-90)')); if (d) act.mutate({ kind: 'extend-trial', row: r, body: { days: d } }); }}>Extend trial</Button> : null}
                          {r.status === 'ACTIVE' ? <Button variant="ghost" size="sm" onClick={() => { const why = ask('Why is the subscription cancelled?'); if (why) act.mutate({ kind: 'cancel', row: r, body: { reason: why } }); }}>Cancel</Button> : null}
                          {r.status !== 'COMPLIMENTARY' ? <Button variant="ghost" size="sm" onClick={() => { const why = ask('Why is this organisation complimentary?'); if (why) act.mutate({ kind: 'complimentary', row: r, body: { reason: why } }); }}>Complimentary</Button> : null}
                        </>
                      ) : null}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        ) : list.data ? <EmptyState title="Nothing here">No subscriptions match.</EmptyState> : null}
      </Card>
    </>
  );
}
