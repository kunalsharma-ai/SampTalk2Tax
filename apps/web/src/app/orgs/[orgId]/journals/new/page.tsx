'use client';
import { JournalForm } from '@/components/journal-form';
import { PageHeader } from '@/components/shell';

export default function NewJournalPage() {
  return (
    <>
      <PageHeader title="New journal" description="The balance check below uses the same rules as the server. Posting is permanent; drafts can be edited." />
      <JournalForm />
    </>
  );
}
