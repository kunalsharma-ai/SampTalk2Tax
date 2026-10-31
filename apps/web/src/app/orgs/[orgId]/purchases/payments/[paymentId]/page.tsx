'use client';
import { PaymentDetail } from '@/components/ledger/payments';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <PaymentDetail l={PURCHASES} />;
}
