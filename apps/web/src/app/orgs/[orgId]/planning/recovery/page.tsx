'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { OptionGroups } from '@/components/recovery/option-card';
import { PageHeader } from '@/components/shell';
import { TwinCashChart } from '@/components/twin/twin-chart';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { PLAN_STATUS, runwayText, type RecoveryOptions, type RecoveryPlan } from '@/lib/recovery';
import { monthLabel, type TwinMonth } from '@/lib/twin';
import { can } from '@/lib/types';

/** Where cash is heading with no action, the recovery options the books suggest, and the plans made from them. */
export default function RecoveryPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const [baselineMonths, setBaselineMonths] = useState(6);
  const [horizonMonths, setHorizonMonths] = useState(12);
  const [name, setName] = useState('');
  const q = useQuery({ queryKey: ['recovery-options', orgId, baselineMonths, horizonMonths], queryFn: () => api<RecoveryOptions>(`/v1/orgs/${orgId}/recovery/options?baselineMonths=${baselineMonths}&horizonMonths=${horizonMonths}`) });
  const plans = useQuery({ queryKey: ['recovery-plans', orgId], queryFn: () => api<{ items: RecoveryPlan[] }>(`/v1/orgs/${orgId}/recovery/plans`) });
  const create = useMutation({
    mutationFn: () => api<RecoveryPlan>(`/v1/orgs/${orgId}/recovery/plans`, { method: 'POST', body: { name, baselineMonths, horizonMonths } }),
    onSuccess: (p) => router.push(`/orgs/${orgId}/planning/recovery/${p.id}`),
  });
  if (!org) return null;
  const manage = can(org.role, 'scenarios.manage');
  const d = q.data;
  const c = d?.currency ?? 'INR';
  const n = d?.noAction;
  return (
    <>
      <PageHeader title="Recovery planner" description="Options to protect cash, worked out from your own books and measured with the digital twin. Nothing is done automatically: you choose, people act." />
      <ErrorAlert title="Could not work out the options" error={q.error ?? plans.error} />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Baseline">
            {(p) => (
              <Select {...p} value={baselineMonths} onChange={(e) => setBaselineMonths(Number(e.target.value))}>
                <option value={3}>Last 3 months</option>
                <option value={6}>Last 6 months</option>
                <option value={12}>Last 12 months</option>
              </Select>
            )}
          </Field>
          <Field label="Horizon">
            {(p) => (
              <Select {...p} value={horizonMonths} onChange={(e) => setHorizonMonths(Number(e.target.value))}>
                {[6, 12, 18, 24].map((h) => <option key={h} value={h}>{h} months</option>)}
              </Select>
            )}
          </Field>
        </div>
      </Card>
      {n ? (
        <>
          {n.cashNegativeFrom ? (
            <Alert tone="negative" title={`With no action, cash runs out in ${monthLabel(n.cashNegativeFrom)}`}>
              About <Money value={n.cashRequired} currency={c} /> more is needed to stay at or above the minimum balance over the next {horizonMonths} months. The options below show what each one would change.
            </Alert>
          ) : Number(n.cashRequired) > 0 ? (
            <Alert tone="warning" title="Cash dips below the minimum balance">Cash stays positive but falls below the minimum balance you set. The options below show what each one would change.</Alert>
          ) : (
            <Alert tone="positive" title="Cash stays positive with no action">The options below can still strengthen cash.</Alert>
          )}
          <div className="my-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Runway, no action" value={<span className="text-lg">{runwayText(n.runwayMonths, horizonMonths)}</span>} tone={n.runwayMonths === null ? 'positive' : 'negative'} />
            <Stat label="Lowest cash" value={<Money value={n.minimumCash.amount} currency={c} signed className="text-lg" />} sub={monthLabel(n.minimumCash.month)} tone={n.cashNegativeFrom ? 'negative' : 'neutral'} />
            <Stat label="Cash to raise" value={<Money value={n.cashRequired} currency={c} className="text-lg" />} tone={Number(n.cashRequired) > 0 ? 'warning' : 'positive'} />
            <Stat label="Customers pay in" value={<span className="text-lg">{Number(d.collectionDays).toFixed(0)} days</span>} sub={`Suppliers paid in ${Number(d.paymentDays).toFixed(0)} days`} />
          </div>
          <Card className="mb-4 p-4">
            <CardHeader title="Cash with no action (hypothetical)" description="Month-end cash if nothing changes, from the average of your recent actual months." />
            <TwinCashChart actual={[]} series={[{ name: 'No action (hypothetical)', months: n.cash as unknown as TwinMonth[] }]} currency={c} label="Month-end cash with no action. The key figures are above." />
          </Card>
        </>
      ) : q.isLoading ? <p className="text-sm text-fg-muted">Working out the options…</p> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card className="p-4">
          <CardHeader title="Options from your books" description="Each one measured against taking no action. Build a plan to choose some and track them." />
          {d ? d.options.length ? <OptionGroups options={d.options} currency={c} /> : <p className="text-sm text-fg-muted">No options: there is not enough activity in the baseline months yet.</p> : null}
        </Card>
        <div className="space-y-4">
          <Card className="p-4">
            <CardHeader title="Recovery plans" />
            {plans.data && !plans.data.items.length ? <EmptyState title="No plans yet">Start one to choose options and track who does what.</EmptyState> : null}
            {plans.data?.items.length ? (
              <Table aria-label="Recovery plans">
                <thead><tr><Th>Plan</Th><Th>Actions</Th><Th>Updated</Th></tr></thead>
                <tbody>
                  {plans.data.items.map((p) => (
                    <Tr key={p.id}>
                      <Td>
                        <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/planning/recovery/${p.id}`}>{p.name}</Link>{' '}
                        <Badge tone={PLAN_STATUS[p.status].tone}>{PLAN_STATUS[p.status].label}</Badge>
                      </Td>
                      <Td className="text-xs">{p.actions ? `${p.actions.done} done, ${p.actions.inProgress} in progress, ${p.actions.planned} planned` : ''}</Td>
                      <Td className="whitespace-nowrap text-xs">{date(p.updatedAt.slice(0, 10))}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
            {manage ? (
              <form
                className="mt-4 flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate();
                }}
              >
                <div className="flex-1">
                  <Field label="New plan name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 cash recovery" />}</Field>
                </div>
                <Button type="submit" disabled={!name.trim()} loading={create.isPending}>Start a plan</Button>
              </form>
            ) : <p className="mt-3 text-sm text-fg-muted">Building plans needs the scenarios permission.</p>}
            {create.error ? <div className="mt-2"><ErrorAlert title="Not created" error={create.error} /></div> : null}
          </Card>
          <Alert tone="violet" title="Nothing happens automatically">
            The planner never contacts customers or suppliers, cuts costs, borrows, pays or changes payroll. It shows options and their likely effect; people decide and act.
          </Alert>
        </div>
      </div>
    </>
  );
}
