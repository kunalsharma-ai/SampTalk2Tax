'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import { api } from '@/lib/api';
import { date, dateTime, istDay } from '@/lib/format';

export interface KnownDevice {
  id: string;
  label: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIp: string | null;
  trustedUntil: string | null;
  current: boolean;
  signedIn: number;
}

/**
 * The browsers this person has signed in from (SEC-009). A sign-in from one not seen before is
 * emailed to them. The device in use can be trusted for 30 days, so signing in there skips the
 * two-step code; any device can lose its trust or be forgotten (signed out, and new next time).
 */
export function KnownDevicesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['known-devices'], queryFn: () => api<KnownDevice[]>('/v1/auth/devices') });
  const done = (rows: KnownDevice[]) => {
    qc.setQueryData(['known-devices'], rows);
    void qc.invalidateQueries({ queryKey: ['auth-sessions'] });
  };
  const trust = useMutation({ mutationFn: () => api<KnownDevice[]>('/v1/auth/devices/current/trust', { method: 'POST' }), onSuccess: done });
  const untrust = useMutation({ mutationFn: (id: string) => api<KnownDevice[]>(`/v1/auth/devices/${id}/trust`, { method: 'DELETE' }), onSuccess: done });
  const forget = useMutation({ mutationFn: (id: string) => api<KnownDevice[]>(`/v1/auth/devices/${id}`, { method: 'DELETE' }), onSuccess: done });
  const rows = q.data ?? [];
  const current = rows.find((d) => d.current);
  const error = trust.error ?? untrust.error ?? forget.error;
  return (
    <Card className="mb-6">
      <CardHeader
        title="Your devices"
        description="Browsers you have signed in from. A sign-in from a device not seen before is emailed to you. Trust the device you are using to skip the two-step code here for 30 days."
        actions={
          current && !current.trustedUntil ? (
            <Button size="sm" variant="secondary" loading={trust.isPending} onClick={() => trust.mutate()}>
              Trust this device
            </Button>
          ) : null
        }
      />
      {error ? <div className="px-5 pb-3"><Alert title="Not changed">{error.message}</Alert></div> : null}
      <Table aria-label="Your devices">
        <thead><tr><Th>Device</Th><Th>First seen</Th><Th>Last sign-in</Th><Th>Address</Th><Th>Trusted</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
        <tbody>
          {q.isLoading ? <Tr><Td colSpan={6} className="text-fg-muted">Loading…</Td></Tr> : null}
          {!q.isLoading && !rows.length ? <Tr><Td colSpan={6} className="text-fg-muted">No devices yet. Devices are recorded from your next sign-in.</Td></Tr> : null}
          {rows.map((d) => (
            <Tr key={d.id}>
              <Td>
                <span className="font-medium">{d.label}</span> {d.current ? <Badge tone="accent">This device</Badge> : null}
                {d.signedIn ? <span className="block text-xs text-fg-faint">{d.signedIn} {d.signedIn === 1 ? 'session' : 'sessions'} signed in</span> : null}
              </Td>
              <Td className="text-fg-muted">{dateTime(d.firstSeenAt)}</Td>
              <Td className="text-fg-muted">{dateTime(d.lastSeenAt)}</Td>
              <Td className="text-fg-muted">{d.lastIp ?? '—'}</Td>
              <Td>{d.trustedUntil ? <Badge tone="positive">Until {date(istDay(d.trustedUntil))}</Badge> : <span className="text-fg-faint">No</span>}</Td>
              <Td className="whitespace-nowrap text-right">
                {d.trustedUntil ? (
                  <Button size="sm" variant="ghost" aria-label={`Stop trusting ${d.label}`} loading={untrust.isPending && untrust.variables === d.id} onClick={() => untrust.mutate(d.id)}>
                    Stop trusting
                  </Button>
                ) : null}
                {d.current ? null : (
                  <Button size="sm" variant="ghost" aria-label={`Forget ${d.label}, last signed in ${dateTime(d.lastSeenAt)}`} loading={forget.isPending && forget.variables === d.id} onClick={() => forget.mutate(d.id)}>
                    Forget
                  </Button>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
