'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Role = 'ACCOUNTANT' | 'APPROVER' | 'VIEWER' | 'EMPLOYEE';
type Overview = {
  canManage: boolean;
  redirectUri: string;
  autoJoinRoles: Role[];
  connection: { protocol: string; issuer: string; clientId: string; clientSecretHint: string; clientSecretReadable: boolean; enabled: boolean; enforced: boolean; autoJoinRole: Role | null; updatedAt: string } | null;
  domains: { id: string; domain: string; verifiedAt: string | null; record: { name: string; value: string } }[];
};
const ROLE_NAMES: Record<Role, string> = { ACCOUNTANT: 'Accountant', APPROVER: 'Approver', VIEWER: 'Viewer', EMPLOYEE: 'Employee' };

/** Single sign-on with OpenID Connect (SEC-006/007). */
export default function SsoPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/sso`;
  const q = useQuery({ queryKey: ['sso', orgId], queryFn: () => api<Overview>(base) });
  const done = (o: Overview) => qc.setQueryData(['sso', orgId], o);
  const [form, setForm] = useState({ issuer: '', clientId: '', clientSecret: '', enabled: true, enforced: false, autoJoinRole: '' as Role | '' });
  const [domain, setDomain] = useState('');
  const c = q.data?.connection;
  useEffect(() => {
    if (c) setForm({ issuer: c.issuer, clientId: c.clientId, clientSecret: '', enabled: c.enabled, enforced: c.enforced, autoJoinRole: c.autoJoinRole ?? '' });
  }, [c]);
  const save = useMutation({
    mutationFn: () => api<Overview>(base, { method: 'PUT', body: { issuer: form.issuer, clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}), enabled: form.enabled, enforced: form.enforced, autoJoinRole: form.autoJoinRole || null } }),
    onSuccess: (o) => {
      done(o);
      setForm((f) => ({ ...f, clientSecret: '' }));
    },
  });
  const remove = useMutation({ mutationFn: () => api<Overview>(base, { method: 'DELETE' }), onSuccess: done });
  const add = useMutation({ mutationFn: () => api<Overview>(`${base}/domains`, { method: 'POST', body: { domain } }), onSuccess: (o) => (done(o), setDomain('')) });
  const verify = useMutation({ mutationFn: (id: string) => api<Overview>(`${base}/domains/${id}/verify`, { method: 'POST' }), onSuccess: done });
  const drop = useMutation({ mutationFn: (id: string) => api<Overview>(`${base}/domains/${id}`, { method: 'DELETE' }), onSuccess: done });
  if (!org) return null;
  const o = q.data;
  const manage = !!o?.canManage;
  const verified = o?.domains.filter((d) => d.verifiedAt).length ?? 0;

  return (
    <>
      <PageHeader
        title="Single sign-on"
        description="Let your team sign in with your organisation's identity provider (Microsoft Entra ID, Google Workspace, Okta or any OpenID Connect provider) instead of a Talk2Tax password."
      />
      <ErrorAlert title="Could not load single sign-on" error={q.error} />
      {o ? (
        <>
          <Card className="mb-4">
            <CardHeader
              title="Identity provider"
              description="Register Talk2Tax in your provider as a web application, with the redirect URI below, and copy its issuer URL, client ID and client secret here."
              actions={c ? <Badge tone={c.enabled ? (c.enforced ? 'accent' : 'positive') : 'neutral'}>{c.enabled ? (c.enforced ? 'Required' : 'On') : 'Off'}</Badge> : <Badge tone="neutral">Not set up</Badge>}
            />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <p className="text-sm font-medium">Redirect URI</p>
                <code className="mt-1 block break-all rounded bg-surface-muted px-2 py-1 text-sm" data-testid="redirect-uri">{o.redirectUri}</code>
              </div>
              {manage ? (
                <form
                  aria-label="Identity provider"
                  className="contents"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate();
                  }}
                >
                  <Field label="Issuer URL" hint="For example https://login.microsoftonline.com/<tenant id>/v2.0 or https://accounts.google.com">{(p) => <Input {...p} value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} />}</Field>
                  <Field label="Client ID">{(p) => <Input {...p} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />}</Field>
                  <Field label="Client secret" hint={c ? `Saved (${c.clientSecretHint}). Leave empty to keep it.` : 'Stored encrypted; never shown again.'}>
                    {(p) => <Input {...p} type="password" autoComplete="off" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} />}
                  </Field>
                  <Field label="New people at verified domains" hint="Someone at a verified domain who is not a member yet.">
                    {(p) => (
                      <Select {...p} value={form.autoJoinRole} onChange={(e) => setForm({ ...form, autoJoinRole: e.target.value as Role | '' })}>
                        <option value="">Refused: invite them first</option>
                        {o.autoJoinRoles.map((r) => (
                          <option key={r} value={r}>
                            Join as {ROLE_NAMES[r]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked, enforced: e.target.checked && form.enforced })} /> Single sign-on is on
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.enforced} disabled={!form.enabled || !verified} onChange={(e) => setForm({ ...form, enforced: e.target.checked })} /> Require it: members at verified domains cannot use a password (owners still can)
                  </label>
                  <div className="flex gap-2 sm:col-span-2">
                    <Button type="submit" loading={save.isPending} disabled={!form.issuer || !form.clientId || (!c && !form.clientSecret)}>
                      {c ? 'Save' : 'Connect'}
                    </Button>
                    {c ? (
                      <Button type="button" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                        Disconnect
                      </Button>
                    ) : null}
                  </div>
                  <div className="sm:col-span-2">
                    <ErrorAlert title="Not saved" error={save.error} />
                    <ErrorAlert title="Not disconnected" error={remove.error} />
                  </div>
                </form>
              ) : c ? (
                <dl className="grid gap-2 text-sm sm:col-span-2">
                  <div><dt className="inline text-fg-muted">Issuer: </dt><dd className="inline">{c.issuer}</dd></div>
                  <div><dt className="inline text-fg-muted">Client ID: </dt><dd className="inline">{c.clientId}</dd></div>
                  <div><dt className="inline text-fg-muted">Updated: </dt><dd className="inline">{dateTime(c.updatedAt)}</dd></div>
                </dl>
              ) : (
                <p className="text-sm text-fg-muted sm:col-span-2">Not set up. Owners and admins can connect a provider.</p>
              )}
              {c && !c.clientSecretReadable ? <p className="text-sm text-danger sm:col-span-2">The client secret was sealed with an encryption key this server no longer has. Enter it again.</p> : null}
            </div>
          </Card>
          <Card>
            <CardHeader title="Sign-in domains" description="Email domains that sign in with this provider. Prove each one by adding the TXT record shown to its DNS; only emails at verified domains are accepted." />
            {manage ? (
              <form
                aria-label="Add a domain"
                className="flex items-end gap-2 p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  add.mutate();
                }}
              >
                <Field label="Domain">{(p) => <Input {...p} placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} className="w-64" />}</Field>
                <Button type="submit" variant="secondary" loading={add.isPending} disabled={!domain.trim()}>
                  Add domain
                </Button>
              </form>
            ) : null}
            <div className="px-4">
              <ErrorAlert title="Domain not added" error={add.error} />
              <ErrorAlert title="Not verified yet" error={verify.error} />
              <ErrorAlert title="Domain not removed" error={drop.error} />
            </div>
            {!o.domains.length ? (
              <EmptyState title="No domains yet">Add the domain of your work email addresses, such as example.com.</EmptyState>
            ) : (
              <Table aria-label="Sign-in domains">
                <thead>
                  <tr><Th>Domain</Th><Th>Status</Th><Th>DNS TXT record</Th><Th /></tr>
                </thead>
                <tbody>
                  {o.domains.map((d) => (
                    <Tr key={d.id}>
                      <Td className="font-medium">{d.domain}</Td>
                      <Td>{d.verifiedAt ? <Badge tone="positive">Verified</Badge> : <Badge tone="warning">Waiting for DNS</Badge>}</Td>
                      <Td className="text-xs">
                        <span className="block text-fg-muted">Name</span>
                        <code className="break-all">{d.record.name}</code>
                        <span className="mt-1 block text-fg-muted">Value</span>
                        <code className="break-all">{d.record.value}</code>
                      </Td>
                      <Td className="whitespace-nowrap text-right">
                        {manage ? (
                          <span className="inline-flex gap-2">
                            {!d.verifiedAt ? <Button size="sm" loading={verify.isPending && verify.variables === d.id} onClick={() => verify.mutate(d.id)}>Verify</Button> : null}
                            <Button size="sm" variant="ghost" loading={drop.isPending && drop.variables === d.id} onClick={() => drop.mutate(d.id)}>Remove</Button>
                          </span>
                        ) : null}
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
