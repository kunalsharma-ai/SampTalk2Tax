'use client';
import { PaymentDetail } from '@/components/ledger/payments';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <PaymentDetail l={SALES} />;
}
