'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { EVIDENCE_STATUS, type EvidenceRequest } from '@/components/controls/evidence';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface List {
  requests: EvidenceRequest[];
  summary: { requested: number; submitted: number; accepted: number; overdue: number; mine: number };
}

/** Audit evidence management (AUDIT-003): every evidence request across internal audits. */
export default function AuditEvidencePage() {
  const { org, orgId } = useOrg();
  const [show, setShow] = useState<'ALL' | 'MINE'>('ALL');
  const q = useQuery({ queryKey: ['audit-evidence', orgId], queryFn: () => api<List>(`/v1/orgs/${orgId}/audit-evidence`) });
  if (!org) return null;
  const d = q.data;
  const rows = (d?.requests ?? []).filter((r) => show === 'ALL' || r.mine);
  return (
    <>
      <PageHeader title="Audit evidence" description="Evidence internal audits have asked for: who is to provide it, by when, and whether it was accepted. The audit lead asks for it from the engagement." />
      <ErrorAlert title="Could not load" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-4">
            <Stat label="Waiting for you" value={d.summary.mine} tone={d.summary.mine ? 'warning' : 'neutral'} />
            <Stat label="Requested" value={d.summary.requested} sub={d.summary.overdue ? `${d.summary.overdue} overdue` : 'None overdue'} tone={d.summary.overdue ? 'negative' : 'neutral'} />
            <Stat label="To check" value={d.summary.submitted} tone={d.summary.submitted ? 'warning' : 'neutral'} />
            <Stat label="Accepted" value={d.summary.accepted} tone="positive" />
          </div>
          <Card>
            <CardHeader
              title="Evidence requested"
              description="Submitted evidence first, then what is still requested."
              actions={<Select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as 'ALL' | 'MINE')}><option value="ALL">All requests</option><option value="MINE">Waiting for me</option></Select>}
            />
            {!rows.length ? (
              <EmptyState title="No evidence requests">{show === 'MINE' ? 'Nothing is waiting for you.' : 'Ask for evidence from an internal audit engagement.'}</EmptyState>
            ) : (
              <Table aria-label="Evidence requests">
                <thead><Tr><Th>Ref</Th><Th>Evidence</Th><Th>Engagement</Th><Th>Asked of</Th><Th>Due</Th><Th>Status</Th></Tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id}>
                      <Td className="num">{r.reference}</Td>
                      <Td><Link className="hover:text-accent" href={`/orgs/${orgId}/audit-evidence/${r.id}`}>{r.title}</Link><div className="text-xs text-fg-muted">{r.files.length ? `${r.files.length} ${r.files.length === 1 ? 'file' : 'files'} submitted` : 'No files submitted'}</div></Td>
                      <Td className="text-sm"><Link className="hover:text-accent" href={`/orgs/${orgId}/audit-engagements/${r.engagement.id}`}>{r.engagement.reference}</Link> {r.engagement.name}</Td>
                      <Td className="text-sm">{r.owner.name}</Td>
                      <Td className="whitespace-nowrap text-sm">{date(r.dueDate)}{r.overdue ? <div><Badge tone="negative">Overdue</Badge></div> : null}</Td>
                      <Td><Badge tone={EVIDENCE_STATUS[r.status].tone}>{EVIDENCE_STATUS[r.status].label}</Badge></Td>
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
