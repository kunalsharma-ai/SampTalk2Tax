'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ApprovalBadge, DecisionButtons } from '@/components/approvals/approval-card';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { ApprovalRequest, ApprovalStatus, DocumentKindName } from '@/lib/types';

const KIND: Record<DocumentKindName, { label: string; path: string }> = {
  INVOICE: { label: 'Invoice', path: 'sales/invoices' },
  CREDIT_NOTE: { label: 'Credit note', path: 'sales/invoices' },
  BILL: { label: 'Bill', path: 'purchases/bills' },
  VENDOR_CREDIT: { label: 'Vendor credit', path: 'purchases/bills' },
};
const VIEWS: { v: ApprovalStatus | 'ALL'; label: string }[] = [
  { v: 'PENDING', label: 'Waiting' },
  { v: 'APPROVED', label: 'Approved' },
  { v: 'REJECTED', label: 'Rejected' },
  { v: 'ALL', label: 'All' },
];

export default function ApprovalsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [view, setView] = useState<ApprovalStatus | 'ALL'>('PENDING');
  const q = useQuery({ queryKey: ['approvals', orgId, view], queryFn: () => api<{ total: number; items: ApprovalRequest[] }>(`/v1/orgs/${orgId}/approvals?limit=200${view === 'ALL' ? '' : `&status=${view}`}`) });
  if (!org) return null;
  const refresh = async () => {
    for (const k of ['approvals', 'approval', 'document', 'documents', 'dashboard']) await qc.invalidateQueries({ queryKey: [k, orgId] });
  };
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader title="Approvals" description="Invoices and bills that need a second person’s approval before they post, under the rules in Approval rules. Approving records your name; editing a draft afterwards cancels the approval." />
      <div role="tablist" aria-label="Approval status" className="mb-4 flex flex-wrap gap-1">
        {VIEWS.map((t) => (
          <button key={t.v} role="tab" aria-selected={view === t.v} onClick={() => setView(t.v)} className={`rounded-md px-3 py-1.5 text-sm ${view === t.v ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg'}`}>
            {t.label}{t.v === view && q.data ? ` (${q.data.total})` : ''}
          </button>
        ))}
      </div>
      <Card>
        {q.data && items.length === 0 ? (
          <EmptyState title={view === 'PENDING' ? 'Nothing is waiting for approval' : 'No requests here'}>
            {view === 'PENDING' ? <>Drafts submitted for approval appear here. Rules are set in <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/approvals`}>Approval rules</Link>.</> : null}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><Th>Submitted</Th><Th>Document</Th><Th>Contact</Th><Th numeric>Total</Th><Th>Status</Th><Th>Submitted by</Th><Th><span className="sr-only">Actions</span></Th></tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <Tr key={r.id}>
                  <Td>{date(r.requestedAt.slice(0, 10))}</Td>
                  <Td>
                    {r.documentId ? (
                      <Link className="text-accent hover:underline" href={`/orgs/${orgId}/${KIND[r.documentKind].path}/${r.documentId}`}>{KIND[r.documentKind].label} {r.documentNumber ?? '(draft)'}</Link>
                    ) : (
                      <span className="text-fg-muted">{KIND[r.documentKind].label} (draft deleted)</span>
                    )}
                    {r.note ? <p className="text-xs text-fg-muted">{r.note}</p> : null}
                  </Td>
                  <Td>{r.contactName}</Td>
                  <Td numeric><Money value={r.total} currency={org.functionalCurrency} /></Td>
                  <Td>
                    <ApprovalBadge status={r.status} />
                    {r.decidedBy && r.status !== 'PENDING' ? <p className="mt-1 text-xs text-fg-muted">{r.decidedBy}{r.decisionNote ? `: ${r.decisionNote}` : ''}</p> : null}
                  </Td>
                  <Td className="text-fg-muted">{r.requestedBy}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-2">
                      {r.status === 'PENDING' && !r.canApprove && r.ownWork ? <span className="text-xs text-fg-muted">Needs someone else</span> : null}
                      <DecisionButtons r={r} currency={org.functionalCurrency} onDone={refresh} />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
