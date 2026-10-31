'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/shell';
import type { LedgerConfig } from '@/lib/ledgers';
import { DocumentForm } from './document-form';

function Inner({ l }: { l: LedgerConfig }) {
  const params = useSearchParams();
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
