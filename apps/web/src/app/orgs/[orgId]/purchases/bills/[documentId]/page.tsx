'use client';
import { DocumentDetail } from '@/components/ledger/document-detail';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <DocumentDetail l={PURCHASES} />;
}
