'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { AssetForm } from '@/components/fixed-assets/asset-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { AssetDetail } from '@/lib/fixed-assets';
import { useOrg } from '@/lib/org';

export default function EditAssetPage() {
  const { org, orgId } = useOrg();
  const { assetId } = useParams<{ assetId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fixed-asset', orgId, assetId], queryFn: () => api<AssetDetail>(`/v1/orgs/${orgId}/fixed-assets/${assetId}`) });
  if (!org) return null;
  return (
    <>
      <PageHeader title={q.data ? `Change ${q.data.reference} ${q.data.name}` : 'Change asset'} />
      <ErrorAlert title="Could not load the asset" error={q.error} />
      {q.data ? (
        <AssetForm
          orgId={orgId}
          mode={{ kind: 'edit', asset: q.data }}
          onSaved={(a) => {
            qc.setQueryData(['fixed-asset', orgId, assetId], a);
            void qc.invalidateQueries({ queryKey: ['fixed-assets', orgId] });
            router.push(`/orgs/${orgId}/fixed-assets/${a.id}`);
          }}
        />
      ) : null}
    </>
  );
}
