'use client';
import { PaymentForm } from '@/components/ledger/payment-form';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <PaymentForm l={SALES} />;
}
