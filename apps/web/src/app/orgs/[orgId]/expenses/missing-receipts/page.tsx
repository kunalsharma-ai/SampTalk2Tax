'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MISSING_RECEIPT_REASON_LABEL, type MissingReceiptReason } from '@talk2tax/accounting-engine';
import { Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ClaimStatus } from '@/components/expenses/claims-list';
import { AskForReceipt } from '@/components/expenses/receipt-requests';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { ExpenseClaimStatus } from '@/lib/types';

interface Item {
  id: string;
  number: string;
  title: string;
  claimant: string | null;
  status: ExpenseClaimStatus;
  submittedOn: string;
  daysWaiting: number;
  lineNos: number[];
  amount: string;
  reasons: MissingReceiptReason[];
  reason: MissingReceiptReason;
  asked: { at: string; by: string | null; times: number; emailed: boolean | null } | null;
}
interface Report {
  currency: string;
  days: number;
  from: string;
  to: string;
  receiptAbove: string | null;
  checked: number;
  missing: number;
  required: number;
  amount: string;
  requiredAmount: string;
  canAsk: boolean;
  items: Item[];
  byClaimant: { claimantId: string; claimant: string | null; claims: number; amount: string; required: number }[];
}
const TONE: Record<MissingReceiptReason, 'negative' | 'warning' | 'neutral'> = { POLICY: 'negative', CATEGORY: 'warning', NONE: 'neutral' };

/** Expenses → Missing receipts (EXP-021): claims that went in without a receipt, and asking for them. */
export default function MissingReceiptsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [days, setDays] = useState(90);
  const q = useQuery({ queryKey: ['missing-claim-receipts', orgId, days], queryFn: () => api<Report>(`/v1/orgs/${orgId}/expense-claims-missing-receipts?days=${days}`) });
  if (!org) return null;
  const r = q.data;
  const c = r?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Missing receipts"
        description="Expense claims submitted without any receipt attached, with why each one matters: a line over the expense policy's receipt amount, a category that always needs one, or simply nothing backing the spending. Ask the claimant for it; they can attach it even after approval."
        actions={
          <div className="w-44">
            <Select aria-label="Submitted in the last" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {[30, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </Select>
          </div>
        }
      />
      <ErrorAlert title="Could not load missing receipts" error={q.error} />
      {r ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-4"><p className="text-sm text-fg-muted">Claims without a receipt</p><p className="mt-1 text-2xl font-semibold">{r.missing}</p><p className="text-xs text-fg-muted">of {r.checked} claims with receipt lines since {date(r.from)}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Required but missing</p><p className={`mt-1 text-2xl font-semibold ${r.required ? 'text-negative' : ''}`}>{r.required}</p><p className="text-xs text-fg-muted"><Money value={r.requiredAmount} currency={c} />{r.receiptAbove ? <>; policy asks for receipts over <Money value={r.receiptAbove} currency={c} /></> : '; no receipt amount in the policy'}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Spending without a receipt</p><p className="mt-1 text-2xl font-semibold"><Money value={r.amount} currency={c} /></p><p className="text-xs text-fg-muted">Receipt lines only; mileage and per diem need none</p></Card>
        </div>
      ) : null}
      {r ? (
        <Card className="mt-6" role="region" aria-label="Claims without receipts">
          <CardHeader title="Claims without receipts" description="Required ones first, then the longest waiting." />
          {r.items.length ? (
            <Table aria-label="Claims without receipts">
              <thead>
                <Tr><Th>Claim</Th><Th>Claimant</Th><Th>Status</Th><Th>Why</Th><Th numeric>Without receipt</Th><Th>Asked</Th>{r.canAsk ? <Th /> : null}</Tr>
              </thead>
              <tbody>
                {r.items.map((x) => (
                  <Tr key={x.id}>
                    <Td className="align-top"><Link className="font-medium underline-offset-2 hover:underline" href={`/orgs/${orgId}/expenses/${x.id}`}>{x.number}</Link><span className="block text-xs text-fg-muted">{x.title}</span></Td>
                    <Td className="align-top">{x.claimant ?? '—'}</Td>
                    <Td className="align-top"><ClaimStatus status={x.status} /><span className="block text-xs text-fg-muted">Submitted {date(x.submittedOn)}, {x.daysWaiting} {x.daysWaiting === 1 ? 'day' : 'days'} ago</span></Td>
                    <Td className="align-top"><div className="flex flex-wrap gap-1">{x.reasons.map((k) => <Badge key={k} tone={TONE[k]}>{MISSING_RECEIPT_REASON_LABEL[k]}</Badge>)}</div></Td>
                    <Td numeric className="align-top"><Money value={x.amount} currency={c} /><span className="block text-xs text-fg-muted">{x.lineNos.length === 1 ? 'line' : 'lines'} {x.lineNos.join(', ')}</span></Td>
                    <Td className="align-top text-xs text-fg-muted">{x.asked ? <>{date(x.asked.at.slice(0, 10))} by {x.asked.by ?? 'someone'}{x.asked.times > 1 ? ` (${x.asked.times} times)` : ''}</> : 'Not yet'}</Td>
                    {r.canAsk ? <Td className="align-top"><AskForReceipt orgId={orgId} claimId={x.id} number={x.number} onAsked={() => qc.invalidateQueries({ queryKey: ['missing-claim-receipts', orgId] })} /></Td> : null}
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="Every claim has a receipt">No claim submitted in this period went in without one.</EmptyState>
          )}
        </Card>
      ) : null}
      {r?.byClaimant.length ? (
        <Card className="mt-6" role="region" aria-label="Missing receipts by person">
          <CardHeader title="Missing receipts by person" description="Who most often claims without receipts, by amount." />
          <Table aria-label="Missing receipts by person">
            <thead><Tr><Th>Claimant</Th><Th numeric>Claims</Th><Th numeric>Required</Th><Th numeric>Without receipt</Th></Tr></thead>
            <tbody>
              {r.byClaimant.map((p) => (
                <Tr key={p.claimantId}><Td>{p.claimant ?? '—'}</Td><Td numeric>{p.claims}</Td><Td numeric>{p.required}</Td><Td numeric><Money value={p.amount} currency={c} /></Td></Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      <p className="mt-6 text-sm text-fg-muted">
        Bank payments with no receipt are under <Link className="underline" href={`/orgs/${orgId}/expenses/receipts`}>Receipt matching</Link>.
      </p>
    </>
  );
}
