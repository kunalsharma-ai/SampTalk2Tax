'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, SectionHelpSlot, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { can, type Role } from '@/lib/types';

/** Approval of manual journals (SEC-036). */

type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
interface RequestView {
  id: string;
  status: Status;
  total: string;
  note: string | null;
  requestedBy: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  coversCurrentDraft: boolean;
  canDecide: boolean;
  canWithdraw: boolean;
}
interface EntryApproval {
  entryId: string;
  required: boolean;
  minAmount: string | null;
  approved: boolean;
  current: RequestView | null;
  history: RequestView[];
}
interface Policy {
  currency: string;
  isActive: boolean;
  minAmount: string | null;
}
interface InboxItem {
  id: string;
  entryId: string;
  date: string | null;
  memo: string | null;
  total: string;
  currency: string;
  status: Status;
  note: string | null;
  requestedBy: string | null;
  requestedAt: string;
  canDecide: boolean;
}

const STATUS: Record<Status, { label: string; tone: 'warning' | 'positive' | 'negative' | 'neutral' }> = {
  PENDING: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'positive' },
  REJECTED: { label: 'Rejected', tone: 'negative' },
  CANCELLED: { label: 'Withdrawn', tone: 'neutral' },
};

export function useJournalApproval(orgId: string, entryId: string) {
  return useQuery({ queryKey: ['journal-approval', orgId, entryId], queryFn: () => api<EntryApproval>(`/v1/orgs/${orgId}/journals/${entryId}/approval`) });
}

/** On a journal: whether it needs approval, where its request stands, and the actions. */
export function JournalApprovalCard({ orgId, entryId, role, isDraft, currency }: { orgId: string; entryId: string; role: Role; isDraft: boolean; currency: string }) {
  const qc = useQueryClient();
  const q = useJournalApproval(orgId, entryId);
  const [note, setNote] = useState('');
  const act = useMutation({
    mutationFn: (a: { path: string; body?: Record<string, unknown> }) => api<EntryApproval>(`/v1/orgs/${orgId}${a.path}`, { method: 'POST', body: a.body ?? {} }),
    onSuccess: async (d) => {
      setNote('');
      qc.setQueryData(['journal-approval', orgId, entryId], d);
      await qc.invalidateQueries({ queryKey: ['journal-approvals', orgId] });
    },
  });
  const a = q.data;
  if (!a || (!a.required && !a.history.length)) return null;
  const cur = a.current;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Journal approval"
        help={<SectionHelpSlot title="Journal approval" />}
        description={a.required ? `Manual journals of ${a.minAmount ? Number(a.minAmount).toLocaleString('en-IN') : ''} ${currency} or more need someone else's approval before they post. Changing the draft withdraws the request.` : 'Approval history of this journal.'}
        actions={cur ? <Badge tone={STATUS[cur.status].tone}>{STATUS[cur.status].label}</Badge> : null}
      />
      <div className="space-y-3 p-5 text-sm">
        {isDraft && a.required && !cur && can(role, 'journals.create') ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1"><Field label="Note for the approver (optional)">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="What this journal is for" />}</Field></div>
            <Button onClick={() => act.mutate({ path: `/journals/${entryId}/approval`, body: { note: note || null } })} disabled={act.isPending}>Ask for approval</Button>
          </div>
        ) : null}
        {cur ? (
          <p>
            Asked by {cur.requestedBy ?? 'someone'} on {dateTime(cur.requestedAt)} for <Money value={cur.total} currency={currency} />{cur.note ? <span className="text-fg-muted">: {cur.note}</span> : null}.
            {cur.decidedBy ? <> {STATUS[cur.status].label} by {cur.decidedBy}{cur.decisionNote ? <span className="text-fg-muted">: {cur.decisionNote}</span> : null}.</> : null}
          </p>
        ) : null}
        {cur?.status === 'APPROVED' && isDraft ? <p className="text-positive">Approved: it can now be posted.</p> : null}
        {cur?.status === 'REJECTED' && isDraft && can(role, 'journals.create') ? (
          <Button size="sm" variant="secondary" onClick={() => act.mutate({ path: `/journals/${entryId}/approval`, body: {} })} disabled={act.isPending}>Ask again</Button>
        ) : null}
        {cur?.canDecide ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1"><Field label="Decision note">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Needed to reject" />}</Field></div>
            <Button onClick={() => act.mutate({ path: `/journal-approvals/${cur.id}/approve`, body: { note: note || null } })} disabled={act.isPending}>Approve</Button>
            <Button variant="secondary" onClick={() => act.mutate({ path: `/journal-approvals/${cur.id}/reject`, body: { note } })} disabled={act.isPending || !note.trim()}>Reject</Button>
          </div>
        ) : null}
        {cur?.status === 'PENDING' && !cur.canDecide && !cur.canWithdraw ? <p className="text-fg-muted">Someone other than who drafted it or asked decides.</p> : null}
        {cur?.canWithdraw ? <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: `/journal-approvals/${cur.id}/withdraw` })} disabled={act.isPending}>Withdraw request</Button> : null}
        <ErrorAlert title="Could not do that" error={act.error as Error | null} />
      </div>
    </Card>
  );
}

/** On Approval rules: the amount from which manual journals need approval. */
export function JournalApprovalPolicyCard({ orgId, role }: { orgId: string; role: Role }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['journal-approval-policy', orgId], queryFn: () => api<Policy>(`/v1/orgs/${orgId}/journal-approvals/policy`) });
  const [edit, setEdit] = useState<{ minAmount: string; isActive: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (b: { minAmount: string; isActive: boolean }) => api<Policy>(`/v1/orgs/${orgId}/journal-approvals/policy`, { method: 'PUT', body: b }),
    onSuccess: (d) => {
      qc.setQueryData(['journal-approval-policy', orgId], d);
      setEdit(null);
    },
  });
  const p = q.data;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Manual journals"
        help={<SectionHelpSlot title="Manual journals" />}
        description="Journals typed in by hand above an amount post only after someone other than who drafted it approves the draft exactly as it is. Journals from invoices, bills, payroll and other modules follow their own rules."
        actions={p ? (p.isActive ? <Badge tone="accent">On</Badge> : <Badge>Off</Badge>) : null}
      />
      <div className="space-y-3 p-5 text-sm">
        {p && !edit ? (
          <div className="flex flex-wrap items-center gap-3">
            <span>{p.isActive && p.minAmount ? <>Needs approval from <Money value={p.minAmount} currency={p.currency} /></> : 'No approval needed for manual journals.'}</span>
            {can(role, 'org.manage') ? <Button size="sm" variant="ghost" onClick={() => setEdit({ minAmount: p.minAmount ?? '0.00', isActive: p.minAmount ? p.isActive : true })}>Edit</Button> : null}
          </div>
        ) : null}
        {edit ? (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(edit); }}>
            <label className="flex items-center gap-2"><input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Require an approval</label>
            <Field label="For journals of at least">{(p2) => <Input {...p2} inputMode="decimal" value={edit.minAmount} onChange={(e) => /^\d{0,18}(\.\d{0,2})?$/.test(e.target.value) && setEdit({ ...edit, minAmount: e.target.value })} />}</Field>
            <Button type="submit" disabled={save.isPending || edit.minAmount === ''}>Save</Button>
            <Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
          </form>
        ) : null}
        <ErrorAlert title="Could not save" error={save.error as Error | null} />
      </div>
    </Card>
  );
}

/** On Approvals: manual journals waiting for a decision. */
export function JournalApprovalsInbox({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: ['journal-approvals', orgId], queryFn: () => api<InboxItem[]>(`/v1/orgs/${orgId}/journal-approvals?status=PENDING`) });
  const items = q.data ?? [];
  return (
    <Card className="mt-6">
      <CardHeader title="Manual journals to approve" />
      {q.data && !items.length ? <EmptyState title="No journals waiting">Manual journals above the amount in Approval rules appear here when someone asks for approval.</EmptyState> : null}
      {items.length ? (
        <Table aria-label="Manual journals to approve">
          <thead><tr><Th>Journal</Th><Th>Date</Th><Th numeric>Total</Th><Th>Asked by</Th><Th /></tr></thead>
          <tbody>
            {items.map((i) => (
              <Tr key={i.id}>
                <Td><Link className="text-accent underline" href={`/orgs/${orgId}/journals/${i.entryId}`}>{i.memo || 'Draft journal'}</Link>{i.note ? <span className="block text-xs text-fg-muted">{i.note}</span> : null}</Td>
                <Td className="whitespace-nowrap">{i.date ? date(i.date) : ''}</Td>
                <Td numeric><Money value={i.total} currency={i.currency} /></Td>
                <Td>{i.requestedBy}</Td>
                <Td>{i.canDecide ? <Link className="text-accent underline" href={`/orgs/${orgId}/journals/${i.entryId}`}>Review</Link> : <span className="text-xs text-fg-muted">Someone else decides</span>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}
