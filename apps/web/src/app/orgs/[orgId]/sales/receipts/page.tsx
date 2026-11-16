'use client';
import { PaymentsList } from '@/components/ledger/payments';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <PaymentsList l={SALES} />;
}
