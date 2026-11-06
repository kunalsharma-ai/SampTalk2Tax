'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert } from '@talk2tax/ui';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { LedgerConfig } from '@/lib/ledgers';
import { useOrg } from '@/lib/org';
import type { FinancialDocument } from '@/lib/types';
import { DocumentForm } from './document-form';

/** A debit note: an invoice raising the value of an earlier posted invoice to the same customer. */
function NewDebitNote({ l, invoiceId }: { l: LedgerConfig; invoiceId: string }) {
  const { orgId } = useOrg();
  const q = useQuery({ queryKey: ['document', orgId, invoiceId], queryFn: () => api<FinancialDocument>(`/v1/orgs/${orgId}/${l.api}/documents/${invoiceId}`) });
  if (q.error) return <Alert title="Invoice not found">{(q.error as Error).message}</Alert>;
  const o = q.data;
  if (!o) return <p className="text-sm text-fg-muted">Loading…</p>;
  return (
    <>
      <PageHeader
        title={`New debit note on ${o.number}`}
        description={`Raises the value of ${o.number} to ${o.contact.name}, for example after a price revision or goods short-billed. Enter only the increase. It is charged in ${o.currency}${o.gst ? ` at the invoice's place of supply (${o.gst.placeOfSupply})` : ''}, owed and paid like an invoice, and numbered DN-.`}
      />
      <DocumentForm l={l} kind="INVOICE" contactId={o.contact.id} debitNoteFor={{ id: o.id, number: o.number ?? '', currency: o.currency, placeOfSupply: o.gst?.placeOfSupply ?? null }} />
    </>
  );
}

function Inner({ l }: { l: LedgerConfig }) {
  const params = useSearchParams();
  const debitNoteFor = l.ledger === 'SALES' ? params.get('debitNoteFor') : null;
  if (debitNoteFor) return <NewDebitNote l={l} invoiceId={debitNoteFor} />;
  const kind = params.get('kind') === l.credit.kind ? l.credit.kind : l.charge.kind;
  const label = kind === l.charge.kind ? l.charge.label : l.credit.label;
  return (
    <>
      <PageHeader
        title={`New ${label.toLowerCase()}`}
        description={kind === l.credit.kind ? `A ${label.toLowerCase()} reduces what the ${l.contact.toLowerCase()} owes. Apply it to a ${l.charge.label.toLowerCase()} after posting.` : 'Save as a draft to review later, or post it now.'}
      />
      <DocumentForm key={kind} l={l} kind={kind} contactId={params.get('contactId') ?? undefined} />
    </>
  );
}

export function NewDocument({ l }: { l: LedgerConfig }) {
  return (
    <Suspense>
      <Inner l={l} />
    </Suspense>
  );
}
