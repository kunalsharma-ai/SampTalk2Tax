'use client';
import { ClaimForm } from '@/components/expenses/claim-form';
import { PageHeader } from '@/components/shell';

export default function NewExpenseClaimPage() {
  return (
    <>
      <PageHeader title="New expense claim" description="Save it as a draft, attach the receipts, then submit it for approval." />
      <ClaimForm />
    </>
  );
}
