'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { AssetForm } from '@/components/fixed-assets/asset-form';
import { PageHeader } from '@/components/shell';
import { useOrg } from '@/lib/org';

export default function NewAssetPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  if (!org) return null;
  return (
    <>
      <PageHeader title="Add an asset" description="Record something the business owns and will use for more than a year. Depreciation starts in the month it is put to use." />
      <AssetForm
        orgId={orgId}
        mode={{ kind: 'new' }}
        onSaved={(a) => {
          void qc.invalidateQueries({ queryKey: ['fixed-assets', orgId] });
          router.push(`/orgs/${orgId}/fixed-assets/${a.id}`);
        }}
      />
    </>
  );
}
