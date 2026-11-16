'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type Invitation, type Member, type Role } from '@/lib/types';

const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Everything, including granting owner',
  ADMIN: 'Everything except granting owner',
  ACCOUNTANT: 'Accounts, journals, reversals, reports, audit',
  APPROVER: 'Approve and post drafts and expense claims, read reports and audit',
  VIEWER: 'Read-only',
  EMPLOYEE: 'Only their own expense claims; sees nothing of the books',
};
const ROLES = Object.keys(ROLE_HELP) as Role[];
const STATUS_TONE = { PENDING: 'accent', EXPIRED: 'warning', ACCEPTED: 'positive', REVOKED: 'neutral' } as const;
const label = (r: Role) => r.charAt(0) + r.slice(1).toLowerCase();

type Issued = { invitation: Invitation; token: string };

function grantable(actor: Role | undefined, target: Role) {
  return actor === 'OWNER' || (actor === 'ADMIN' && target !== 'OWNER');
}

export default function MembersPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ACCOUNTANT');
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const refresh = async () => {
    for (const k of ['members', 'invitations']) await qc.invalidateQueries({ queryKey: [k, orgId] });
  };
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => api<Member[]>(`/v1/orgs/${orgId}/members`) });
  const invitations = useQuery({ queryKey: ['invitations', orgId], queryFn: () => api<Invitation[]>(`/v1/orgs/${orgId}/invitations`) });
  const show = (r: Issued) => {
    setCopied(false);
    setIssued(r);
  };
  const invite = useMutation({
    mutationFn: () => api<Issued>(`/v1/orgs/${orgId}/invitations`, { method: 'POST', body: { email, role } }),
    onSuccess: async (r) => {
      setEmail('');
      show(r);
      await refresh();
    },
  });
  const renew = useMutation({ mutationFn: (id: string) => api<Issued>(`/v1/orgs/${orgId}/invitations/${id}/renew`, { method: 'POST' }), onSuccess: async (r) => { show(r); await refresh(); } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/v1/orgs/${orgId}/invitations/${id}/revoke`, { method: 'POST' }), onSuccess: refresh });
  const changeRole = useMutation({ mutationFn: (v: { userId: string; role: Role }) => api(`/v1/orgs/${orgId}/members/${v.userId}`, { method: 'PUT', body: { role: v.role } }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (userId: string) => api<void>(`/v1/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });
  if (!org) return null;
  const manage = can(org.role, 'members.manage');
  const link = issued && typeof window !== 'undefined' ? `${window.location.origin}/invite/${issued.token}` : '';
  const open = (invitations.data ?? []).filter((i) => i.status === 'PENDING' || i.status === 'EXPIRED');
  const history = (invitations.data ?? []).filter((i) => i.status === 'ACCEPTED' || i.status === 'REVOKED').slice(0, 10);
  const actionError = renew.error ?? revoke.error ?? changeRole.error;

  return (
    <>
      <PageHeader title="Team and roles" description="Roles decide what each person can do. The server checks every request against the role." />
      {manage ? (
        <Card className="mb-6">
          <CardHeader title="Invite someone" description="You get a link to send them. Talk2Tax does not send email yet. The link works once, only for that email address, for 7 days." />
          <form className="flex flex-wrap items-end gap-3 p-5" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
            <label className="flex min-w-64 flex-1 flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Email
              <Input type="email" aria-label="Email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Role
              <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.filter((r) => grantable(org.role, r)).map((r) => <option key={r} value={r}>{label(r)}</option>)}
              </Select>
            </label>
            <Button type="submit" loading={invite.isPending}>Create invite link</Button>
            <p className="w-full text-xs text-fg-faint">{ROLE_HELP[role]}</p>
            {invite.error ? <div className="w-full"><Alert title="Could not invite">{invite.error instanceof ApiError ? invite.error.message : 'Try again.'}</Alert></div> : null}
          </form>
        </Card>
      ) : null}

      {actionError ? <div className="mb-4"><Alert title="That did not work">{actionError.message}</Alert></div> : null}

      <Card className="mb-6">
        <CardHeader title="Members" />
        <Table>
          <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Member since</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {(members.data ?? []).map((m) => {
              const editable = manage && grantable(org.role, m.role);
              return (
                <Tr key={m.userId}>
                  <Td>{m.name}</Td>
                  <Td className="text-fg-muted">{m.email}</Td>
                  <Td>
                    {editable ? (
                      <Select aria-label={`Role for ${m.name}`} value={m.role} disabled={changeRole.isPending} onChange={(e) => changeRole.mutate({ userId: m.userId, role: e.target.value as Role })}>
                        {ROLES.filter((r) => grantable(org.role, r)).map((r) => <option key={r} value={r}>{label(r)}</option>)}
                      </Select>
                    ) : (
                      <Badge tone="violet">{label(m.role)}</Badge>
                    )}
                    <span className="ml-2 text-xs text-fg-faint">{ROLE_HELP[m.role]}</span>
                  </Td>
                  <Td className="text-fg-muted">{date(m.since.slice(0, 10))}</Td>
                  <Td className="text-right">
                    {editable ? <Button size="sm" variant="ghost" aria-label={`Remove ${m.name}`} onClick={() => { remove.reset(); setRemoving(m); }}>Remove</Button> : null}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Invitations" description={open.length ? undefined : 'No open invitations.'} />
        {open.length || history.length ? (
          <Table>
            <thead><tr><Th>Email</Th><Th>Role</Th><Th>Status</Th><Th>Invited by</Th><Th>Link valid until</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {[...open, ...history].map((i) => (
                <Tr key={i.id}>
                  <Td>{i.email}</Td>
                  <Td>{label(i.role)}</Td>
                  <Td><Badge tone={STATUS_TONE[i.status]}>{i.status.toLowerCase()}</Badge></Td>
                  <Td className="text-fg-muted">{i.invitedBy ?? '—'}</Td>
                  <Td className="text-fg-muted">{i.status === 'PENDING' || i.status === 'EXPIRED' ? date(i.expiresAt.slice(0, 10)) : '—'}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {manage && (i.status === 'PENDING' || i.status === 'EXPIRED') && grantable(org.role, i.role) ? (
                      <>
                        <Button size="sm" variant="ghost" aria-label={`New link for ${i.email}`} loading={renew.isPending && renew.variables === i.id} onClick={() => renew.mutate(i.id)}>New link</Button>
                        <Button size="sm" variant="ghost" aria-label={`Revoke the invitation for ${i.email}`} loading={revoke.isPending && revoke.variables === i.id} onClick={() => revoke.mutate(i.id)}>Revoke</Button>
                      </>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>

      <Dialog open={!!issued} onOpenChange={(o) => !o && setIssued(null)} title="Invite link ready" description={issued ? `Send this link to ${issued.invitation.email}. They sign in (or create an account) with that email to join as ${label(issued.invitation.role).toLowerCase()}. It works once, until ${date(issued.invitation.expiresAt.slice(0, 10))}. This is the only time it is shown.` : ''}>
        <div className="flex flex-col gap-3">
          <Input readOnly aria-label="Invite link" value={link} onFocus={(e) => e.currentTarget.select()} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setIssued(null)}>Done</Button>
            <Button onClick={async () => { await navigator.clipboard?.writeText(link).catch(() => undefined); setCopied(true); }}>{copied ? 'Copied' : 'Copy link'}</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={removing ? `Remove ${removing.name}?` : ''} description="They lose access to this organisation straight away. Their past work and its audit history stay as they are.">
        {remove.error ? <div className="mb-3"><Alert title="Could not remove">{remove.error.message}</Alert></div> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing.userId)}>Remove member</Button>
        </div>
      </Dialog>
    </>
  );
}
