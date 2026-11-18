'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { COMPOUNDING, type DepositList } from '@/lib/deposits';
import { date } from '@/lib/format';
import { today } from '@/lib/loans';
import { useOrg } from '@/lib/org';

export default function DepositsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deposits', orgId], queryFn: () => api<DepositList>(`/v1/orgs/${orgId}/deposits`) });
  const [asOf, setAsOf] = useState(today());
  const accrue = useMutation({
    mutationFn: () => api<{ accrued: { number: string; amount: string }[] }>(`/v1/orgs/${orgId}/deposits/accrue`, { method: 'POST', body: { date: asOf } }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['deposits', orgId] }), qc.invalidateQueries({ queryKey: ['deposit', orgId] })]),
  });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = q.data;
  const open = r?.items.filter((d) => d.status === 'OPEN') ?? [];
  return (
    <>
      <PageHeader
        title="Fixed deposits"
        description="Term deposits with banks and the interest they earn. Interest is worked out from the rate and how it compounds, accrued to the dates you choose so the books show it as it is earned, and settled when the deposit matures or is closed early."
        actions={
          <>
            <Link href={`/orgs/${orgId}/treasury`}><Button variant="secondary">Treasury</Button></Link>
            {r?.can.manage ? <Link href={`/orgs/${orgId}/deposits/new`}><Button>Place a deposit</Button></Link> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load deposits" error={q.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Deposited" value={<Money value={r.totals.principal} currency={cur} />} tone="accent" sub={`${open.length} open ${open.length === 1 ? 'deposit' : 'deposits'}`} />
            <Stat label="Interest earned to date" value={<Money value={r.totals.earnedToDate} currency={cur} />} tone="positive" sub={<>Accrued in the books <Money value={r.totals.accrued} currency={cur} /></>} />
            <Stat label="Due at maturity" value={<Money value={r.totals.atMaturity} currency={cur} />} tone="violet" sub="Principal and interest, before tax deducted" />
            <Stat label="Maturing within 30 days" value={String(r.maturingIn30Days)} tone={r.maturingIn30Days ? 'warning' : 'neutral'} sub="Renew or close them" />
          </div>
          {r.can.manage && open.length ? (
            <Card className="mb-4 p-4">
              <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); accrue.mutate(); }}>
                <Field label="Accrue interest on every open deposit to">{(p) => <Input {...p} type="date" value={asOf} max={today()} onChange={(e) => setAsOf(e.target.value)} required />}</Field>
                <Button type="submit" loading={accrue.isPending}>Accrue interest</Button>
                <p className="basis-full text-xs text-fg-muted">Posts Dr interest accrued, Cr interest income for what each deposit has earned since its last accrual, up to its maturity. Do this at each month or quarter end.</p>
              </form>
              <ErrorAlert title="Not accrued" error={accrue.error} />
              {accrue.data ? (
                <div className="mt-3">
                  <Alert tone={accrue.data.accrued.length ? 'positive' : 'neutral'} title={accrue.data.accrued.length ? `Interest accrued on ${accrue.data.accrued.length} ${accrue.data.accrued.length === 1 ? 'deposit' : 'deposits'}` : 'Nothing to accrue'}>
                    {accrue.data.accrued.length ? accrue.data.accrued.map((a) => <span key={a.number} className="mr-3">{a.number}: <Money value={a.amount} currency={cur} /></span>) : 'Every open deposit is already accrued to that date.'}
                  </Alert>
                </div>
              ) : null}
            </Card>
          ) : null}
          {r.items.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="Deposits">
                <thead>
                  <tr>
                    <Th>Deposit</Th>
                    <Th numeric>Rate</Th>
                    <Th numeric>Principal</Th>
                    <Th numeric>Earned to date</Th>
                    <Th numeric>Not accrued</Th>
                    <Th numeric>At maturity</Th>
                    <Th>Matures</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((d) => (
                    <Tr key={d.id}>
                      <Td>
                        <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/deposits/${d.id}`}>{d.number} {d.name}</Link>
                        <span className="block text-xs text-fg-faint">{[d.institution, d.institutionRef, COMPOUNDING[d.compounding]].filter(Boolean).join(' · ')}</span>
                      </Td>
                      <Td numeric className="num">{d.annualRate}%</Td>
                      <Td numeric><Money value={d.principal} currency={cur} /></Td>
                      <Td numeric><Money value={d.earnedToDate} currency={cur} /></Td>
                      <Td numeric>{d.status === 'OPEN' ? <Money value={d.notAccrued} currency={cur} /> : '—'}</Td>
                      <Td numeric className="font-medium"><Money value={d.maturityValue} currency={cur} /></Td>
                      <Td className="whitespace-nowrap text-sm">{date(d.maturityDate)}</Td>
                      <Td>
                        {d.status === 'CLOSED' ? <Badge>Closed</Badge> : d.daysToMaturity < 0 ? <Badge tone="warning">Matured</Badge> : d.daysToMaturity <= 30 ? <Badge tone="warning">In {d.daysToMaturity} days</Badge> : <Badge tone="positive">Open</Badge>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card><EmptyState title="No deposits yet">Place a deposit to see what it will pay at maturity, accrue the interest as it is earned, and record the tax the bank deducts when it pays out.</EmptyState></Card>
          )}
        </>
      ) : null}
    </>
  );
}
