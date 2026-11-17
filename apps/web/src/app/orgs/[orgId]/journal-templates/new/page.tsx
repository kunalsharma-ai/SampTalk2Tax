'use client';
import { TemplateForm } from '@/components/journal-templates/template-form';
import { PageHeader } from '@/components/shell';

export default function NewJournalTemplatePage() {
  return (
    <>
      <PageHeader title="New journal template" description="Save the lines of a journal you enter again and again. Use it by hand, or give it a schedule to make the journal every month, quarter or year." />
      <TemplateForm />
    </>
  );
}
