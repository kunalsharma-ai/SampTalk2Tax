'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { lastMonthEnd, STATE_LABEL, STATE_TONE, type ReconList } from '@/lib/account-reconciliations';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';

/** Balance sheet account reconciliations (GL-032): every asset and liability account at a date. */
export default function AccountReconciliationsPage() {
  return (
    <Suspense>
      <Reconciliations />
    </Suspense>
  );
}

function Reconciliations() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const asOf = params.get('asOf') || lastMonthEnd();
  const q = useQuery({ queryKey: ['account-reconciliations', orgId, asOf], queryFn: () => api<ReconList>(`/v1/orgs/${orgId}/account-reconciliations?asOf=${asOf}`) });
  if (!org) return null;
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Account reconciliations"
        description="Explain the balance of every asset and liability account at a date with the items behind it: a stock count, a loan statement, a prepaid schedule, a statutory payable. The preparer signs off once the items explain the balance exactly, and someone else reviews it. A posting after sign-off shows the account as changed."
      />
      <ErrorAlert title="Could not load reconciliations" error={q.error as Error | null} />
      <div className="mb-4 max-w-xs">
        <Field label="Reconcile to">{(p) => <Input {...p} type="date" value={asOf} onChange={(e) => e.target.value && router.replace(`/orgs/${orgId}/account-reconciliations?asOf=${e.target.value}`)} />}</Field>
      </div>
      {r ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-4">
          <Stat label="Reviewed" value={`${r.counts.REVIEWED} of ${r.accounts.length}`} tone={r.counts.REVIEWED === r.accounts.length ? 'positive' : 'neutral'} />
          <Stat label="Waiting for review" value={String(r.counts.PREPARED)} />
          <Stat label="Not started or in progress" value={String(r.counts.NOT_STARTED + r.counts.DRAFT)} />
          <Stat label="Changed since sign-off" value={String(r.counts.CHANGED)} tone={r.counts.CHANGED ? 'negative' : 'neutral'} />
        </div>
      ) : null}
      <Card>
        <CardHeader title="Balance sheet accounts" description="Balances in the natural sign of each account: debit for assets, credit for liabilities. Receivable and payable control accounts are compared with the open items in their ledgers." />
        {r ? (
          <Table aria-label="Balance sheet accounts">
            <thead>
              <tr>
                <Th>Account</Th>
                <Th numeric>Ledger balance</Th>
                <Th numeric>Subsidiary ledger</Th>
                <Th>Status</Th>
                <Th numeric>Unexplained</Th>
                <Th>Signed off by</Th>
              </tr>
            </thead>
            <tbody>
              {r.accounts.map((a) => (
                <Tr key={a.accountId}>
                  <Td>
                    <Link className="text-accent underline" href={`/orgs/${orgId}/account-reconciliations/${a.accountId}?asOf=${asOf}`}><span className="num">{a.code}</span> {a.name}</Link>
                    {a.isBank ? <span className="block text-xs text-fg-muted">Bank or cash: <Link className="underline" href={`/orgs/${orgId}/banking/${a.accountId}/reconcile`}>reconcile to the statement</Link></span> : null}
                  </Td>
                  <Td numeric><Money value={a.ledgerBalance} currency={r.currency} /></Td>
                  <Td numeric>
                    {a.subledgerBalance !== null ? (
                      <>
                        <Money value={a.subledgerBalance} currency={r.currency} />
                        {a.subledgerDifference && Number(a.subledgerDifference) !== 0 ? <span className="block text-xs text-negative">Off by <Money value={a.subledgerDifference} currency={r.currency} /></span> : null}
                      </>
                    ) : <span className="text-fg-faint">–</span>}
                  </Td>
                  <Td><Badge tone={STATE_TONE[a.state]} className="whitespace-nowrap">{STATE_LABEL[a.state]}</Badge></Td>
                  <Td numeric>{a.difference !== null ? <Money value={a.difference} currency={r.currency} /> : <span className="text-fg-faint">–</span>}</Td>
                  <Td className="text-sm text-fg-muted">{[a.preparedBy && `Prepared: ${a.preparedBy}`, a.reviewedBy && `Reviewed: ${a.reviewedBy}`].filter(Boolean).join(' · ') || '–'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
    </>
  );
}
