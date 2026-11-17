'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { SalesForm } from '@/components/sales-orders/sales-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { ContractDetail } from '@/lib/sales-orders';

export default function EditContractPage() {
  const { orgId } = useOrg();
  const { contractId } = useParams<{ contractId: string }>();
  const c = useQuery({ queryKey: ['sales-contract', orgId, contractId], queryFn: () => api<ContractDetail>(`/v1/orgs/${orgId}/sales/contracts/${contractId}`) });
  if (c.error) return <ErrorAlert title="Could not load the contract" error={c.error} />;
  if (!c.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  return (
    <>
      <PageHeader title={`Edit ${c.data.reference}`} description={c.data.status === 'DRAFT' ? 'A draft changes freely.' : 'The customer, start date and schedule stay. New lines and prices apply to periods billed from now on; invoices already made do not change.'} />
      <SalesForm mode="contract" contract={c.data} />
    </>
  );
}
