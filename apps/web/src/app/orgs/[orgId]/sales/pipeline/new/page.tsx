'use client';
import { Card } from '@talk2tax/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { DealForm } from '@/components/crm/deal-form';
import { PageHeader } from '@/components/shell';
import { useMe, useOrg } from '@/lib/org';

export default function NewDealPage() {
  const { org, orgId } = useOrg();
  const me = useMe();
  const router = useRouter();
  const contactId = useSearchParams().get('contactId') ?? undefined;
  if (!org || !me.data) return null;
  return (
    <>
      <PageHeader title="Add a deal" description="A sale being worked on for a customer. It starts at an open stage and takes that stage's win probability unless you give another." />
      <Card className="max-w-2xl p-5">
        <DealForm orgId={orgId} currency={org.functionalCurrency} meId={me.data.user.id} contactId={contactId} onSaved={(d) => router.push(`/orgs/${orgId}/sales/pipeline/${d.id}`)} onCancel={() => router.back()} />
      </Card>
    </>
  );
}
