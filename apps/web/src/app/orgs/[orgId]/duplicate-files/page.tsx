'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Stat } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Risk = 'HIGH' | 'MEDIUM' | 'LOW';
interface DuplicateGroup {
  sha256: string;
  risk: Risk;
  reason: string;
  latest: string;
  files: { attachmentId: string; fileName: string; uploadedAt: string; uploadedBy: string | null; entityType: string; entityId: string; label: string; path: string | null }[];
}
interface DuplicateList {
  summary: { groups: number; high: number; medium: number };
  items: DuplicateGroup[];
}

const RISK: Record<Risk, { label: string; tone: 'negative' | 'warning' | 'neutral' }> = { HIGH: { label: 'Check first', tone: 'negative' }, MEDIUM: { label: 'Check', tone: 'warning' }, LOW: { label: 'Usually fine', tone: 'neutral' } };

/** Duplicate files across records (DOC-018): the same file on more than one record. */
export default function DuplicateFilesPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['duplicate-files', orgId], queryFn: () => api<DuplicateList>(`/v1/orgs/${orgId}/attachments/duplicates`) });
  if (!org) return null;
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Duplicate files"
        description="The same file attached to more than one record. One receipt on two expense claims, or one vendor invoice on two bills, may mean the same spending is claimed or paid twice. Files are compared byte for byte, by their fingerprint."
      />
      <ErrorAlert title="Could not check files" error={q.error as Error | null} />
      {r ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Stat label="Check first" value={String(r.summary.high)} tone={r.summary.high ? 'negative' : 'neutral'} />
          <Stat label="Check" value={String(r.summary.medium)} />
          <Stat label="Files on more than one record" value={String(r.summary.groups)} />
        </div>
      ) : null}
      <Card>
        <CardHeader title="Files on more than one record" description="Most serious first. Remove a file from the wrong record (with the reason) and it drops off this list." />
        {r && !r.items.length ? <EmptyState title="No duplicate files">No file is attached to more than one record you can see.</EmptyState> : null}
        {r?.items.length ? (
          <ul className="divide-y divide-border" aria-label="Duplicate files">
            {r.items.map((g) => (
              <li key={g.sha256} className="space-y-2 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={RISK[g.risk].tone}>{RISK[g.risk].label}</Badge>
                  <span className="text-sm">{g.reason}</span>
                </div>
                <ul className="space-y-1 text-sm">
                  {g.files.map((f) => (
                    <li key={f.attachmentId} className="flex flex-wrap gap-x-2">
                      {f.path ? <Link className="text-accent underline" href={`/orgs/${orgId}/${f.path}`}>{f.label}</Link> : <span>{f.label}</span>}
                      <span className="text-fg-muted">{f.fileName} · added {date(f.uploadedAt.slice(0, 10))}{f.uploadedBy ? ` by ${f.uploadedBy}` : ''}</span>
                    </li>
                  ))}
                </ul>
                <p className="num text-xs text-fg-faint">SHA-256 {g.sha256.slice(0, 16)}…</p>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>
  );
}
