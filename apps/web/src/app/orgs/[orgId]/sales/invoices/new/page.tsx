'use client';
import { NewDocument } from '@/components/ledger/new-document';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <NewDocument l={SALES} />;
}
