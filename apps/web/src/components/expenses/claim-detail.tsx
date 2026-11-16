'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AttachmentsPanel } from '@/components/attachments';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type BankAccountSummary, type ExpenseClaim } from '@/lib/types';
import { ClaimForm } from './claim-form';
import { ClaimStatus } from './claims-list';

type DialogKind = 'submit' | 'approve' | 'reject' | 'reimburse' | 'void' | null;

export function ClaimDetail() {
  const { org, orgId } = useOrg();
  const { claimId } = useParams<{ claimId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState(today());
  const [bankId, setBankId] = useState('');
  const [reference, setReference] = useState('');
  const base = `/v1/orgs/${orgId}/expense-claims/${claimId}`;
  const q = useQuery({ queryKey: ['expense-claim', orgId, claimId], queryFn: () => api<ExpenseClaim>(base) });
  const c0 = q.data;
  // Only people who pay claims back need the bank accounts (employees cannot read them).
  const banks = useQuery({ enabled: !!c0?.actions.reimburse, queryKey: ['bank-accounts', orgId], queryFn: () => api<BankAccountSummary[]>(`/v1/orgs/${orgId}/banking/accounts`) });
  const refresh = async () => {
    for (const k of ['expense-claim', 'expense-claims', 'dashboard', 'journals', 'bank-accounts']) await qc.invalidateQueries({ queryKey: [k, orgId] });
  };
  const run = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: Record<string, unknown> }) => api<ExpenseClaim>(`${base}/${action}`, { method: 'POST', body: body ?? {} }),
    onSuccess: async () => {
      setDialog(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(base, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['expense-claims', orgId] });
      router.replace(`/orgs/${orgId}/expenses`);
    },
  });
  const c = q.data;
  if (!org) return null;
  if (q.error) return <Alert title="Claim not found">{(q.error as Error).message}</Alert>;
  if (!c) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = c.currency;
  const a = c.actions;
  const open = (d: DialogKind) => {
    run.reset();
    setNote('');
    setWhen(today());
    setReference('');
    setBankId(banks.data?.find((b) => b.subtype === 'BANK' && b.isActive)?.id ?? '');
    setDialog(d);
  };
  const dupes = c.lines.filter((l) => l.possibleDuplicateOf.length);
  const finance = org.role !== 'EMPLOYEE';

  if (editing && a.edit) {
    return (
      <>
        <PageHeader title={`Edit ${c.number}`} description={c.status === 'REJECTED' ? 'Saving turns it back into a draft; submit it again when it is ready.' : undefined} />
        <ClaimForm existing={c} onCancel={() => setEditing(false)} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`${c.number} · ${c.title}`}
        description={<>Claimed by {c.claimant}{c.submittedAt ? `, submitted ${date(c.submittedAt.slice(0, 10))}` : ''}</>}
        actions={
          <>
            {a.delete ? <Button variant="danger" loading={remove.isPending} onClick={() => confirm('Delete this draft claim? This cannot be undone.') && remove.mutate()}>Delete draft</Button> : null}
            {a.edit ? <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button> : null}
            {a.withdraw ? <Button variant="ghost" loading={run.isPending} onClick={() => run.mutate({ action: 'withdraw' })}>Withdraw</Button> : null}
            {a.submit ? <Button onClick={() => open('submit')}>Submit for approval</Button> : null}
            {a.decide ? (
              <>
                <Button variant="secondary" onClick={() => open('reject')}>Reject…</Button>
                <Button onClick={() => open('approve')}>Approve…</Button>
              </>
            ) : null}
            {a.void ? <Button variant="ghost" onClick={() => open('void')}>Void…</Button> : null}
            {a.reimburse ? <Button onClick={() => open('reimburse')}>Pay back…</Button> : null}
          </>
        }
      />
      {run.error && !dialog ? <Alert title="Action failed">{run.error.message}</Alert> : null}
      {c.status === 'REJECTED' ? (
        <div className="mb-4"><Alert tone="negative" title={`Rejected by ${c.decidedBy ?? 'an approver'}`}>{c.decisionNote}. Edit the claim and submit it again.</Alert></div>
      ) : null}
      {c.status === 'SUBMITTED' && !a.decide && can(org.role, 'approvals.decide') ? (
        <div className="mb-4"><Alert tone="accent" title="Your own claim">Someone else with approval rights must approve it.</Alert></div>
      ) : null}
      {c.status === 'VOID' ? (
        <div className="mb-4"><Alert tone="negative" title={`Voided on ${date(c.voidDate!)}`}>{c.voidReason}. The expense posting was reversed.</Alert></div>
      ) : null}
      {dupes.length && ['DRAFT', 'SUBMITTED', 'REJECTED'].includes(c.status) ? (
        <div className="mb-4">
          <Alert tone="warning" title="Possibly claimed before">
            {dupes.map((l) => `Line ${l.lineNo} has the same date and amount as ${l.possibleDuplicateOf.join(', ')}`).join('. ')}. Check it is not the same receipt.
          </Alert>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Status</p>
          <div className="mt-2"><ClaimStatus status={c.status} /></div>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Total</p>
          <p className="mt-2 text-sm"><Money value={c.total} currency={cur} /></p>
          {c.taxTotal !== '0.00' ? <p className="text-xs text-fg-muted">incl. tax <Money value={c.taxTotal} currency={cur} /></p> : null}
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Approval</p>
          <p className="mt-2 text-sm">{c.status === 'APPROVED' || c.status === 'REIMBURSED' || c.status === 'VOID' ? <>{c.decidedBy}, {date(c.postingDate!)}</> : <span className="text-fg-muted">Not yet</span>}</p>
          {c.decisionNote && c.status !== 'REJECTED' ? <p className="text-xs text-fg-muted">“{c.decisionNote}”</p> : null}
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Paid back</p>
          <p className="mt-2 text-sm">{c.reimbursedOn ? <>{date(c.reimbursedOn)}{c.bankAccount ? <span className="text-fg-muted"> · {c.bankAccount}</span> : null}</> : <span className="text-fg-muted">Not yet</span>}</p>
          {c.reimbursementReference ? <p className="text-xs text-fg-muted">Ref {c.reimbursementReference}</p> : null}
        </Card>
      </div>
      {finance && (c.journalEntryId || c.reimbursementJournalEntryId) ? (
        <p className="mt-4 text-sm text-fg-muted">
          {c.journalEntryId ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${c.journalEntryId}`}>Expense journal</Link> : null}
          {c.reimbursementJournalEntryId ? <> · <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${c.reimbursementJournalEntryId}`}>Reimbursement journal</Link></> : null}
          {c.voidJournalEntryId ? <> · <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${c.voidJournalEntryId}`}>Reversal</Link></> : null}
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHeader title="Lines" />
        <Table>
          <thead>
            <tr><Th>#</Th><Th>Date</Th><Th>Category</Th><Th>Merchant and description</Th><Th>Tax rate</Th><Th numeric>Tax</Th><Th numeric>Paid</Th></tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <Tr key={l.lineNo}>
                <Td className="text-fg-muted">{l.lineNo}</Td>
                <Td>{date(l.date)}</Td>
                <Td className="text-fg-muted"><span className="num">{l.accountCode}</span> {l.accountName}</Td>
                <Td>{[l.merchant, l.description].filter(Boolean).join(' · ') || <span className="text-fg-faint">—</span>}{l.possibleDuplicateOf.length ? <p className="text-xs text-warning">Same date and amount as {l.possibleDuplicateOf.join(', ')}</p> : null}</Td>
                <Td className="text-fg-muted">{l.taxName ?? '—'}</Td>
                <Td numeric><Money value={l.taxAmount} currency={cur} /></Td>
                <Td numeric><Money value={l.amount} currency={cur} /></Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={5} className="text-right font-semibold">Total</Td>
              <Td numeric><Money value={c.taxTotal} currency={cur} /></Td>
              <Td numeric className="font-semibold"><Money value={c.total} currency={cur} /></Td>
            </tr>
          </tfoot>
        </Table>
      </Card>

      <AttachmentsPanel
        entityType="EXPENSE_CLAIM"
        entityId={c.id}
        canManage={a.attach}
        description={c.receiptCount === 0 && ['DRAFT', 'REJECTED', 'SUBMITTED'].includes(c.status) ? 'No receipts attached yet. Add a photo or PDF of each receipt (PDF, PNG, JPEG or WebP, up to 5 MB).' : 'Receipts for this claim, kept exactly as uploaded.'}
      />

      <Dialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        title={{ submit: `Submit ${c.number} for approval`, approve: `Approve ${c.number}`, reject: `Reject ${c.number}`, reimburse: `Pay back ${c.number}`, void: `Void ${c.number}` }[dialog ?? 'submit']}
        description={
          {
            submit: 'Someone with approval rights will review it. You can withdraw it until then.',
            approve: `Approving records ${c.claimant}'s expenses in the books and what the business owes them.`,
            reject: `${c.claimant} sees your reason and can fix the claim and submit it again.`,
            reimburse: `Records the payment of ${c.total} to ${c.claimant} from a bank or cash account.`,
            void: 'Reverses the expense posting. The claim stays on record, marked void.',
          }[dialog ?? 'submit']
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (dialog === 'submit') run.mutate({ action: 'submit' });
            if (dialog === 'approve') run.mutate({ action: 'approve', body: { note: note || null, date: when } });
            if (dialog === 'reject') run.mutate({ action: 'reject', body: { note } });
            if (dialog === 'reimburse') run.mutate({ action: 'reimburse', body: { bankAccountId: bankId, date: when, reference: reference || null } });
            if (dialog === 'void') run.mutate({ action: 'void', body: { date: when, reason: note } });
          }}
        >
          {run.error ? <Alert title="Could not complete this">{run.error instanceof ApiError ? run.error.message : 'Try again.'}</Alert> : null}
          {dialog === 'submit' && c.receiptCount === 0 ? <Alert tone="warning" title="No receipts attached">You can still submit, but the approver may ask for them.</Alert> : null}
          {dialog === 'approve' && c.receiptCount === 0 ? <Alert tone="warning" title="No receipts attached">This claim has no receipts.</Alert> : null}
          {dialog === 'approve' && dupes.length ? <Alert tone="warning" title="Possibly claimed before">{dupes.length} line(s) match an earlier claim by date and amount.</Alert> : null}
          {dialog === 'approve' ? (
            <>
              <Field label="Note (optional)">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              <Field label="Posting date" hint="The date the expense is recorded in the books.">{(p) => <Input {...p} type="date" required value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
            </>
          ) : null}
          {dialog === 'reject' || dialog === 'void' ? <Field label="Reason">{(p) => <Input {...p} required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />}</Field> : null}
          {dialog === 'reimburse' ? (
            <>
              <Field label="Paid from">
                {(p) => (
                  <Select {...p} required value={bankId} onChange={(e) => setBankId(e.target.value)}>
                    <option value="">Choose an account…</option>
                    {(banks.data ?? []).filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Payment date">{(p) => <Input {...p} type="date" required min={c.postingDate ?? undefined} value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
              <Field label="Reference (optional)" hint="For example the bank transfer number.">{(p) => <Input {...p} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
            </>
          ) : null}
          {dialog === 'void' ? <Field label="Void date">{(p) => <Input {...p} type="date" required min={c.postingDate ?? undefined} value={when} onChange={(e) => setWhen(e.target.value)} />}</Field> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
            <Button type="submit" variant={dialog === 'reject' || dialog === 'void' ? 'danger' : 'primary'} loading={run.isPending}>
              {{ submit: 'Submit', approve: 'Approve and post', reject: 'Reject', reimburse: 'Record payment', void: 'Void claim' }[dialog ?? 'submit']}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
