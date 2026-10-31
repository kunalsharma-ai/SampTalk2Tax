'use client';
import { DocumentDetail } from '@/components/ledger/document-detail';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <DocumentDetail l={SALES} />;
}
