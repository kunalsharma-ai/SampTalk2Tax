'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Dialog, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DisputeForm, toBody } from '@/components/disputes/dispute-form';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { DISPUTE_OUTCOME_LABEL, DISPUTE_REASON_LABEL, type DisputeDetail, type DisputeList } from '@/lib/disputes';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { FinancialDocument } from '@/lib/types';

const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';

function Disputes() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<'open' | 'resolved' | 'all'>('open');
  const base = `/v1/orgs/${orgId}/sales/disputes`;
  const q = useQuery({ queryKey: ['disputes', orgId, view], queryFn: () => api<DisputeList>(`${base}?status=${view}`) });
  // Raise dispute… on an invoice opens this page with ?raise=<invoice id>.
  const raiseFor = params.get('raise');
  const [closed, setClosed] = useState(false);
  const invoice = useQuery({ enabled: !!raiseFor, queryKey: ['document', orgId, raiseFor], queryFn: () => api<FinancialDocument>(`/v1/orgs/${orgId}/sales/documents/${raiseFor}`) });
  const raise = useMutation({
    mutationFn: (body: ReturnType<typeof toBody>) => api<DisputeDetail>(base, { method: 'POST', body: { documentId: raiseFor, ...body } }),
    onSuccess: async (d) => {
      for (const k of ['disputes', 'document']) await qc.invalidateQueries({ queryKey: [k, orgId] });
      router.push(`/orgs/${orgId}/sales/disputes/${d.id}`);
    },
  });

  if (!org) return null;
  const s = q.data;
  const c = org.functionalCurrency;
  const inv = invoice.data;
  return (
    <>
      <PageHeader
        title="Disputes"
        description="Invoices a customer has queried: what they dispute, how much, who is working on it and by when. While a dispute is open the invoice is left out of payment reminders and overdue-invoice workflows. Raise a dispute from the invoice."
      />
      <ErrorAlert title="Could not load disputes" error={q.error} />
      {s ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Open disputes" value={String(s.summary.open)} tone={s.summary.open ? 'warning' : 'positive'} sub={<Money value={s.summary.openAmount} currency={c} />} />
            <Stat label="Past target date" value={String(s.summary.pastTarget)} tone={s.summary.pastTarget ? 'negative' : 'positive'} sub="Open disputes not settled by the date set" />
            <Stat label="Oldest open" value={s.summary.oldestOpenDays == null ? '—' : `${s.summary.oldestOpenDays} d`} tone="violet" sub="Days since it was raised" />
            <Stat label="Average to settle" value={s.summary.averageDaysToResolve == null ? '—' : `${s.summary.averageDaysToResolve} d`} tone="accent" sub={`${s.summary.resolved} resolved · ${s.summary.outcomes.CREDIT_NOTE} by credit note`} />
          </div>
          <Card>
            <CardHeader title="Disputes" description="Newest first. Open one to add notes, change the owner or amount, or record how it was settled." />
            <div className="flex flex-wrap items-end gap-4 border-b border-line px-5 py-3">
              <label className={label}>
                Show
                <Select className="w-40" value={view} onChange={(e) => setView(e.target.value as typeof view)}>
                  <option value="open">Open</option>
                  <option value="resolved">Resolved</option>
                  <option value="all">All</option>
                </Select>
              </label>
            </div>
            {s.disputes.length === 0 ? (
              <EmptyState title={view === 'open' ? 'No open disputes' : 'No disputes'}>Open an invoice and choose Raise dispute… when a customer queries it.</EmptyState>
            ) : (
              <Table aria-label="Disputes">
                <thead>
                  <tr><Th>Dispute</Th><Th>Invoice</Th><Th>Customer</Th><Th>Reason</Th><Th numeric>In dispute</Th><Th>Owner</Th><Th>Settle by</Th><Th numeric>Days</Th><Th>Status</Th></tr>
                </thead>
                <tbody>
                  {s.disputes.map((d) => (
                    <Tr key={d.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/disputes/${d.id}`}>{d.ref}</Link></Td>
                      <Td><Link className="hover:underline" href={`/orgs/${orgId}/sales/invoices/${d.invoice.id}`}>{d.invoice.number}</Link></Td>
                      <Td>{d.customer.name}</Td>
                      <Td>{DISPUTE_REASON_LABEL[d.reason]}<span className="block max-w-xs truncate text-xs text-fg-muted">{d.description}</span></Td>
                      <Td numeric><Money value={d.amount} currency={d.invoice.currency} /></Td>
                      <Td>{d.owner?.name ?? <span className="text-fg-muted">No one</span>}</Td>
                      <Td>{d.targetDate ? <>{date(d.targetDate)}{d.pastTarget ? <Badge tone="negative" className="ml-2">Past</Badge> : null}</> : '—'}</Td>
                      <Td numeric>{d.days}</Td>
                      <Td>{d.status === 'OPEN' ? <Badge tone="warning">Open</Badge> : <Badge tone="positive">{DISPUTE_OUTCOME_LABEL[d.outcome!]}</Badge>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}

      <Dialog
        open={!!raiseFor && !closed && !!inv && !!s}
        onOpenChange={(o) => !o && setClosed(true)}
        title={inv ? `Raise a dispute on ${inv.number}` : ''}
        description={inv ? `${inv.contact.name}, ${inv.amountDue} ${inv.currency} still due. The invoice is left out of payment reminders until the dispute is resolved.` : ''}
      >
        {inv && s ? (
          <DisputeForm
            initial={{ amount: '', reason: 'PRICE', description: '', ownerId: '', targetDate: '' }}
            members={s.members}
            today={s.today}
            maxAmount={inv.amountDue}
            currency={inv.currency}
            submitLabel="Raise dispute"
            pending={raise.isPending}
            error={raise.error}
            onSubmit={(f) => raise.mutate(toBody(f))}
          />
        ) : null}
      </Dialog>
    </>
  );
}

export default function DisputesPage() {
  return (
    <Suspense fallback={<p className="text-sm text-fg-muted">Loading…</p>}>
      <Disputes />
    </Suspense>
  );
}
