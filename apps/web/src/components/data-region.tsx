'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useOrg } from '@/lib/org';

export interface RegionDirectory {
  region: string;
  name: string;
  regions: { region: string; name: string; appUrl: string | null }[];
}

export function useRegion() {
  return useQuery({ queryKey: ['region'], queryFn: () => api<RegionDirectory>('/v1/region'), staleTime: Infinity });
}

/** Where this organisation's data is kept (data residency), and the regions this service runs in. */
export function DataRegionCard() {
  const { t } = useI18n();
  const { org } = useOrg();
  const region = useRegion();
  if (!org) return null;
  return (
    <Card className="mb-6" aria-label={t('Where your data is kept')}>
      <CardHeader
        title={t('Where your data is kept')}
        description={t('Each organisation’s books, documents and audit trail are stored in one region, the one it was created in, and are served only from there. Moving to another region is done by the service operator on request.')}
      />
      <div className="px-5 pb-2 pt-4 text-sm">
        <p>
          <span className="text-fg-muted">{org.name}: </span>
          <span className="font-medium" data-testid="org-data-region">{org.dataRegion.name}</span>{' '}
          <span className="num text-fg-faint">({org.dataRegion.region})</span>
        </p>
      </div>
      {region.data && region.data.regions.length > 1 ? (
        <Table>
          <thead><tr><Th>{t('Region')}</Th><Th>{t('Code')}</Th><Th>{t('Address')}</Th></tr></thead>
          <tbody>
            {region.data.regions.map((r) => (
              <Tr key={r.region}>
                <Td>{r.name} {r.region === region.data.region ? <Badge tone="positive">{t('This server')}</Badge> : null}</Td>
                <Td className="num text-fg-muted">{r.region}</Td>
                <Td className="text-fg-muted">{r.appUrl ?? '—'}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : <div className="pb-3" />}
    </Card>
  );
}

/** Shown before an organisation is created: where its data will be stored. */
export function DataRegionNote() {
  const region = useRegion();
  if (!region.data) return null;
  return (
    <p className="text-sm text-fg-muted sm:col-span-2" data-testid="data-region-note">
      Its data will be stored in <span className="font-medium text-fg">{region.data.name}</span> ({region.data.region}), where this server runs, and served only from there.
    </p>
  );
}
