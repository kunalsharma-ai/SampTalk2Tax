'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type ExpenseClaimStatus, type ExpenseClaimSummary } from '@/lib/types';

const TONE: Record<ExpenseClaimStatus, 'neutral' | 'warning' | 'negative' | 'accent' | 'positive'> = {
  DRAFT: 'neutral',
  SUBMITTED: 'warning',
  REJECTED: 'negative',
  APPROVED: 'accent',
  REIMBURSED: 'positive',
  VOID: 'neutral',
};
const LABEL: Record<ExpenseClaimStatus, string> = { DRAFT: 'Draft', SUBMITTED: 'Waiting for approval', REJECTED: 'Rejected', APPROVED: 'Approved, to be paid', REIMBURSED: 'Paid back', VOID: 'Void' };

export function ClaimStatus({ status }: { status: ExpenseClaimStatus }) {
  return <Badge tone={TONE[status]}>{LABEL[status]}</Badge>;
}

type View = 'mine' | 'approve' | 'reimburse' | 'all';
interface ListResponse {
  total: number;
  summary: Partial<Record<ExpenseClaimStatus, { count: number; total: string }>>;
  items: ExpenseClaimSummary[];
}

export function ClaimsList() {
  const { org, orgId } = useOrg();
  const role = org?.role;
  const views: { v: View; label: string }[] = [
    ...(can(role, 'expenses.submit') ? [{ v: 'mine' as const, label: 'My claims' }] : []),
    ...(can(role, 'approvals.decide') ? [{ v: 'approve' as const, label: 'To approve' }] : []),
    ...(can(role, 'expenses.reimburse') ? [{ v: 'reimburse' as const, label: 'To pay back' }] : []),
    ...(role && role !== 'EMPLOYEE' ? [{ v: 'all' as const, label: 'All claims' }] : []),
  ];
  const [chosen, setView] = useState<View | null>(null);
  const view = chosen ?? views[0]?.v ?? 'mine';
  const query = { mine: 'mine=true', approve: 'status=SUBMITTED', reimburse: 'status=APPROVED', all: '' }[view];
  const q = useQuery({ enabled: !!org, queryKey: ['expense-claims', orgId, view], queryFn: () => api<ListResponse>(`/v1/orgs/${orgId}/expense-claims?limit=200&${query}`) });
  if (!org) return null;
  const c = org.functionalCurrency;
  const s = q.data?.summary ?? {};
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title={role === 'EMPLOYEE' ? 'My expense claims' : 'Expense claims'}
        description="Money people spent for the business and want paid back. A claim is approved by someone other than the claimant, which records the expense; it is then paid back from a bank account."
        actions={can(role, 'expenses.submit') ? <Link href={`/orgs/${orgId}/expenses/new`}><Button>New claim</Button></Link> : null}
      />
      {view === 'mine' && q.data ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Stat label="Waiting for approval" value={<Money value={s.SUBMITTED?.total ?? '0.00'} currency={c} />} sub={`${s.SUBMITTED?.count ?? 0} claims`} />
          <Stat label="Approved, to be paid to you" value={<Money value={s.APPROVED?.total ?? '0.00'} currency={c} />} sub={`${s.APPROVED?.count ?? 0} claims`} tone="accent" />
          <Stat label="Paid back" value={<Money value={s.REIMBURSED?.total ?? '0.00'} currency={c} />} sub={`${s.REIMBURSED?.count ?? 0} claims`} tone="positive" />
        </div>
      ) : null}
      {views.length > 1 ? (
        <div role="tablist" aria-label="Which claims" className="mb-4 flex flex-wrap gap-1">
          {views.map((t) => (
            <button key={t.v} role="tab" aria-selected={view === t.v} onClick={() => setView(t.v)} className={`rounded-md px-3 py-1.5 text-sm ${view === t.v ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg'}`}>
              {t.label}{t.v === view && q.data ? ` (${q.data.total})` : ''}
            </button>
          ))}
        </div>
      ) : null}
      <Card>
        {q.data && items.length === 0 ? (
          <EmptyState title={view === 'mine' ? 'No claims yet' : view === 'approve' ? 'Nothing is waiting for approval' : view === 'reimburse' ? 'Nothing to pay back' : 'No claims yet'}>
            {view === 'mine' ? 'Add what you spent, attach the receipts and submit it for approval.' : null}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><Th>Claim</Th><Th>Title</Th>{view !== 'mine' ? <Th>Claimant</Th> : null}<Th>Submitted</Th><Th numeric>Total</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <Tr key={x.id}>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/${x.id}`}>{x.number}</Link></Td>
                  <Td>{x.title}<p className="text-xs text-fg-muted">{x.lineCount} {x.lineCount === 1 ? 'line' : 'lines'}</p></Td>
                  {view !== 'mine' ? <Td>{x.claimant}</Td> : null}
                  <Td className="text-fg-muted">{x.submittedAt ? date(x.submittedAt.slice(0, 10)) : '—'}</Td>
                  <Td numeric><Money value={x.total} currency={c} /></Td>
                  <Td><ClaimStatus status={x.status} />{view === 'approve' && !x.canApprove ? <p className="mt-1 text-xs text-fg-muted">Your own claim</p> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
