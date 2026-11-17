'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { SEVERITY_LABEL, SEVERITY_TONE, type BillCheckList } from '@/lib/bill-checks';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** Unusual bill checks (AP-031): bills from the last 120 days with findings, to look at before paying. */
export default function BillChecksPage() {
  const { org, orgId } = useOrg();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['bill-checks', orgId, 'list', all], queryFn: () => api<BillCheckList>(`/v1/orgs/${orgId}/purchases/bill-checks${all ? '?includeReviewed=true' : ''}`) });
  if (!org) return null;
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Unusual bills"
        description="Draft and posted bills from the last 120 days compared with the same vendor's earlier bills and bank details: a vendor invoice number used before, much more than usual, a price that went up, a new expense account, bank details just changed. Look before paying, then mark each one reviewed with why it is fine."
      />
      <ErrorAlert title="Could not check bills" error={q.error as Error | null} />
      {r ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-4">
          <Stat label="To review" value={String(r.summary.toReview)} />
          <Stat label="Check first" value={String(r.summary.high)} />
          <Stat label="Reviewed" value={String(r.summary.reviewed)} />
          <Stat label="Bills checked" value={String(r.summary.checked)} />
        </div>
      ) : null}
      <Card>
        <CardHeader
          title="Bills to review"
          description="Most serious first. Open a bill to see every finding and mark it reviewed."
          actions={<label className="flex items-center gap-2 text-sm text-fg-muted"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show reviewed</label>}
        />
        {r && !r.items.length ? <EmptyState title="Nothing unusual">No bill from the last 120 days needs a look.</EmptyState> : null}
        {r?.items.length ? (
          <Table aria-label="Bills to review">
            <thead>
              <tr>
                <Th>Bill</Th>
                <Th>Vendor</Th>
                <Th>Date</Th>
                <Th numeric>Total</Th>
                <Th>Findings</Th>
                <Th>Review</Th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((b) => (
                <Tr key={b.documentId}>
                  <Td className="whitespace-nowrap">
                    <Link className="text-accent underline" href={`/orgs/${orgId}/purchases/bills/${b.documentId}`}>{b.number ?? 'Draft'}</Link>
                    {b.reference ? <span className="block text-xs text-fg-muted">{b.reference}</span> : null}
                  </Td>
                  <Td>{b.vendor}</Td>
                  <Td className="whitespace-nowrap">{date(b.issueDate)}</Td>
                  <Td numeric><Money value={b.total} currency={b.currency} /></Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      {b.findings.map((f) => <Badge key={f.code} tone={SEVERITY_TONE[f.severity]} className="whitespace-nowrap">{f.label}</Badge>)}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-sm">{b.review?.current ? <Badge tone="positive">Reviewed</Badge> : <span className="text-fg-muted">{b.highest ? SEVERITY_LABEL[b.highest] : ''}</span>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
    </>
  );
}
