'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { type StatementFormValue, SupplierStatementForm } from '@/components/purchases/supplier-statement-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';

/** Enter a supplier's statement to reconcile (AP-011). */
export default function NewSupplierStatementPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const vendors = useQuery({ queryKey: ['contacts', orgId, 'vendors'], queryFn: () => api<{ id: string; name: string }[]>(`/v1/orgs/${orgId}/contacts?role=vendor`) });
  const save = useMutation({
    mutationFn: (v: StatementFormValue) => api<{ id: string }>(`/v1/orgs/${orgId}/purchases/supplier-statements`, { method: 'POST', body: { ...v } }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['supplier-statements', orgId] });
      router.push(`/orgs/${orgId}/purchases/supplier-statements/${s.id}`);
    },
  });
  if (!org) return null;
  return (
    <>
      <PageHeader title="Reconcile a supplier statement" description={`Enter the statement of account a supplier sent you, in ${org.functionalCurrency}. Each line is matched to your bills, vendor credits and payments for the period, and the difference between their balance and yours is explained.`} />
      <ErrorAlert title="Could not save the statement" error={save.error} />
      <Card>
        <CardHeader title="Statement as received" description="Copy the balances and lines exactly as they appear on their statement, even where you think they are wrong: the reconciliation shows the differences." />
        <SupplierStatementForm vendors={vendors.data ?? []} submitLabel="Reconcile" pending={save.isPending} onSubmit={(v) => save.mutate(v)} />
      </Card>
    </>
  );
}
