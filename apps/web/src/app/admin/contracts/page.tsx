'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useMeWithRole } from '@/lib/admin';

interface Contract {
  id: string;
  orgId: string;
  organisation: string;
  reference: string;
  plan: { code: string; name: string };
  interval: 'MONTHLY' | 'ANNUAL';
  currency: string;
  price: string;
  startsOn: string;
  lastDay: string;
  limits: { members?: number; aiCreditsPerMonth?: number; documentUploadsPerMonth?: number };
  notes: string;
  status: 'ACTIVE' | 'ENDED';
  endedAt: string | null;
  endReason: string | null;
}
interface Sub { orgId: string; organisation: string; status: string; currency: string; plan: { name: string } }
interface Plan { code: string; name: string; isActive: boolean }

const LIMITS: [keyof Contract['limits'], string][] = [['members', 'Members'], ['aiCreditsPerMonth', 'AI requests a month'], ['documentUploadsPerMonth', 'Uploads a month']];
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const blank = { orgId: '', reference: '', plan: 'ENTERPRISE', interval: 'ANNUAL' as 'MONTHLY' | 'ANNUAL', price: '', startsOn: today(), endsOn: '', notes: '', activate: true, limits: { members: '', aiCreditsPerMonth: '', documentUploadsPerMonth: '' } as Record<keyof Contract['limits'], string> };

/** Enterprise contracts (SUBS-023): an organisation's plan at its own price, term and limits. */
export default function AdminContractsPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const list = useQuery({ queryKey: ['admin-contracts'], queryFn: () => api<Contract[]>('/v1/admin/contracts') });
  const subs = useQuery({ queryKey: ['admin-subscriptions', 'all'], queryFn: () => api<Sub[]>('/v1/admin/subscriptions?filter=all'), enabled: manage });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api<Plan[]>('/v1/admin/plans'), enabled: manage });
  const [f, setF] = useState(blank);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['admin-contracts'] }), qc.invalidateQueries({ queryKey: ['admin-subscriptions'] })]);
  const create = useMutation({
    mutationFn: () => {
      const limits = Object.fromEntries(Object.entries(f.limits).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number.parseInt(v, 10)]));
      // The last day is entered; the term ends the day after it.
      const end = f.endsOn ? new Date(Date.parse(`${f.endsOn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : '';
      return api<Contract>(`/v1/admin/subscriptions/${f.orgId}/contract`, { method: 'POST', body: { reference: f.reference.trim(), plan: f.plan, interval: f.interval, price: f.price.trim(), startsOn: f.startsOn, endsOn: end, limits, notes: f.notes, activate: f.activate } });
    },
    onSuccess: async () => { setF(blank); await refresh(); },
  });
  const end = useMutation({
    mutationFn: (c: Contract) => {
      const reason = window.prompt(`Why does contract ${c.reference} end early?`);
      if (!reason) return Promise.resolve(null);
      return api<Contract>(`/v1/admin/contracts/${c.id}/end`, { method: 'POST', body: { reason } });
    },
    onSuccess: refresh,
  });
  const org = subs.data?.find((s) => s.orgId === f.orgId);
  return (
    <>
      <PageHeader title="Enterprise contracts" description="Plans agreed with one organisation for a term, at their own price and limits. While a contract runs, its renewals are invoiced at the contract price and the organisation cannot change plan itself. When the term ends, the next renewal is at the plan's list price." />
      <Card className="mb-6" aria-label="Contracts">
        <CardHeader title="Contracts" />
        <ErrorAlert title="Could not load the contracts" error={list.error ?? end.error} />
        {list.data?.length ? (
          <Table>
            <thead><tr><Th>Contract</Th><Th>Organisation</Th><Th>Plan</Th><Th numeric>Price</Th><Th>Term</Th><Th>Limits</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <Tr key={c.id}>
                  <Td className="font-medium">{c.reference}{c.notes ? <span className="block text-xs font-normal text-fg-muted">{c.notes}</span> : null}</Td>
                  <Td>{c.organisation}</Td>
                  <Td>{c.plan.name}</Td>
                  <Td numeric><Money value={c.price} currency={c.currency} /><span className="block text-xs text-fg-muted">{c.interval === 'ANNUAL' ? 'a year' : 'a month'}</span></Td>
                  <Td>{date(c.startsOn)} to {date(c.lastDay)}</Td>
                  <Td className="text-sm">{LIMITS.filter(([k]) => c.limits[k] !== undefined).map(([k, l]) => `${l}: ${c.limits[k]!.toLocaleString('en-IN')}`).join(', ') || 'The plan’s'}</Td>
                  <Td>{c.status === 'ACTIVE' ? <Badge tone="positive">In force</Badge> : <Badge tone="neutral">Ended</Badge>}{c.endReason ? <span className="block text-xs text-fg-muted">{c.endReason}</span> : null}</Td>
                  <Td className="text-right">{manage && c.status === 'ACTIVE' ? <Button variant="ghost" size="sm" loading={end.isPending && end.variables?.id === c.id} onClick={() => end.mutate(c)}>End early</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : list.data ? <EmptyState title="No contracts yet">Record one below when an enterprise customer signs.</EmptyState> : null}
      </Card>
      {manage ? (
        <Card aria-label="Record a contract">
          <CardHeader title="Record a contract" description="The terms cannot be changed afterwards: to change them, end the contract and record a new one. Limits left blank are the plan's." />
          <form className="grid gap-4 px-5 pb-5 pt-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="New contract" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Organisation">{(p) => <Select {...p} value={f.orgId} onChange={(e) => setF({ ...f, orgId: e.target.value })}><option value="">Choose…</option>{subs.data?.map((s) => <option key={s.orgId} value={s.orgId}>{s.organisation} ({s.plan.name}, {s.status.toLowerCase()})</option>)}</Select>}</Field>
            <Field label="Contract reference">{(p) => <Input {...p} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="ENT/2026/014" />}</Field>
            <Field label="Plan">{(p) => <Select {...p} value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>{plans.data?.map((pl) => <option key={pl.code} value={pl.code}>{pl.name}{pl.isActive ? '' : ' (not offered)'}</option>)}</Select>}</Field>
            <Field label="Billing">{(p) => <Select {...p} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value as 'MONTHLY' | 'ANNUAL' })}><option value="ANNUAL">Annual</option><option value="MONTHLY">Monthly</option></Select>}</Field>
            <Field label={`Price per period${org ? ` (${org.currency})` : ''}`}>{(p) => <Input {...p} className="num" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />}</Field>
            <Field label="Starts on">{(p) => <Input {...p} type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} />}</Field>
            <Field label="Last day">{(p) => <Input {...p} type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} />}</Field>
            {LIMITS.map(([k, l]) => (
              <Field key={k} label={l}>{(p) => <Input {...p} className="num" inputMode="numeric" placeholder="The plan's" value={f.limits[k]} onChange={(e) => setF({ ...f, limits: { ...f.limits, [k]: e.target.value } })} />}</Field>
            ))}
            <Field label="Notes">{(p) => <Input {...p} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
            <label className="inline-flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.activate} onChange={(e) => setF({ ...f, activate: e.target.checked })} /> Start the first period now, paid under the contract (otherwise it starts at the next renewal)</label>
            <div className="sm:col-span-2 lg:col-span-3">
              <ErrorAlert title="Contract not recorded" error={create.error} />
              <Button type="submit" loading={create.isPending} disabled={!f.orgId}>Record contract</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </>
  );
}
