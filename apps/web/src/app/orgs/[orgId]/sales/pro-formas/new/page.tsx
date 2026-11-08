'use client';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { SalesForm } from '@/components/sales-orders/sales-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { QuoteDetail } from '@/lib/sales-orders';

function NewProForma() {
  const { orgId } = useOrg();
  const p = useSearchParams();
  const fromQuote = p.get('fromQuote');
  const quote = useQuery({ enabled: !!fromQuote, queryKey: ['sales-quote', orgId, fromQuote], queryFn: () => api<QuoteDetail>(`/v1/orgs/${orgId}/sales/quotes/${fromQuote}`) });
  if (fromQuote && quote.error) return <ErrorAlert title="Could not load the quotation" error={quote.error} />;
  if (fromQuote && !quote.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  return (
    <>
      <PageHeader
        title="New pro forma invoice"
        description={quote.data ? `Filled from quotation ${quote.data.reference}; change anything before saving. It is saved as a draft and numbered PF-.` : 'Saved as a draft you can change. Issue it when it goes to the customer; it is numbered PF- and posts nothing.'}
      />
      <SalesForm mode="proforma" fromQuote={quote.data} contactId={p.get('contactId') ?? undefined} />
    </>
  );
}

export default function NewProFormaPage() {
  return (
    <Suspense fallback={<p className="text-sm text-fg-muted">Loading…</p>}>
      <NewProForma />
    </Suspense>
  );
}
