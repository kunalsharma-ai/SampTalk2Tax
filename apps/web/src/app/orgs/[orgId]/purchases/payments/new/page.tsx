'use client';
import { PaymentForm } from '@/components/ledger/payment-form';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <PaymentForm l={PURCHASES} />;
}
