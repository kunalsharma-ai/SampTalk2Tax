'use client';
import { AgeingReport } from '@/components/ledger/ageing-report';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <AgeingReport l={PURCHASES} />;
}
