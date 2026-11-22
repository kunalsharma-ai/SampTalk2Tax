'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExceptionAction, ExceptionCause } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Stat } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Finding {
  lineNo: number | null;
  cause: ExceptionCause;
  causeLabel: string;
  action: ExceptionAction;
  actionLabel: string;
  explanation: string;
  amount: string;
  evidence: { id: string; number: string }[];
}
interface Held {
  id: string;
  number: string | null;
  reference: string | null;
  vendor: { id: string; name: string };
  issueDate: string;
  currency: string;
  total: string;
  order: { id: string; reference: string; status: string };
  findings: Finding[];
  atStake: string;
  nextAction: ExceptionAction;
  nextActionLabel: string;
  acceptable: boolean;
  daysHeld: number;
}
interface Exceptions {
  asOf: string;
  currency: string;
  summary: { bills: number; atStake: string; acceptable: number; withVendor: number; awaitingGoods: number; oldestDays: number };
  items: Held[];
  can: { acceptDifferences: boolean; manage: boolean };
}

const TONE: Record<ExceptionAction, 'negative' | 'warning' | 'accent' | 'neutral' | 'positive'> = {
  VOID_DUPLICATE: 'negative',
  ASK_CREDIT_NOTE: 'negative',
  ASK_CORRECTION: 'warning',
  LINK_LINE: 'accent',
  RECORD_RECEIPT: 'accent',
  CHECK_ORDER: 'warning',
  CONFIRM_PRICE: 'positive',
  CONFIRM_CHARGE: 'positive',
};

/** Automated exception investigation (AP-035): draft bills held by differences from their order. */
export default function BillExceptionsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const key = ['bill-exceptions', orgId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Exceptions>(`/v1/orgs/${orgId}/purchases/bill-exceptions`) });
  const accept = useMutation({
    mutationFn: (id: string) => api(`/v1/orgs/${orgId}/purchases/bills/${id}/match/accept`, { method: 'POST', body: { reason: reasons[id] ?? '' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  if (!org) return null;
  const r = q.data;
  const c = org.functionalCurrency;
  const name = (b: Held) => b.number ?? `Draft bill${b.reference ? ` ${b.reference}` : ''}`;
  return (
    <>
      <PageHeader
        title="Bill exceptions"
        description="Draft bills that cannot post because they do not match their purchase order, with the likely cause of each difference worked out from the order, the goods received and the vendor's other bills, what to do next and how much is at stake. Nothing changes until you correct the bill, record the goods or accept the differences."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders`}>Purchase orders</Link>}
      />
      <ErrorAlert title="Could not investigate bills" error={q.error as Error | null} />
      <ErrorAlert title="Could not accept the differences" error={accept.error as Error | null} />
      {r ? (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Bills held" value={String(r.summary.bills)} sub={r.summary.bills ? `Oldest ${r.summary.oldestDays} ${r.summary.oldestDays === 1 ? 'day' : 'days'} old` : 'Every draft bill matches its order'} />
          <Stat label="Amount at stake" value={<Money value={r.summary.atStake} currency={c} />} tone={r.summary.bills ? 'warning' : 'positive'} sub="What the differences come to" />
          <Stat label="Back to the vendor" value={String(r.summary.withVendor)} tone={r.summary.withVendor ? 'negative' : 'positive'} sub="Duplicates, over-billing and wrong invoices" />
          <Stat label="Ready to accept" value={String(r.summary.acceptable)} sub={`${r.summary.awaitingGoods} waiting for goods`} />
        </div>
      ) : null}
      <Card>
        <CardHeader title="Bills held by order differences" description="Most pressing next step first, then the largest amount at stake. Each difference says what it was compared with." />
        {r && !r.items.length ? <EmptyState title="No bills held">Every draft bill matched to a purchase order matches it, or its differences are accepted.</EmptyState> : null}
        <ul aria-label="Bills held by order differences" className="divide-y divide-border">
          {r?.items.map((b) => (
            <li key={b.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${b.id}`}>{name(b)}</Link>
                  <span className="text-fg-muted"> · {b.vendor.name} · </span>
                  <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders/${b.order.id}`}>{b.order.reference}</Link>
                  <div className="text-xs text-fg-muted">
                    Dated {date(b.issueDate)}, {b.daysHeld} {b.daysHeld === 1 ? 'day' : 'days'} ago · total <Money value={b.total} currency={b.currency} />
                  </div>
                </div>
                <div className="text-right">
                  <Badge tone={TONE[b.nextAction]}>Next: {b.nextActionLabel}</Badge>
                  <div className="mt-1 text-sm">At stake <Money value={b.atStake} currency={b.currency} /></div>
                </div>
              </div>
              <ul className="mt-3 space-y-2">
                {b.findings.map((f, i) => (
                  <li key={i} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{f.lineNo ? `Line ${f.lineNo}: ` : ''}{f.causeLabel}</span>
                      {!/^0(\.0+)?$/.test(f.amount) ? <Money value={f.amount} currency={b.currency} /> : null}
                    </div>
                    <p className="mt-1 text-fg-muted">{f.explanation.replace(/^Line \d+: /, '')}</p>
                    <p className="mt-1 text-xs">
                      {f.actionLabel}
                      {f.evidence.map((e) => (
                        <span key={e.id}> · see <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${e.id}`}>{e.number}</Link></span>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
              {r.can.acceptDifferences && b.acceptable ? (
                <form
                  className="mt-3 flex max-w-2xl flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    accept.mutate(b.id);
                  }}
                >
                  <Input aria-label={`Why accept ${name(b)}`} placeholder="Why the differences are fine" className="min-w-64 flex-1" value={reasons[b.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [b.id]: e.target.value })} />
                  <Button type="submit" size="sm" disabled={(reasons[b.id] ?? '').trim().length < 3} loading={accept.isPending && accept.variables === b.id}>Accept differences</Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
