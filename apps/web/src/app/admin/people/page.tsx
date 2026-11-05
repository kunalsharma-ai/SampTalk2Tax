'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { AdminPerson, PlatformRole, ROLE_LABEL, useMeWithRole } from '@/lib/admin';

export default function AdminPeoplePage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [q, setQ] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['admin-people', q.trim()], queryFn: () => api<AdminPerson[]>(`/v1/admin/people${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-people'] });
  const act = useMutation({
    mutationFn: async (a: { kind: 'disable' | 'enable' | 'sign-out'; p: AdminPerson; reason?: string }) => {
      const r = await api<{ sessionsEnded?: number }>(`/v1/admin/people/${a.p.id}/${a.kind}`, { method: 'POST', body: a.kind === 'disable' ? { reason: a.reason ?? '' } : undefined });
      return { ...a, r };
    },
    onSuccess: async ({ kind, p, r }) => {
      setNote(kind === 'disable' ? `${p.name} is disabled; ${r.sessionsEnded} session(s) ended.` : kind === 'enable' ? `${p.name} can sign in again.` : `${p.name} is signed out everywhere (${r.sessionsEnded} session(s)).`);
      await refresh();
    },
  });
  const role = useMutation({
    mutationFn: (a: { p: AdminPerson; platformRole: PlatformRole | null }) => api(`/v1/admin/people/${a.p.id}/platform-role`, { method: 'PUT', body: { platformRole: a.platformRole } }),
    onSuccess: async () => { setNote(null); await refresh(); await qc.invalidateQueries({ queryKey: ['me-role'] }); },
  });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const disable = (p: AdminPerson) => {
    const reason = window.prompt(`Why is ${p.name} being disabled? They are signed out everywhere and cannot sign in.`);
    if (reason !== null) act.mutate({ kind: 'disable', p, reason });
  };
  return (
    <>
      <PageHeader
        title="People"
        description="Everyone registered on this region's service, newest first (up to 200). Disabling signs a person out everywhere and stops them signing in; their organisations and records are untouched."
        actions={<Input className="w-72" aria-label="Search people" placeholder="Name or email" value={q} onChange={(e) => setQ(e.target.value)} />}
      />
      <ErrorAlert title="Not done" error={list.error ?? act.error ?? role.error} />
      {note ? <p role="status" className="mb-4 text-sm text-positive">{note}</p> : null}
      <Card aria-label="People">
        {list.data?.length ? (
          <Table>
            <thead><tr><Th>Person</Th><Th numeric>Organisations</Th><Th>Joined</Th><Th>Last seen</Th><Th numeric>Signed in on</Th><Th>Platform role</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {list.data.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <span className="font-medium">{p.name}</span> {p.active ? null : <Badge tone="negative">Disabled</Badge>}
                    <span className="block text-xs text-fg-muted">{p.email}</span>
                  </Td>
                  <Td numeric>{p.organisations}</Td>
                  <Td>{date(p.joinedAt.slice(0, 10))}</Td>
                  <Td className="whitespace-nowrap text-sm">{p.lastSeenAt ? dateTime(p.lastSeenAt) : '—'}</Td>
                  <Td numeric>{p.openSessions} {p.openSessions === 1 ? 'device' : 'devices'}</Td>
                  <Td>
                    {manage ? (
                      <Select className="w-36" aria-label={`Platform role of ${p.email}`} value={p.platformRole ?? ''} onChange={(e) => role.mutate({ p, platformRole: (e.target.value || null) as PlatformRole | null })}>
                        <option value="">None</option>
                        <option value="SUPPORT">{ROLE_LABEL.SUPPORT}</option>
                        <option value="SUPER_ADMIN">{ROLE_LABEL.SUPER_ADMIN}</option>
                      </Select>
                    ) : p.platformRole ? ROLE_LABEL[p.platformRole] : '—'}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {manage && p.id !== me.data?.user.id ? (
                      <>
                        {p.openSessions ? <Button variant="ghost" size="sm" onClick={() => act.mutate({ kind: 'sign-out', p })}>Sign out</Button> : null}
                        {p.active ? <Button variant="ghost" size="sm" aria-label={`Disable ${p.email}`} onClick={() => disable(p)}>Disable</Button> : <Button variant="ghost" size="sm" aria-label={`Enable ${p.email}`} onClick={() => act.mutate({ kind: 'enable', p })}>Enable</Button>}
                      </>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : list.data ? <EmptyState title="No one matches">Try another name or email.</EmptyState> : null}
      </Card>
    </>
  );
}
