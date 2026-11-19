'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useMeWithRole } from '@/lib/admin';

type Report = {
  currentKeyId: string;
  previousKeyIds: string[];
  stores: { key: string; name: string; current: number; previous: number; unreadable: number }[];
  totals: { current: number; previous: number; unreadable: number };
  resealed?: Record<string, number>;
};

/** Encryption key rotation (SEC-013). */
export default function AdminEncryptionKeysPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const q = useQuery({ queryKey: ['admin-encryption-keys'], queryFn: () => api<Report>('/v1/admin/encryption-keys') });
  const reseal = useMutation({ mutationFn: () => api<Report>('/v1/admin/encryption-keys/reseal', { method: 'POST' }), onSuccess: (r) => qc.setQueryData(['admin-encryption-keys'], r) });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const r = q.data;
  const resealed = reseal.data?.resealed ? Object.values(reseal.data.resealed).reduce((a, b) => a + b, 0) : null;
  return (
    <>
      <PageHeader
        title="Encryption keys"
        description="Secrets kept in the app (AI and email keys, payment gateway keys, webhook secrets and two-step sign-in) are encrypted with the server's key. To rotate it, set a new INTEGRATIONS_ENCRYPTION_KEY, list the old one in INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS and restart; then re-encrypt here, and remove the old key once nothing is left under it."
      />
      <ErrorAlert title="Could not load the encryption keys" error={q.error} />
      <ErrorAlert title="Re-encryption failed" error={reseal.error} />
      {resealed !== null ? <div className="mb-4"><Alert tone="positive" title={`${resealed} ${resealed === 1 ? 'secret' : 'secrets'} re-encrypted`}>Everything readable is now under the current key.</Alert></div> : null}
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Current key" value={r.currentKeyId} tone="accent" sub="Short id, not the key" />
            <Stat label="Under the current key" value={String(r.totals.current)} tone="positive" />
            <Stat label="Under a previous key" value={String(r.totals.previous)} tone={r.totals.previous ? 'warning' : 'positive'} sub={r.previousKeyIds.length ? `Previous keys: ${r.previousKeyIds.join(', ')}` : 'No previous key listed'} />
            <Stat label="Cannot be opened" value={String(r.totals.unreadable)} tone={r.totals.unreadable ? 'negative' : 'positive'} sub="Have to be entered again" />
          </div>
          <Card className="mb-4">
            <CardHeader title="Encrypted secrets" description="Counted by the key that encrypted each one. A secret no listed key can open is never changed; whoever set it up enters it again." />
            <Table aria-label="Encrypted secrets">
              <thead><tr><Th>What</Th><Th numeric>Current key</Th><Th numeric>Previous key</Th><Th numeric>Cannot be opened</Th></tr></thead>
              <tbody>
                {r.stores.map((s) => (
                  <Tr key={s.key}>
                    <Td>{s.name}</Td>
                    <Td numeric>{s.current}</Td>
                    <Td numeric>{s.previous ? <Badge tone="warning">{s.previous}</Badge> : 0}</Td>
                    <Td numeric>{s.unreadable ? <Badge tone="negative">{s.unreadable}</Badge> : 0}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          {manage ? (
            <Card className="p-4">
              <CardHeader title="Re-encrypt with the current key" description="Opens every secret under a previous key and encrypts it again with the current key. Safe to run more than once; it is audited." />
              <Button className="mt-2" loading={reseal.isPending} disabled={!r.totals.previous} onClick={() => reseal.mutate()}>Re-encrypt {r.totals.previous} {r.totals.previous === 1 ? 'secret' : 'secrets'}</Button>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
