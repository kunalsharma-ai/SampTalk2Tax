'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface EvidenceRef { attachmentId: string; fileName: string; sha256: string }
interface Event { id: string; actorId: string | null; action: string; entityType: string; entityId: string | null; data: { evidence?: EvidenceRef[] } | null; hash: string; createdAt: string }

export default function AuditPage() {
  const { org, orgId } = useOrg();
  const allowed = can(org?.role, 'audit.read');
  const q = useQuery({ enabled: allowed, queryKey: ['audit', orgId], queryFn: () => api<Event[]>(`/v1/orgs/${orgId}/audit-events?limit=200`) });
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => api<{ userId: string; name: string }[]>(`/v1/orgs/${orgId}/members`) });
  const verify = useMutation({ mutationFn: () => api<{ valid: boolean; checked: number; brokenAtId?: string }>(`/v1/orgs/${orgId}/audit-events/verify`) });
  if (!org) return null;
  if (!allowed) return <Alert title="Not available for your role">Viewers cannot see the audit trail.</Alert>;
  const who = (id: string | null) => members.data?.find((m) => m.userId === id)?.name ?? (id ? id.slice(0, 8) : 'system');

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every change is recorded here. Events cannot be edited or deleted, and each one is chained to the previous by a SHA-256 hash. An event about a bill, invoice, payment, journal, bank line or expense claim names the files attached to it at that moment, with their checksums."
        actions={<Button variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>Verify integrity</Button>}
      />
      {verify.data ? (
        <div className="mb-4">
          {verify.data.valid ? (
            <Alert tone="positive" title={`Chain intact: ${verify.data.checked} events verified`}>No event has been altered, removed or reordered.</Alert>
          ) : (
            <Alert title="Chain broken">The chain breaks at event {verify.data.brokenAtId}. Investigate immediately.</Alert>
          )}
        </div>
      ) : null}
      <Card>
        <CardHeader title="Latest 200 events" />
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>Action</Th>
              <Th>Record</Th>
              <Th>Evidence</Th>
              <Th>Hash</Th>
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((e) => (
              <Tr key={e.id}>
                <Td className="whitespace-nowrap text-fg-muted">{new Date(e.createdAt).toLocaleString()}</Td>
                <Td>{who(e.actorId)}</Td>
                <Td><Badge tone="accent">{e.action}</Badge></Td>
                <Td className="text-xs text-fg-muted">{e.entityType}{e.entityId ? ` · ${e.entityId.slice(0, 8)}` : ''}</Td>
                <Td className="text-xs">
                  {e.data?.evidence?.length ? (
                    <ul aria-label={`Evidence for event ${e.id}`} className="grid gap-0.5">
                      {e.data.evidence.map((f) => (
                        <li key={f.attachmentId}>
                          <a className="break-all text-accent hover:underline" href={`/api/t2t/v1/orgs/${orgId}/attachments/${f.attachmentId}/content?inline=1`} target="_blank" rel="noopener noreferrer">{f.fileName}</a>{' '}
                          <span className="num text-fg-faint" title={`SHA-256 ${f.sha256}`}>{f.sha256.slice(0, 8)}…</span>
                        </li>
                      ))}
                    </ul>
                  ) : <span className="text-fg-faint">None</span>}
                </Td>
                <Td className="num text-xs text-fg-faint" title={e.hash}>{e.hash.slice(0, 12)}…</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
