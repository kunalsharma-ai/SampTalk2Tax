'use client';
import { ContactsPage } from '@/components/ledger/contacts-page';
import { SALES } from '@/lib/ledgers';

export default function Page() {
  return <ContactsPage l={SALES} />;
}
