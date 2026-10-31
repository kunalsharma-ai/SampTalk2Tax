'use client';
import { NewDocument } from '@/components/ledger/new-document';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <NewDocument l={PURCHASES} />;
}
