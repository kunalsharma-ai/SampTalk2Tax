'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { VERDICT, type SimulationItem, type StressResponse } from '@/lib/disasters';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { monthLabel } from '@/lib/twin';
import { can } from '@/lib/types';

/** Financial disaster simulation: the standard stress tests on the business's own figures, and saved simulations. */
export default function DisastersPage() {
  const { org, orgId } = useOrg();
  const [horizon, setHorizon] = useState(12);
  const q = useQuery({ queryKey: ['disaster-stress', orgId, horizon], queryFn: () => api<StressResponse>(`/v1/orgs/${orgId}/disasters/stress-tests?baselineMonths=6&horizonMonths=${horizon}`) });
  const sims = useQuery({ queryKey: ['disaster-simulations', orgId], queryFn: () => api<{ items: SimulationItem[] }>(`/v1/orgs/${orgId}/disasters/simulations`) });
  if (!org) return null;
  const d = q.data;
  const c = d?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Disaster simulation"
        description="How the business would cope with severe shocks: a customer that cannot pay, a supplier that fails, frozen cash, a shutdown or a collapse in sales. Built from your own customers, suppliers and cash, and played forward from the posted books. Nothing is posted."
        actions={<Link className="rounded-[var(--t2t-radius-md)] bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90" href={`/orgs/${orgId}/planning/disasters/new`}>New simulation</Link>}
      />
      <ErrorAlert title="Could not run the stress tests" error={q.error} />
      <Card>
        <CardHeader
          title="Standard stress tests"
          description="Seven shocks every business should know the answer to, worst first. Baseline: the last 6 months of books. Most cash lost is the furthest cash falls below the same projection with no shock."
          actions={
            <Select aria-label="Months ahead" className="w-48" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {[6, 12, 18, 24].map((h) => <option key={h} value={h}>{h} months ahead</option>)}
            </Select>
          }
        />
        {d ? (
          <>
            <p className="px-5 pb-3 text-sm" data-testid="stress-summary">{d.summary}</p>
            <Table aria-label="Stress tests">
              <thead>
                <tr>
                  <Th>Shock</Th>
                  <Th>Result</Th>
                  <Th numeric>Lowest cash</Th>
                  <Th numeric>Most cash lost</Th>
                  <Th numeric>Change in profit</Th>
                  <Th numeric>Cash to raise</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {d.tests.map((t) => (
                  <Tr key={t.key}>
                    <Td>
                      <span className="font-medium">{t.title}</span>
                      <p className="text-xs text-fg-muted">{t.description}</p>
                    </Td>
                    <Td><Badge tone={VERDICT[t.impact.verdict].tone}>{VERDICT[t.impact.verdict].label}</Badge>{t.impact.cashNegativeFrom ? <p className="text-xs text-fg-muted">from {monthLabel(t.impact.cashNegativeFrom)}</p> : null}</Td>
                    <Td numeric><Money value={t.impact.lowestCash.amount} currency={c} signed /><p className="text-xs text-fg-muted">{monthLabel(t.impact.lowestCash.month)}</p></Td>
                    <Td numeric>{Number(t.impact.largestCashGap.amount) < 0 ? <><Money value={t.impact.largestCashGap.amount} currency={c} signed /><p className="text-xs text-fg-muted">{monthLabel(t.impact.largestCashGap.month)}</p></> : '—'}</Td>
                    <Td numeric><Money value={t.impact.profitChange} currency={c} signed /></Td>
                    <Td numeric>{Number(t.impact.cashRequired) > 0 ? <Money value={t.impact.cashRequired} currency={c} /> : '—'}</Td>
                    <Td><Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/disasters/new?test=${t.key}&horizon=${horizon}`}>Open</Link></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <p className="px-5 py-3 text-xs text-fg-muted">
              Cash running short? The <Link className="text-accent hover:underline" href={`/orgs/${orgId}/planning/recovery`}>recovery planner</Link> lists what could be done about it, each option measured.
            </p>
          </>
        ) : !q.error ? (
          <p className="px-5 pb-5 text-sm text-fg-muted">Running the stress tests…</p>
        ) : null}
      </Card>

      <Card className="mt-4">
        <CardHeader title="Saved simulations" description={can(org.role, 'scenarios.manage') ? 'Saved with their shocks; every visit re-runs them on the latest books.' : 'Saved with their shocks; every visit re-runs them on the latest books. Saving needs permission to manage scenarios.'} />
        {sims.data?.items.length ? (
          <Table aria-label="Saved simulations">
            <thead>
              <tr>
                <Th>Simulation</Th>
                <Th>Shocks</Th>
                <Th>Result today</Th>
                <Th numeric>Lowest cash</Th>
                <Th>Changed</Th>
              </tr>
            </thead>
            <tbody>
              {sims.data.items.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/planning/disasters/${s.id}`}>{s.name}</Link>
                    <p className="num text-xs text-fg-muted">{s.number}</p>
                  </Td>
                  <Td className="text-sm">{s.shocks.length}</Td>
                  <Td>{s.verdict ? <Badge tone={VERDICT[s.verdict].tone}>{VERDICT[s.verdict].label}</Badge> : <span className="text-sm text-fg-muted">Needs attention</span>}</Td>
                  <Td numeric>{s.lowestCash ? <Money value={s.lowestCash.amount} currency={c} signed /> : '—'}</Td>
                  <Td className="text-sm text-fg-muted">{dateTime(s.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No saved simulations yet">Open a stress test or start a new simulation to combine shocks of your own.</EmptyState>
        )}
      </Card>
    </>
  );
}
