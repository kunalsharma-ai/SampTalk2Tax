'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MATCH_MODE_LABEL } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Dialog, Field, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { BillMatch } from '@/lib/purchase-orders';
import { MatchBadge } from './badges';

/**
 * How a bill matches its purchase order (and the goods received, three-way), line by line. A draft
 * bill with differences shows them and, for someone who can decide approvals, a way to accept
 * them with a reason so the bill can post.
 */
export function BillMatchPanel({ documentId, currency }: { documentId: string; currency: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const key = ['bill-match', orgId, documentId];
  const q = useQuery({ queryKey: key, queryFn: () => api<BillMatch>(`/v1/orgs/${orgId}/purchases/bills/${documentId}/match`) });
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const accept = useMutation({
    mutationFn: () => api<BillMatch>(`/v1/orgs/${orgId}/purchases/bills/${documentId}/match/accept`, { method: 'POST', body: { reason } }),
    onSuccess: async () => {
      setOpen(false);
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['purchase-orders', orgId] });
    },
  });
  const m = q.data?.match;
  if (q.error) return <ErrorAlert title="Could not check the match with the purchase order" error={q.error} />;
  if (!m) return null;
  const status = m.status === 'MATCHED' ? 'MATCHED' : m.accepted ? 'ACCEPTED' : 'EXCEPTION';
  const threeWay = m.mode === 'THREE_WAY';
  return (
    <Card className="mt-4">
      <CardHeader
        title="Purchase order match"
        description={`Checked against ${m.order.reference}: ${MATCH_MODE_LABEL[m.mode].toLowerCase()}, with a ${Number(m.order.priceTolerancePercent)}% price and ${Number(m.order.quantityTolerancePercent)}% quantity tolerance.`}
        actions={<MatchBadge status={status} />}
      />
      {status === 'EXCEPTION' && q.data?.documentStatus === 'DRAFT' ? (
        <div className="px-5 pb-3">
          <Alert tone="warning" title="This bill does not post until the differences are settled">
            Correct the bill to match the vendor&apos;s invoice, record the goods received on <Link className="underline" href={`/orgs/${orgId}/purchases/orders/${m.order.id}`}>{m.order.reference}</Link>, or have an approver accept the differences with a reason.
            {q.data.can.acceptDifferences ? <div className="mt-2"><Button size="sm" onClick={() => { accept.reset(); setReason(''); setOpen(true); }}>Accept differences…</Button></div> : null}
          </Alert>
        </div>
      ) : null}
      {m.accepted ? (
        <div className="px-5 pb-3">
          <Alert tone="neutral" title={`Differences accepted by ${m.accepted.acceptedBy ?? 'an approver'}, ${dateTime(m.accepted.acceptedAt)}`}>{m.accepted.reason}</Alert>
        </div>
      ) : null}
      <Table aria-label="Match by line">
        <thead>
          <tr><Th>Bill line</Th><Th>Order line</Th><Th numeric>Billed</Th><Th numeric>Ordered</Th>{threeWay ? <Th numeric>Received</Th> : null}<Th numeric>Other bills</Th><Th numeric>Price</Th><Th numeric>Order price</Th><Th>Result</Th></tr>
        </thead>
        <tbody>
          {m.lines.map((l) => (
            <Tr key={l.lineNo}>
              <Td>{l.lineNo}</Td>
              <Td>{l.orderLineNo ?? <span className="text-fg-muted">Not on the order</span>}</Td>
              <Td numeric className="num">{l.quantity}</Td>
              <Td numeric className="num">{l.ordered ?? '—'}</Td>
              {threeWay ? <Td numeric className="num">{l.received ?? '—'}</Td> : null}
              <Td numeric className="num">{l.billedElsewhere ?? '—'}</Td>
              <Td numeric><Money value={l.unitPrice} currency={currency} /></Td>
              <Td numeric>{l.orderPrice ? <Money value={l.orderPrice} currency={currency} /> : '—'}</Td>
              <Td className="text-sm">{l.exceptions.length ? l.exceptions.map((e) => <p key={e.code} className="text-negative">{e.message.replace(/^Line \d+: /, '')}</p>) : <span className="text-positive">Matches</span>}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {m.acceptances.length > (m.accepted ? 1 : 0) ? (
        <p className="border-t border-line px-5 py-3 text-xs text-fg-muted">
          Earlier acceptances no longer apply because the bill or the receipts changed since: {m.acceptances.filter((a) => a.acceptedAt !== m.accepted?.acceptedAt).map((a) => `${a.acceptedBy ?? 'approver'} on ${dateTime(a.acceptedAt)} (${a.reason})`).join('; ')}.
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen} title="Accept the differences" description="The bill can then post as it is. The acceptance covers exactly these differences; if the bill or the goods received change, it no longer applies. It is kept with the bill and in the audit trail.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); accept.mutate(); }}>
          <ul className="list-inside list-disc text-sm text-negative">{m.lines.flatMap((l) => l.exceptions.map((e) => <li key={`${l.lineNo}-${e.code}`}>{e.message}</li>))}</ul>
          <Field label="Why they are accepted">{(f) => <Textarea {...f} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: price rise agreed with the vendor on 4 November" />}</Field>
          <ErrorAlert title="The differences were not accepted" error={accept.error} />
          <div className="flex justify-end"><Button type="submit" loading={accept.isPending} disabled={reason.trim().length < 3}>Accept differences</Button></div>
        </form>
      </Dialog>
    </Card>
  );
}
