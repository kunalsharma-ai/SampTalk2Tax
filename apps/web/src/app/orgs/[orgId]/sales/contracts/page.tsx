'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FREQUENCY_LABEL } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { ContractBadge, RenewalBadge } from '@/components/sales-orders/badges';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { ContractList } from '@/lib/sales-orders';

type View = 'active' | 'renewals' | 'draft' | 'closed' | 'all';
const VIEWS: Record<View, string> = { active: 'Active and paused', renewals: 'Renewal due', draft: 'Drafts', closed: 'Ended and cancelled', all: 'All contracts' };

export default function ContractsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [view, setView] = useState<View>('active');
  const list = useQuery({ queryKey: ['sales-contracts', orgId, view], queryFn: () => api<ContractList>(`/v1/orgs/${orgId}/sales/contracts?view=${view}`) });
  const run = useMutation({
    mutationFn: () => api<{ contracts: number; billed: number; errors: { id: string; error: string }[] }>(`/v1/orgs/${orgId}/sales/contracts/bill-due`, { method: 'POST' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['sales-contracts', orgId] });
      await qc.invalidateQueries({ queryKey: ['documents', orgId] });
    },
  });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = list.data;
  return (
    <>
      <PageHeader
        title="Contracts"
        description="Recurring work billed every period. Each period that falls due becomes a draft invoice automatically, made with the same tax rules as any invoice; you check and post it."
        actions={
          r?.can.manage ? (
            <>
              <Button variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>Bill due periods now</Button>
              <Link href={`/orgs/${orgId}/sales/contracts/new`}><Button>New contract</Button></Link>
            </>
          ) : null
        }
      />
      <ErrorAlert title="Could not load contracts" error={list.error} />
      <ErrorAlert title="Could not bill" error={run.error} />
      {run.data ? (
        <Alert tone={run.data.errors.length ? 'warning' : 'positive'} title={run.data.billed ? `${run.data.billed} draft ${run.data.billed === 1 ? 'invoice' : 'invoices'} made` : 'Nothing was due'}>
          Checked {run.data.contracts} active {run.data.contracts === 1 ? 'contract' : 'contracts'}.{run.data.errors.length ? ` ${run.data.errors.length} could not be billed; open them to see why.` : ''}
        </Alert>
      ) : null}
      {r ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Monthly recurring revenue" value={<Money value={r.summary.mrr} currency={cur} />} tone="accent" sub={`${r.summary.active} active, excluding tax`} />
            <Stat label="Annual recurring revenue" value={<Money value={r.summary.arr} currency={cur} />} tone="violet" sub="MRR × 12" />
            <Stat label="Renewals due" value={String(r.summary.renewalsDue)} tone={r.summary.renewalsDue ? 'warning' : 'positive'} sub={`${r.summary.endingIn30Days} ending in 30 days without auto-renew`} />
            <Stat label="Billing problems" value={String(r.summary.billingProblems)} tone={r.summary.billingProblems ? 'negative' : 'positive'} sub={`${r.summary.paused} paused`} />
          </div>
          <Card>
            <div className="flex items-center justify-end gap-2 border-b border-line px-5 py-3">
              <label htmlFor="c-view" className="text-xs text-fg-muted">Show</label>
              <Select id="c-view" className="w-52" value={view} onChange={(e) => setView(e.target.value as View)}>
                {(Object.keys(VIEWS) as View[]).map((v) => <option key={v} value={v}>{VIEWS[v]}</option>)}
              </Select>
            </div>
            {r.contracts.length === 0 ? (
              <EmptyState title="No contracts here">Set up a contract for work you bill every month, quarter or year.</EmptyState>
            ) : (
              <Table aria-label="Contracts">
                <thead>
                  <tr><Th>Contract</Th><Th>Customer</Th><Th>Billed</Th><Th>Term</Th><Th>Next invoice</Th><Th>Status</Th><Th numeric>Per period</Th><Th numeric>MRR</Th></tr>
                </thead>
                <tbody>
                  {r.contracts.map((c) => (
                    <Tr key={c.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/contracts/${c.id}`}>{c.reference}</Link><span className="block text-xs text-fg-muted">{c.title}</span></Td>
                      <Td>{c.contact?.name ?? '—'}</Td>
                      <Td>{FREQUENCY_LABEL[c.frequency]}<span className="block text-xs text-fg-muted">{c.timing === 'ADVANCE' ? 'in advance' : 'in arrears'}</span></Td>
                      <Td className="whitespace-nowrap">{date(c.startDate)} – {c.endDate ? date(c.endDate) : 'rolling'}</Td>
                      <Td>{c.nextBill && c.status === 'ACTIVE' ? date(c.nextBill.date) : '—'}</Td>
                      <Td><div className="flex flex-wrap gap-1"><ContractBadge status={c.status} /><RenewalBadge renewal={c.renewal} />{c.lastError ? <span className="text-xs text-negative">Billing problem</span> : null}</div></Td>
                      <Td numeric><Money value={c.total} currency={cur} /></Td>
                      <Td numeric><Money value={c.monthlyValue} currency={cur} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
