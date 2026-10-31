'use client';
import { DocumentsList } from '@/components/ledger/documents-list';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <DocumentsList l={PURCHASES} />;
}
