'use client';
import { ContactDetail } from '@/components/ledger/contact-detail';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <ContactDetail l={SALES} />;
}
