'use client';
import { DocumentsList } from '@/components/ledger/documents-list';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <DocumentsList l={SALES} />;
}
