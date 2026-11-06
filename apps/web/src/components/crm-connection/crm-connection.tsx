'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  hint: string;
  scopes: string[];
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}
export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  secretHint: string;
  secretUsable: boolean;
  deliveries: { pending: number; succeeded: number; failed: number };
  lastDelivery: { status: string; at: string | null; statusCode: number | null; error: string | null } | null;
}
interface Delivery {
  id: string;
  event: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  nextAttemptAt: string | null;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const SCOPE_LABEL: Record<string, string> = { 'crm.read': 'Read leads, deals and customers', 'crm.write': 'Create and update leads and deals, and convert leads' };
const STATUS_TONE = { ACTIVE: 'positive', EXPIRED: 'warning', REVOKED: 'neutral', PENDING: 'warning', SUCCEEDED: 'positive', FAILED: 'negative' } as const;

/** A secret shown once, with a copy button. */
function ShowOnce({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" aria-label={label} className="mb-4 rounded-[var(--t2t-radius-md)] border border-positive/40 bg-positive/10 p-3 text-sm">
      <p className="font-medium text-fg">{children}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-bg px-2 py-1 font-mono text-xs text-fg">{value}</code>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

/** API keys another system uses to call the CRM API. */
export function ApiKeysCard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const key = ['crm-keys', orgId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ keys: ApiKeyRow[] }>(`/v1/orgs/${orgId}/crm-connection/keys`) });
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api<ApiKeyRow & { key: string }>(`/v1/orgs/${orgId}/crm-connection/keys`, { method: 'POST', body: { name: name.trim(), scopes: write ? ['crm.read', 'crm.write'] : ['crm.read'], expiresAt: expiresAt || null } }),
    onSuccess: async (r) => {
      setMade({ name: r.name, key: r.key });
      setName('');
      setExpiresAt('');
      await qc.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api<{ keys: ApiKeyRow[] }>(`/v1/orgs/${orgId}/crm-connection/keys/${id}/revoke`, { method: 'POST' }), onSuccess: (r) => qc.setQueryData(key, r) });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <Card className="p-5" role="region" aria-label="CRM API keys">
      <CardHeader title="CRM API keys" description="Let another system, such as your CRM or a website form, read and create leads, deals and customers here. A key acts as the person who made it, within what you allow." />
      {made ? (
        <ShowOnce label="New API key" value={made.key}>
          Copy the key for {made.name} now. It is not shown again; if it is lost, revoke it and make another.
        </ShowOnce>
      ) : null}
      <form
        aria-label="New API key"
        className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_auto_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          setMade(null);
          create.mutate();
        }}
      >
        <Field label="Key name" hint="Name it after the system that will use it.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HubSpot sync" />}
        </Field>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
          Can create and change records
        </label>
        <Field label="Expires (optional)">
          {(p) => <Input {...p} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />}
        </Field>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'Making…' : 'Make key'}
        </Button>
      </form>
      <ErrorAlert title="Key not made" error={create.error} />
      <ErrorAlert title="Could not revoke" error={revoke.error} />
      {q.data?.keys.length ? (
        <div className="mt-4 overflow-x-auto">
          <Table aria-label="API keys">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Can</Th>
                <Th>Made</Th>
                <Th>Last used</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {q.data.keys.map((k) => (
                <Tr key={k.id}>
                  <Td className="font-medium">{k.name}</Td>
                  <Td className="font-mono text-xs">{k.hint}</Td>
                  <Td className="text-xs">{k.scopes.map((s) => SCOPE_LABEL[s] ?? s).join('; ')}</Td>
                  <Td className="text-xs">
                    {when(k.createdAt)}
                    {k.createdBy ? `, ${k.createdBy}` : ''}
                    {k.expiresAt ? <span className="block text-fg-muted">Expires {when(k.expiresAt)}</span> : null}
                  </Td>
                  <Td className="text-xs">{k.lastUsedAt ? when(k.lastUsedAt) : 'Never'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[k.status]}>{k.status === 'ACTIVE' ? 'Active' : k.status === 'EXPIRED' ? 'Expired' : 'Revoked'}</Badge>
                    {k.revokedBy ? <span className="block text-xs text-fg-muted">by {k.revokedBy}</span> : null}
                  </Td>
                  <Td>
                    {k.status === 'ACTIVE' ? (
                      <Button size="sm" variant="secondary" aria-label={`Revoke ${k.name}`} disabled={revoke.isPending} onClick={() => window.confirm(`Revoke ${k.name}? Anything using it stops working at once.`) && revoke.mutate(k.id)}>
                        Revoke
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : q.data ? (
        <p className="mt-4 text-sm text-fg-muted">No keys yet.</p>
      ) : null}
      <details className="mt-4 text-sm text-fg-muted">
        <summary className="cursor-pointer text-fg">How the other system uses a key</summary>
        <p className="mt-2">
          Send it on every call as <code className="font-mono text-xs">Authorization: Bearer t2t_…</code> to <code className="font-mono text-xs">{origin}/api/crm</code> followed by the call. Calls: <code className="font-mono text-xs">GET /me</code>, <code className="font-mono text-xs">GET|POST /leads</code>, <code className="font-mono text-xs">POST /leads/:id/status</code>, <code className="font-mono text-xs">POST /leads/:id/convert</code>, <code className="font-mono text-xs">GET|POST /deals</code>, <code className="font-mono text-xs">POST /deals/:id/stage</code>, <code className="font-mono text-xs">GET /customers</code>. Send your own id as <code className="font-mono text-xs">externalRef</code> when creating a lead or deal: sending it again returns the first record instead of a copy. Every change is in the audit trail with the key used.
        </p>
      </details>
    </Card>
  );
}

function Deliveries({ orgId, hook }: { orgId: string; hook: WebhookRow }) {
  const qc = useQueryClient();
  const key = ['crm-hook-deliveries', orgId, hook.id];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ deliveries: Delivery[] }>(`/v1/orgs/${orgId}/crm-connection/webhooks/${hook.id}/deliveries`) });
  const retry = useMutation({
    mutationFn: (id: string) => api<{ deliveries: Delivery[] }>(`/v1/orgs/${orgId}/crm-connection/webhooks/${hook.id}/deliveries/${id}/retry`, { method: 'POST' }),
    onSuccess: async (r) => {
      qc.setQueryData(key, r);
      await qc.invalidateQueries({ queryKey: ['crm-hooks', orgId] });
    },
  });
  if (!q.data) return null;
  if (!q.data.deliveries.length) return <p className="mt-2 text-sm text-fg-muted">Nothing sent yet.</p>;
  return (
    <div className="mt-2 overflow-x-auto">
      <Table aria-label={`Deliveries to ${hook.name}`}>
        <thead>
          <tr>
            <Th>Event</Th>
            <Th>When</Th>
            <Th>Status</Th>
            <Th numeric>Attempts</Th>
            <Th>Answer</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {q.data.deliveries.map((d) => (
            <Tr key={d.id}>
              <Td className="font-mono text-xs">{d.event}</Td>
              <Td className="text-xs">{when(d.createdAt)}</Td>
              <Td>
                <Badge tone={STATUS_TONE[d.status]}>{d.status === 'SUCCEEDED' ? 'Delivered' : d.status === 'FAILED' ? 'Failed' : 'Waiting'}</Badge>
                {d.nextAttemptAt ? <span className="block text-xs text-fg-muted">Next try {when(d.nextAttemptAt)}</span> : null}
              </Td>
              <Td numeric>{d.attempts}</Td>
              <Td className="text-xs">{d.statusCode ? `HTTP ${d.statusCode}` : ''}{d.error ? ` ${d.error}` : ''}</Td>
              <Td>{d.status === 'FAILED' ? <Button size="sm" variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate(d.id)}>Send again</Button> : null}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <ErrorAlert title="Could not send again" error={retry.error} />
    </div>
  );
}

/** Webhooks that send CRM events to another system. */
export function CrmWebhooksCard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const key = ['crm-hooks', orgId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ webhooks: WebhookRow[]; events: { event: string; label: string }[]; signatureHeader: string }>(`/v1/orgs/${orgId}/crm-connection/webhooks`) });
  const [form, setForm] = useState<{ name: string; url: string; events: string[] }>({ name: '', url: '', events: ['lead.created', 'deal.won'] });
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, { ok: boolean; statusCode: number | null; error: string | null }>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () => api<WebhookRow & { secret: string }>(`/v1/orgs/${orgId}/crm-connection/webhooks`, { method: 'POST', body: form }),
    onSuccess: async (r) => {
      setSecret({ name: r.name, secret: r.secret });
      setForm({ name: '', url: '', events: ['lead.created', 'deal.won'] });
      await refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (h: WebhookRow) => api(`/v1/orgs/${orgId}/crm-connection/webhooks/${h.id}`, { method: 'PUT', body: { name: h.name, url: h.url, events: h.events, enabled: !h.enabled } }), onSuccess: refresh });
  const rotate = useMutation({
    mutationFn: (id: string) => api<WebhookRow & { secret: string }>(`/v1/orgs/${orgId}/crm-connection/webhooks/${id}/rotate-secret`, { method: 'POST' }),
    onSuccess: async (r) => {
      setSecret({ name: r.name, secret: r.secret });
      await refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/v1/orgs/${orgId}/crm-connection/webhooks/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const test = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; statusCode: number | null; error: string | null }>(`/v1/orgs/${orgId}/crm-connection/webhooks/${id}/test`, { method: 'POST' }),
    onSuccess: async (r, id) => {
      setTested((t) => ({ ...t, [id]: r }));
      await refresh();
      await qc.invalidateQueries({ queryKey: ['crm-hook-deliveries', orgId, id] });
    },
  });
  const d = q.data;
  return (
    <Card className="p-5" role="region" aria-label="CRM webhooks">
      <CardHeader title="CRM webhooks" description="Send CRM events, such as a new lead or a won deal, to another system as they happen. Each call is signed so the other system can check it came from Talk2Tax." />
      {secret ? (
        <ShowOnce label="Signing secret" value={secret.secret}>
          Copy the signing secret for {secret.name} now and give it to the receiving system. It is not shown again.
        </ShowOnce>
      ) : null}
      {d ? (
        <form
          aria-label="New webhook"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSecret(null);
            create.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Webhook name">{(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Sales CRM" />}</Field>
            <Field label="Address to send to" hint="An https:// address on the other system.">
              {(p) => <Input {...p} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://crm.example.com/hooks/talk2tax" />}
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-fg-muted">Events to send</legend>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {d.events.map((ev) => (
                <label key={ev.event} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.events.includes(ev.event)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev.event] : form.events.filter((x) => x !== ev.event) })} />
                  <span>{ev.label}</span>
                  <code className="font-mono text-[11px] text-fg-faint">{ev.event}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" disabled={!form.name.trim() || !form.url.trim() || !form.events.length || create.isPending}>
            {create.isPending ? 'Adding…' : 'Add webhook'}
          </Button>
        </form>
      ) : null}
      <ErrorAlert title="Webhook not added" error={create.error} />
      <ErrorAlert title="Could not change the webhook" error={toggle.error ?? rotate.error ?? remove.error} />
      <ErrorAlert title="Could not test" error={test.error} />
      {d?.webhooks.length ? (
        <ul className="mt-4 space-y-3">
          {d.webhooks.map((h) => (
            <li key={h.id} aria-label={h.name} className="rounded-[var(--t2t-radius-md)] border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-fg">
                    {h.name} {h.enabled ? <Badge tone="positive">On</Badge> : <Badge tone="neutral">Off</Badge>}
                  </p>
                  <p className="break-all font-mono text-xs text-fg-muted">{h.url}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {h.events.join(', ')} · secret ending {h.secretHint} · {h.deliveries.succeeded} delivered, {h.deliveries.pending} waiting, {h.deliveries.failed} failed
                  </p>
                  {!h.secretUsable ? <Alert tone="warning" title="Rotate the secret">The stored secret was sealed with an encryption key this server no longer has, so nothing can be sent until you rotate it.</Alert> : null}
                  {tested[h.id] ? (
                    <p role="status" aria-label={`Test of ${h.name}`} className="mt-1 text-sm">
                      <Badge tone={tested[h.id]!.ok ? 'positive' : 'negative'}>{tested[h.id]!.ok ? 'Test received' : 'Test failed'}</Badge> {tested[h.id]!.statusCode ? `HTTP ${tested[h.id]!.statusCode}` : ''} {tested[h.id]!.error ?? ''}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={test.isPending} onClick={() => test.mutate(h.id)}>Send test</Button>
                  <Button size="sm" variant="secondary" onClick={() => setOpen(open === h.id ? null : h.id)} aria-expanded={open === h.id}>Deliveries</Button>
                  <Button size="sm" variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate(h)}>{h.enabled ? 'Turn off' : 'Turn on'}</Button>
                  <Button size="sm" variant="secondary" disabled={rotate.isPending} onClick={() => window.confirm('Make a new signing secret? The old one stops working at once.') && rotate.mutate(h.id)}>New secret</Button>
                  <Button size="sm" variant="secondary" disabled={remove.isPending} onClick={() => window.confirm(`Remove ${h.name}? Its delivery history goes with it.`) && remove.mutate(h.id)}>Remove</Button>
                </div>
              </div>
              {open === h.id ? <Deliveries orgId={orgId} hook={h} /> : null}
            </li>
          ))}
        </ul>
      ) : d ? (
        <p className="mt-4 text-sm text-fg-muted">No webhooks yet.</p>
      ) : null}
      {d ? (
        <details className="mt-4 text-sm text-fg-muted">
          <summary className="cursor-pointer text-fg">How the other system checks a call</summary>
          <p className="mt-2">
            Each call is a POST of JSON with <code className="font-mono text-xs">event</code>, <code className="font-mono text-xs">occurredAt</code>, <code className="font-mono text-xs">data</code> (what changed) and <code className="font-mono text-xs">object</code> (the record). The <code className="font-mono text-xs">{d.signatureHeader}</code> header is <code className="font-mono text-xs">t=&lt;seconds&gt;,v1=&lt;HMAC-SHA256 of &quot;t.body&quot; with the secret&gt;</code>. Answer with any 2xx; anything else is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours.
          </p>
        </details>
      ) : null}
    </Card>
  );
}
