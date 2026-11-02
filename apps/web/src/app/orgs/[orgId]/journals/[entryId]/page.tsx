'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { JournalForm } from '@/components/journal-form';
import { AttachmentsPanel } from '@/components/attachments';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type Journal } from '@/lib/types';

export default function JournalDetailPage() {
  const { org, orgId } = useOrg();
  const { entryId } = useParams<{ entryId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseDate, setReverseDate] = useState(today());
  const [reverseMemo, setReverseMemo] = useState('');
  const q = useQuery({ queryKey: ['journal', orgId, entryId], queryFn: () => api<Journal>(`/v1/orgs/${orgId}/journals/${entryId}`) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['journal', orgId] });
    await qc.invalidateQueries({ queryKey: ['journals', orgId] });
    await qc.invalidateQueries({ queryKey: ['dashboard', orgId] });
  };
  const post = useMutation({ mutationFn: () => api<Journal>(`/v1/orgs/${orgId}/journals/${entryId}/post`, { method: 'POST' }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/journals/${entryId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      router.replace(`/orgs/${orgId}/journals`);
    },
  });
  const reverse = useMutation({
    mutationFn: () => api<Journal>(`/v1/orgs/${orgId}/journals/${entryId}/reverse`, { method: 'POST', body: { date: reverseDate, memo: reverseMemo || undefined } }),
    onSuccess: async (j) => {
      await refresh();
      setReverseOpen(false);
      router.push(`/orgs/${orgId}/journals/${j.id}`);
    },
  });

  if (!org) return null;
  if (q.error) return <Alert title="Journal not found">{(q.error as Error).message}</Alert>;
  const j = q.data;
  if (!j) return <p className="text-sm text-fg-muted">Loading…</p>;
  const c = org.functionalCurrency;
  const err = post.error ?? remove.error;

  if (editing && j.status === 'DRAFT') {
    return (
      <>
        <PageHeader title="Edit draft" actions={<Button variant="ghost" onClick={() => setEditing(false)}>Back</Button>} />
        <JournalForm existing={j} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={j.displayNumber ? `Journal ${j.displayNumber}` : 'Draft journal'}
        description={j.memo ?? undefined}
        actions={
          <>
            {j.status === 'DRAFT' && can(org.role, 'journals.create') ? (
              <>
                <Button variant="danger" loading={remove.isPending} onClick={() => confirm('Delete this draft? This cannot be undone.') && remove.mutate()}>Delete draft</Button>
                <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
              </>
            ) : null}
            {j.status === 'DRAFT' && can(org.role, 'journals.post') ? <Button loading={post.isPending} onClick={() => post.mutate()}>Post</Button> : null}
            {j.status === 'POSTED' && (j.source === 'MANUAL' || j.source === 'CLOSE') && !j.reversedBy && j.type !== 'REVERSING' && can(org.role, 'journals.reverse') ? (
              <Button variant="secondary" onClick={() => setReverseOpen(true)}>Reverse…</Button>
            ) : null}
          </>
        }
      />
      {err ? <Alert title="Action failed">{err instanceof ApiError ? err.message : 'Try again.'}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Status</p>
          <div className="mt-2">{j.status === 'DRAFT' ? <Badge tone="warning">Draft · not in balances</Badge> : j.reversedBy ? <Badge tone="negative">Posted · reversed</Badge> : <Badge tone="positive">Posted</Badge>}</div>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Date</p>
          <p className="mt-2 text-sm">{date(j.date)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Type</p>
          <p className="mt-2 text-sm capitalize">{j.type.toLowerCase()}{j.reference ? ` · ref ${j.reference}` : ''}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Total</p>
          <p className="mt-2 text-sm"><Money value={j.totalDebit} currency={c} /></p>
        </Card>
      </div>
      {j.source !== 'MANUAL' ? (
        <div className="mt-4">
          <Alert tone="accent" title={`Created by ${j.source === 'DOCUMENT' ? 'a sales or purchase document' : j.source === 'BANK' ? 'a bank statement line' : j.source === 'EXPENSE' ? 'an expense claim' : j.source === 'TAX' ? 'a TDS/TCS deposit' : j.source === 'PAYROLL' ? 'payroll' : j.source === 'CLOSE' ? 'an AI-proposed month-end adjustment a person approved' : j.source === 'ASSET' ? 'the fixed asset register' : j.source === 'DEFERRAL' ? 'a prepaid or deferred revenue schedule' : j.source === 'ACCRUAL' ? 'a month-end accrual' : 'a payment'}${j.reference ? ` (${j.reference})` : ''}`}>
            {j.source === 'PAYROLL'
              ? 'This entry was posted by a pay run or a payroll payment. To correct it, void the payment or the pay run (Payroll → Pay runs).'
              : j.source === 'TAX'
              ? 'This entry was posted when TDS or TCS was deposited with the government. To correct it, void the deposit (Tax → TDS and TCS).'
              : j.source === 'EXPENSE'
              ? 'This entry was posted when an expense claim was approved or reimbursed. To correct an approved, unpaid claim, void the claim.'
              : j.source === 'CLOSE'
              ? 'An adjusting entry the AI model proposed at month end, checked against the books and posted when a person approved it (Accounting → Month-end close). To correct it, reverse it like a manual journal.'
              : j.source === 'ASSET'
              ? 'Posted from the fixed asset register: a purchase, a month of depreciation or a disposal (Accounting → Fixed assets). To correct depreciation, reverse the run on the Depreciation page.'
              : j.source === 'DEFERRAL'
              ? 'Posted from a prepaid expense or deferred revenue schedule: the payment or receipt, a month of releases, or the end of a schedule (Accounting → Prepaid and deferred). To correct releases, reverse the run on the Releases page.'
              : j.source === 'ACCRUAL'
              ? 'Posted from a month-end accrual, which is reversed automatically on the first day of the next month (Accounting → Accruals). To correct it, cancel the accrual there.'
              : j.source === 'BANK'
              ? 'This entry was posted from a bank statement line. To correct it, unmatch that line on the bank account screen, which reverses this entry.'
              : `This entry stays in step with its ${j.source === 'DOCUMENT' ? 'document' : 'payment'}. To correct it, void the ${j.source === 'DOCUMENT' ? 'document' : 'payment'} instead of reversing this journal.`}
          </Alert>
        </div>
      ) : null}
      {j.reversesEntryId ? (
        <div className="mt-4">
          <Alert tone="violet" title="This entry reverses another journal">
            <Link className="text-accent underline" href={`/orgs/${orgId}/journals/${j.reversesEntryId}`}>Open the original entry</Link>
          </Alert>
        </div>
      ) : null}
      {j.reversedBy ? (
        <div className="mt-4">
          <Alert tone="violet" title={`Reversed by JE-${String(j.reversedBy.entryNumber).padStart(6, '0')}`}>
            <Link className="text-accent underline" href={`/orgs/${orgId}/journals/${j.reversedBy.id}`}>Open the reversal</Link>
          </Alert>
        </div>
      ) : null}
      <Card className="mt-6">
        <CardHeader title="Lines" description={j.postedAt ? `Posted ${new Date(j.postedAt).toLocaleString()}` : 'Not posted'} />
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Account</Th>
              <Th>Description</Th>
              <Th numeric>Debit ({c})</Th>
              <Th numeric>Credit ({c})</Th>
            </tr>
          </thead>
          <tbody>
            {j.lines.map((l) => (
              <Tr key={l.lineNo}>
                <Td className="text-fg-muted">{l.lineNo}</Td>
                <Td>
                  <span className="num text-fg-muted">{l.accountCode}</span> {l.accountName}
                  {l.currency !== c ? (
                    <p className="text-xs text-fg-muted">
                      {l.currency} {l.debit !== '0.00' ? l.debit : l.credit} @ {l.exchangeRate}
                    </p>
                  ) : null}
                </Td>
                <Td className="text-fg-muted">{l.description}</Td>
                <Td numeric>{l.functionalDebit !== '0.00' ? <Money value={l.functionalDebit} currency={c} /> : ''}</Td>
                <Td numeric>{l.functionalCredit !== '0.00' ? <Money value={l.functionalCredit} currency={c} /> : ''}</Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={3} className="font-semibold">Total</Td>
              <Td numeric className="font-semibold"><Money value={j.totalDebit} currency={c} /></Td>
              <Td numeric className="font-semibold"><Money value={j.totalCredit} currency={c} /></Td>
            </tr>
          </tfoot>
        </Table>
      </Card>

      <AttachmentsPanel entityType="JOURNAL_ENTRY" entityId={j.id} canManage={can(org.role, 'journals.create')} />

      <Dialog open={reverseOpen} onOpenChange={setReverseOpen} title="Reverse this journal" description="Posts a new entry that swaps every debit and credit at the original rates. The original stays unchanged.">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Reversal date
            <Input type="date" value={reverseDate} min={j.date} onChange={(e) => setReverseDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Memo (optional)
            <Input value={reverseMemo} placeholder={`Reversal of ${j.displayNumber}`} onChange={(e) => setReverseMemo(e.target.value)} />
          </label>
          {reverse.error ? <Alert title="Could not reverse">{reverse.error.message}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReverseOpen(false)}>Cancel</Button>
            <Button loading={reverse.isPending} onClick={() => reverse.mutate()}>Post reversal</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
