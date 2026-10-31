'use client';
import { ContactsPage } from '@/components/ledger/contacts-page';
import { PURCHASES } from '@/lib/ledgers';

export default function Page() {
  return <ContactsPage l={PURCHASES} />;
}
