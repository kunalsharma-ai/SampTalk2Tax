'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RECEIPT_MATCH_CONFIDENCE_LABEL } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AttachmentsPanel } from '@/components/attachments';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { CONFIDENCE_TONE, RECEIPT_STATUS, type ExpenseReceipt } from '@/components/expenses/receipts';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

const ACTION = { UPLOADED: 'Uploaded', MATCHED: 'Matched', UNMATCHED: 'Match undone', DISCARDED: 'Discarded' } as Record<string, string>;

/** One receipt: its file, and the bank line it paid. */
export default function ReceiptPage() {
  const { org, orgId } = useOrg();
  const { receiptId } = useParams<{ receiptId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/expense-receipts/${receiptId}`;
  const key = ['expense-receipt', orgId, receiptId];
  const q = useQuery({ queryKey: key, queryFn: () => api<ExpenseReceipt>(base) });
  const [reason, setReason] = useState('');
  const done = (r: ExpenseReceipt) => {
    qc.setQueryData(key, r);
    setReason('');
    void qc.invalidateQueries({ queryKey: ['expense-receipts', orgId] });
    void qc.invalidateQueries({ queryKey: ['expense-receipts-missing', orgId] });
  };
  const match = useMutation({ mutationFn: (lineId: string) => api<ExpenseReceipt>(`${base}/match`, { method: 'POST', body: { statementLineId: lineId } }), onSuccess: done });
  const unmatch = useMutation({ mutationFn: () => api<ExpenseReceipt>(`${base}/unmatch`, { method: 'POST', body: { reason } }), onSuccess: done });
  const discard = useMutation({ mutationFn: () => api<ExpenseReceipt>(`${base}/discard`, { method: 'POST', body: { reason } }), onSuccess: done });
  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the receipt" error={q.error} />;
  const r = q.data;
  if (!r) return null;
  const finance = can(org.role, 'banking.manage');
  const own = r.mine;
  const open = r.status === 'UNMATCHED';
  const st = RECEIPT_STATUS[r.status];
  return (
    <>
      <PageHeader
        title={`${r.reference}: ${r.merchant}`}
        description={<><Money value={r.amount} currency={r.currency} /> on {date(r.date)}, uploaded by {r.uploadedBy.name}.{r.note ? ` ${r.note}` : ''} <Link className="text-accent" href={`/orgs/${orgId}/expenses/receipts`}>All receipts</Link></>}
        actions={<Badge tone={st.tone}>{st.label}</Badge>}
      />
      <AttachmentsPanel
        entityType="EXPENSE_RECEIPT"
        entityId={r.id}
        canManage={open && (finance || own)}
        description={open ? 'Attach the photo or PDF of the receipt (PNG, JPEG, WebP or PDF, up to 5 MB). On a phone, Take a photo opens the camera.' : 'The receipt file. It cannot change once the receipt is matched or discarded.'}
        onChanged={() => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ['expense-receipts', orgId] })])}
      />
      <Card className="mt-6" role="region" aria-label="Bank line paid">
        <CardHeader title="Bank line paid" description="The money-out line of the bank statement this receipt is for." />
        <div className="space-y-3 p-4 text-sm">
          {r.matchedLine ? (
            <>
              <p><span className="font-medium">{r.matchedLine.description}</span> on {r.matchedLine.account.name}, {date(r.matchedLine.date)}, <Money value={r.matchedLine.amount} currency={r.matchedLine.currency} /></p>
              <p className="text-fg-muted">Matched by {r.matchedBy?.name} on {r.matchedAt ? dateTime(r.matchedAt) : ''}.</p>
            </>
          ) : r.suggestion ? (
            <>
              <p><Badge tone={CONFIDENCE_TONE[r.suggestion.confidence]}>{RECEIPT_MATCH_CONFIDENCE_LABEL[r.suggestion.confidence]}</Badge> <span className="font-medium">{r.suggestion.line.description}</span> on {r.suggestion.line.account.name}, {date(r.suggestion.line.date)}, <Money value={r.suggestion.line.amount} currency={r.suggestion.line.currency} /></p>
              <ul className="list-disc pl-5 text-fg-muted">{r.suggestion.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
              {finance && open ? <Button size="sm" disabled={!r.files.length} loading={match.isPending} onClick={() => match.mutate(r.suggestion!.line.id)}>{r.files.length ? 'Match to this line' : 'Attach the file first'}</Button> : null}
            </>
          ) : (
            <p className="text-fg-muted">{open ? (finance ? 'No bank line fits yet. Import the latest bank statement, or match it from the bank line.' : 'Finance matches it once the bank statement is in.') : 'Not matched.'}</p>
          )}
          <ErrorAlert title="The receipt was not matched" error={match.error} />
          {(r.status === 'MATCHED' && finance) || (open && (finance || own)) ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
              <div className="w-80"><Field label="Reason">{(p) => <Input {...p} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field></div>
              {r.status === 'MATCHED' ? <Button size="sm" variant="secondary" disabled={reason.trim().length < 3} loading={unmatch.isPending} onClick={() => unmatch.mutate()}>Undo match</Button> : <Button size="sm" variant="secondary" disabled={reason.trim().length < 3} loading={discard.isPending} onClick={() => discard.mutate()}>Discard receipt</Button>}
            </div>
          ) : null}
          <ErrorAlert title="That did not work" error={unmatch.error ?? discard.error} />
        </div>
      </Card>
      <Card className="mt-6" role="region" aria-label="Receipt history">
        <CardHeader title="Receipt history" description="Every step, kept as a record." />
        <Table aria-label="Receipt history">
          <thead><Tr><Th>When</Th><Th>Who</Th><Th>What</Th></Tr></thead>
          <tbody>{r.history.map((h, i) => <Tr key={i}><Td>{dateTime(h.at)}</Td><Td>{h.by}</Td><Td>{ACTION[h.action] ?? h.action}{h.note ? <span className="block text-xs text-fg-muted">{h.note}</span> : null}</Td></Tr>)}</tbody>
        </Table>
      </Card>
    </>
  );
}
