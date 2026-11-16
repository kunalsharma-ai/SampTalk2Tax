'use client';
import { PaymentsList } from '@/components/ledger/payments';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <PaymentsList l={PURCHASES} />;
}
