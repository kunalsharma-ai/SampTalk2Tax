'use client';
import { AgeingReport } from '@/components/ledger/ageing-report';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <AgeingReport l={SALES} />;
}
