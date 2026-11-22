'use client';
import { useQuery } from '@tanstack/react-query';
import type { EvidenceState, ExpenseEvidenceKind } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Pack {
  currency: string;
  id: string;
  number: string;
  title: string;
  claimant: string;
  status: string;
  total: string;
  approvedOn: string | null;
  complete: boolean;
  gaps: ExpenseEvidenceKind[];
  items: { kind: ExpenseEvidenceKind; label: string; state: EvidenceState; detail: string }[];
  files: { id: string; fileName: string; sha256: string; uploadedAt: string }[];
  events: { action: string; by: string | null; at: string; hash: string }[];
}

const STATE_TONE: Record<EvidenceState, 'positive' | 'accent' | 'negative' | 'warning' | 'neutral'> = { OK: 'positive', NOTED: 'accent', GAP: 'negative', PENDING: 'warning', NA: 'neutral' };
const STATE_LABEL: Record<EvidenceState, string> = { OK: 'OK', NOTED: 'Noted', GAP: 'Gap', PENDING: 'Pending', NA: 'n/a' };
const ACTION: Record<string, string> = {
  'expense_claim.created': 'Created',
  'expense_claim.updated': 'Changed',
  'expense_claim.submitted': 'Submitted',
  'expense_claim.withdrawn': 'Withdrawn',
  'expense_claim.approved': 'Approved',
  'expense_claim.rejected': 'Rejected',
  'expense_claim.reimbursed': 'Reimbursed',
  'expense_claim.voided': 'Voided',
};

/** One expense claim's audit evidence pack (EXP-027). */
export default function ExpenseEvidencePackPage() {
  const { orgId } = useOrg();
  const { claimId } = useParams<{ claimId: string }>();
  const q = useQuery({ queryKey: ['expense-evidence-pack', orgId, claimId], queryFn: () => api<Pack>(`/v1/orgs/${orgId}/expense-evidence/${claimId}`) });
  const p = q.data;
  return (
    <>
      <PageHeader
        title={p ? `Evidence pack: ${p.number}` : 'Evidence pack'}
        description={p ? `${p.title} · ${p.claimant}. Collected from the claim, its files, journal entries, bank statement and the audit trail.` : undefined}
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/expenses/${claimId}`}>Open the claim</Link>}
      />
      <ErrorAlert title="Could not load the evidence pack" error={q.error} />
      {p ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Stat label="Evidence" value={p.complete ? 'Complete' : `${p.gaps.length} ${p.gaps.length === 1 ? 'gap' : 'gaps'}`} tone={p.complete ? 'positive' : 'negative'} />
            <Stat label="Total" value={<Money value={p.total} currency={p.currency} />} sub={p.approvedOn ? `Journal date ${date(p.approvedOn)}` : undefined} />
            <Stat label="Receipt files" value={p.files.length} sub={`${p.events.length} audit events`} />
          </div>
          <Card className="mb-4">
            <CardHeader title="Evidence collected" description="A gap needs fixing; Noted means an exception with its reason on record; Pending is not due yet." />
            <Table aria-label="Evidence collected">
              <thead><Tr><Th>Evidence</Th><Th>State</Th><Th>What the records show</Th></Tr></thead>
              <tbody>
                {p.items.map((i) => (
                  <Tr key={i.kind}>
                    <Td className="whitespace-nowrap">{i.label}</Td>
                    <Td><Badge tone={STATE_TONE[i.state]}>{STATE_LABEL[i.state]}</Badge></Td>
                    <Td className="text-sm">{i.detail}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card className="mb-4">
            <CardHeader title="Receipt files and checksums" description="The SHA-256 of each file as stored; a copy can be checked against it." />
            {!p.files.length ? (
              <EmptyState title="No receipt files">Ask the claimant to attach the receipts on the claim.</EmptyState>
            ) : (
              <Table aria-label="Receipt files and checksums">
                <thead><Tr><Th>File</Th><Th>Uploaded</Th><Th>SHA-256</Th></Tr></thead>
                <tbody>
                  {p.files.map((f) => (
                    <Tr key={f.id}>
                      <Td>{f.fileName}</Td>
                      <Td className="whitespace-nowrap">{date(f.uploadedAt.slice(0, 10))}</Td>
                      <Td className="break-all font-mono text-xs">{f.sha256}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Claim audit trail" description={<>Each event is hash-chained to the one before it. The full trail is under <Link className="text-accent hover:underline" href={`/orgs/${orgId}/audit`}>Audit trail</Link>.</>} />
            <Table aria-label="Claim audit trail">
              <thead><Tr><Th>Event</Th><Th>By</Th><Th>When (UTC)</Th><Th>Hash</Th></Tr></thead>
              <tbody>
                {p.events.map((e) => (
                  <Tr key={e.hash}>
                    <Td>{ACTION[e.action] ?? e.action}</Td>
                    <Td>{e.by ?? '—'}</Td>
                    <Td className="whitespace-nowrap">{e.at.slice(0, 16).replace('T', ' ')}</Td>
                    <Td className="font-mono text-xs">{e.hash.slice(0, 16)}…</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : null}
    </>
  );
}
