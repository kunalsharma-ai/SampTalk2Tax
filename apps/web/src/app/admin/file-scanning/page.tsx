'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

type Result = 'CLEAN' | 'NOT_SCANNED' | 'INFECTED' | 'ACTIVE_CONTENT' | 'SCAN_FAILED';
type Report = {
  scanner: { configured: boolean; ok: boolean; version: string | null; error: string | null };
  last30Days: Record<Result, number>;
  refused: { id: string; at: string; organisation: string | null; source: string; fileName: string; sizeBytes: number; sha256: string; result: Result; detail: string | null }[];
};
const REASONS: Record<string, string> = { INFECTED: 'Malware', ACTIVE_CONTENT: 'Scripts or embedded files', SCAN_FAILED: 'Scanner did not answer' };

/** Upload checks and malware scanning (SEC-018/019). */
export default function AdminFileScanningPage() {
  const q = useQuery({ queryKey: ['admin-file-scanning'], queryFn: () => api<Report>('/v1/admin/file-scanning') });
  const r = q.data;
  return (
    <>
      <PageHeader
        title="File scanning"
        description="Every file uploaded to Talk2Tax (attachments, tax notices and files vendors send) is checked before it is kept. Its type is read from its bytes, PDFs that can run code or carry other files are refused, and with a ClamAV scanner set in CLAMAV_URL every file is scanned for malware. Refused files are not kept."
      />
      <ErrorAlert title="Could not load file scanning" error={q.error} />
      {r ? (
        <>
          {!r.scanner.configured ? (
            <div className="mb-4">
              <Alert tone="warning" title="No virus scanner is set up">
                Files get the structural checks only. Run ClamAV&apos;s daemon (clamd) and set CLAMAV_URL=tcp://host:3310 on the API to scan every upload for malware.
              </Alert>
            </div>
          ) : !r.scanner.ok ? (
            <div className="mb-4">
              <Alert tone="negative" title="The virus scanner is not answering">
                Uploads are refused until it answers again: {r.scanner.error}
              </Alert>
            </div>
          ) : null}
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Virus scanner" value={r.scanner.configured ? (r.scanner.ok ? 'Working' : 'Not answering') : 'Not set up'} tone={r.scanner.configured ? (r.scanner.ok ? 'positive' : 'negative') : 'warning'} sub={r.scanner.version ?? undefined} />
            <Stat label="Files accepted, 30 days" value={String(r.last30Days.CLEAN + r.last30Days.NOT_SCANNED)} sub={`${r.last30Days.CLEAN} scanned, ${r.last30Days.NOT_SCANNED} not scanned`} />
            <Stat label="Malware found, 30 days" value={String(r.last30Days.INFECTED)} tone={r.last30Days.INFECTED ? 'negative' : 'positive'} />
            <Stat label="Other refusals, 30 days" value={String(r.last30Days.ACTIVE_CONTENT + r.last30Days.SCAN_FAILED)} sub={`${r.last30Days.ACTIVE_CONTENT} with scripts, ${r.last30Days.SCAN_FAILED} while the scanner was down`} />
          </div>
          <Card>
            <CardHeader title="Refused files" description="The latest 50 files refused, in every organisation. Only the name, size and SHA-256 are kept, never the file." />
            {!r.refused.length ? (
              <EmptyState title="No files refused">Refused uploads appear here.</EmptyState>
            ) : (
              <Table aria-label="Refused files">
                <thead><tr><Th>When</Th><Th>Organisation</Th><Th>Where</Th><Th>File</Th><Th>Reason</Th></tr></thead>
                <tbody>
                  {r.refused.map((f) => (
                    <Tr key={f.id}>
                      <Td className="whitespace-nowrap">{dateTime(f.at)}</Td>
                      <Td>{f.organisation ?? '—'}</Td>
                      <Td>{f.source}</Td>
                      <Td>
                        <span className="font-medium">{f.fileName}</span>
                        <span className="block font-mono text-xs text-fg-muted">{f.sha256.slice(0, 16)}…</span>
                      </Td>
                      <Td>
                        <Badge tone={f.result === 'INFECTED' ? 'negative' : 'warning'}>{REASONS[f.result] ?? f.result}</Badge>
                        {f.detail ? <span className="block text-xs text-fg-muted">{f.detail}</span> : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
