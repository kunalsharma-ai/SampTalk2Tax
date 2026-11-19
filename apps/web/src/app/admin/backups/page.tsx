'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { bytes } from '@/components/usage-meter';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

type Kind = 'BACKUP' | 'VERIFY' | 'RESTORE_DRILL';
type Run = { id: string; kind: Kind; status: 'OK' | 'FAILED'; fileName: string; bytes: number | null; fileSha256: string | null; encrypted: boolean | null; consistent: boolean | null; collections: number | null; documents: number | null; backupTakenAt: string | null; durationMs: number; host: string; error: string | null; at: string };
type Report = {
  limits: { backupMaxAgeHours: number; restoreDrillMaxAgeDays: number };
  lastBackup: { at: string; fileName: string; bytes: number; encrypted: boolean | null; documents: number | null } | null;
  lastDrill: { at: string; fileName: string; durationMs: number; backupTakenAt: string | null } | null;
  backupOverdue: boolean;
  drillOverdue: boolean;
  problems: string[];
  runs: Run[];
};
const KIND: Record<Kind, string> = { BACKUP: 'Backup', VERIFY: 'Check', RESTORE_DRILL: 'Restore drill' };
const seconds = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

/** Backups and restore drills (SEC-021/022), as the backup command recorded them. */
export default function AdminBackupsPage() {
  const [kind, setKind] = useState<'' | Kind>('');
  const q = useQuery({ queryKey: ['admin-backups', kind], queryFn: () => api<Report>(`/v1/admin/backups${kind ? `?kind=${kind}` : ''}`) });
  const r = q.data;
  return (
    <>
      <PageHeader
        title="Backups"
        description="Encrypted backups of the database, checks of the backup files, and restore drills that prove a backup can be brought back. The backup command runs on your servers on a schedule and records each run here."
      />
      <ErrorAlert title="Could not load backups" error={q.error} />
      {r ? (
        <>
          {r.problems.length ? (
            <div className="mb-4"><Alert tone="warning" title="Needs attention"><ul className="list-disc pl-5">{r.problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert></div>
          ) : null}
          <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
            <Stat
              label="Newest backup"
              value={r.lastBackup ? dateTime(r.lastBackup.at) : 'None yet'}
              tone={r.backupOverdue ? 'negative' : 'positive'}
              sub={r.lastBackup ? `${bytes(r.lastBackup.bytes)} · ${r.lastBackup.encrypted ? 'encrypted' : 'not encrypted'}${r.limits.backupMaxAgeHours ? ` · expected every ${r.limits.backupMaxAgeHours} h` : ''}` : r.limits.backupMaxAgeHours ? `Expected every ${r.limits.backupMaxAgeHours} hours` : undefined}
            />
            <Stat
              label="Last restore drill"
              value={r.lastDrill ? dateTime(r.lastDrill.at) : 'None yet'}
              tone={r.drillOverdue ? 'negative' : 'positive'}
              sub={r.lastDrill ? `Restored in ${seconds(r.lastDrill.durationMs)}${r.lastDrill.backupTakenAt ? ` · backup of ${dateTime(r.lastDrill.backupTakenAt)}` : ''}` : r.limits.restoreDrillMaxAgeDays ? `Expected every ${r.limits.restoreDrillMaxAgeDays} days` : undefined}
            />
            <Stat label="Failed runs shown" value={r.runs.filter((x) => x.status === 'FAILED').length} tone={r.runs.some((x) => x.status === 'FAILED') ? 'warning' : 'neutral'} />
          </div>

          <Card className="mb-6" role="region" aria-label="Backup runs">
            <CardHeader
              title="Backup runs"
              description="The last 100 backups, checks and restore drills, newest first. The record cannot be changed."
              actions={
                <select aria-label="Kind" className="rounded-md border border-line bg-surface px-2 py-1 text-sm" value={kind} onChange={(e) => setKind(e.target.value as '' | Kind)}>
                  <option value="">All</option>
                  <option value="BACKUP">Backups</option>
                  <option value="VERIFY">Checks</option>
                  <option value="RESTORE_DRILL">Restore drills</option>
                </select>
              }
            />
            {!r.runs.length ? (
              <EmptyState title="Nothing recorded yet">Run the backup command on your server (see How backups run below).</EmptyState>
            ) : (
              <Table aria-label="Backup runs">
                <thead><Tr><Th>When</Th><Th>Run</Th><Th>Result</Th><Th>File</Th><Th>Size</Th><Th>Documents</Th><Th>Took</Th><Th>Server</Th></Tr></thead>
                <tbody>
                  {r.runs.map((x) => (
                    <Tr key={x.id}>
                      <Td className="whitespace-nowrap">{dateTime(x.at)}</Td>
                      <Td>{KIND[x.kind]}</Td>
                      <Td>
                        <Badge tone={x.status === 'OK' ? 'positive' : 'negative'}>{x.status === 'OK' ? 'Passed' : 'Failed'}</Badge>
                        {x.error ? <span className="mt-1 block max-w-xs text-xs text-negative">{x.error}</span> : null}
                      </Td>
                      <Td className="break-all font-mono text-xs">
                        {x.fileName}
                        {x.fileSha256 ? <span className="block text-fg-faint" title={x.fileSha256}>sha256 {x.fileSha256.slice(0, 16)}…</span> : null}
                        {x.encrypted === false ? <span className="block text-warning">not encrypted</span> : null}
                      </Td>
                      <Td className="whitespace-nowrap">{x.bytes === null ? '—' : bytes(x.bytes)}</Td>
                      <Td>{x.documents === null ? '—' : `${x.documents.toLocaleString('en-IN')} in ${x.collections} collections`}</Td>
                      <Td className="whitespace-nowrap">{seconds(x.durationMs)}</Td>
                      <Td className="text-xs">{x.host}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card role="region" aria-label="How backups run">
            <CardHeader title="How backups run" description="Commands for your scheduler, run with the API image or from apps/api. MONGODB_URL and BACKUP_ENCRYPTION_KEY come from the environment." />
            <div className="space-y-2 px-5 pb-5 pt-3 text-sm">
              <p>Daily backup, keeping the newest 14 files: <code className="font-mono text-xs">node dist/db/backup.js create --out /backups --keep 14</code></p>
              <p>Check a copy (after moving it off the server): <code className="font-mono text-xs">node dist/db/backup.js verify --in /backups/&lt;file&gt;</code></p>
              <p>Monthly restore drill: <code className="font-mono text-xs">node dist/db/backup.js drill --in /backups/&lt;file&gt;</code></p>
              <p>Recovery into an empty database: <code className="font-mono text-xs">node dist/db/backup.js restore --in /backups/&lt;file&gt; --to-url mongodb://…/talk2tax</code>. The steps are in docs/DISASTER_RECOVERY.md.</p>
            </div>
          </Card>
        </>
      ) : q.isLoading ? <p className="text-sm text-fg-muted">Loading…</p> : null}
    </>
  );
}
