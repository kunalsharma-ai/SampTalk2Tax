'use client';
import { ContactDetail } from '@/components/ledger/contact-detail';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <ContactDetail l={PURCHASES} />;
}
