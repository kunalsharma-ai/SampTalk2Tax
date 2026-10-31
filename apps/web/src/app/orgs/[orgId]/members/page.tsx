'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type Role } from '@/lib/types';

const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Everything, including granting owner',
  ADMIN: 'Everything except granting owner',
  ACCOUNTANT: 'Accounts, journals, reversals, reports, audit',
  APPROVER: 'Post drafts, read reports and audit',
  VIEWER: 'Read-only',
};

export default function MembersPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ACCOUNTANT');
  const q = useQuery({ queryKey: ['members', orgId], queryFn: () => api<{ userId: string; email: string; name: string; role: Role; since: string }[]>(`/v1/orgs/${orgId}/members`) });
  const add = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/members`, { method: 'POST', body: { email, role } }),
    onSuccess: async () => {
      setEmail('');
      await qc.invalidateQueries({ queryKey: ['members', orgId] });
    },
  });
  if (!org) return null;
  return (
    <>
      <PageHeader title="Team and roles" description="Roles decide what each person can do. The server checks every request against the role." />
      {can(org.role, 'members.manage') ? (
        <Card className="mb-6">
          <CardHeader title="Add a member" description="They need a Talk2Tax account first. Email invitations are coming later." />
          <form className="flex flex-wrap items-end gap-3 p-5" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <label className="flex min-w-64 flex-1 flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Email
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Role
              <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {(Object.keys(ROLE_HELP) as Role[]).filter((r) => org.role === 'OWNER' || r !== 'OWNER').map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
              </Select>
            </label>
            <Button type="submit" loading={add.isPending}>Add member</Button>
            <p className="w-full text-xs text-fg-faint">{ROLE_HELP[role]}</p>
            {add.error ? <div className="w-full"><Alert title="Could not add">{add.error instanceof ApiError ? add.error.message : 'Try again.'}</Alert></div> : null}
          </form>
        </Card>
      ) : null}
      <Card>
        <Table>
          <thead>
            <tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Member since</Th></tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((m) => (
              <Tr key={m.userId}>
                <Td>{m.name}</Td>
                <Td className="text-fg-muted">{m.email}</Td>
                <Td><Badge tone="violet">{m.role.toLowerCase()}</Badge> <span className="ml-2 text-xs text-fg-faint">{ROLE_HELP[m.role]}</span></Td>
                <Td className="text-fg-muted">{date(m.since.slice(0, 10))}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
