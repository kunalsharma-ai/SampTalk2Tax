'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ApiKeysCard, CrmWebhooksCard } from '@/components/crm-connection/crm-connection';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Source = 'ORGANISATION' | 'SERVER' | 'NONE';
interface CardState {
  kind: 'AI_ANTHROPIC' | 'EMAIL_SMTP';
  configured: boolean;
  enabled: boolean;
  secretHint: string | null;
  secretUnreadable: boolean;
  testStatus: 'NOT_TESTED' | 'OK' | 'FAILED';
  testMessage: string | null;
  testedAt: string | null;
  testedBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  inUse: Source;
  serverFallback: boolean;
}
interface EmailSettings {
  host: string;
  port: number;
  security: 'TLS' | 'STARTTLS' | 'NONE';
  username: string | null;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
}
interface Integrations {
  ai: CardState & { settings: { model: string } | null; modelInUse: string; models: { id: string; name: string }[]; defaultModel: string };
  email: CardState & { settings: EmailSettings | null; fromInUse: string | null; allowPlain: boolean };
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function InUse({ source, what }: { source: Source; what: string }) {
  if (source === 'ORGANISATION') return <Badge tone="positive">In use: your {what}</Badge>;
  if (source === 'SERVER') return <Badge tone="accent">In use: the server&apos;s {what}</Badge>;
  return <Badge tone="warning">Not set up</Badge>;
}

function TestResult({ c }: { c: CardState }) {
  if (!c.configured) return null;
  if (c.testStatus === 'NOT_TESTED') return <p className="text-sm text-fg-muted">Not tested since it was last changed.</p>;
  return (
    <div role="status" aria-label="Last test" className="flex flex-wrap items-start gap-2 text-sm">
      <Badge tone={c.testStatus === 'OK' ? 'positive' : 'negative'}>{c.testStatus === 'OK' ? 'Working' : 'Failed'}</Badge>
      <span className="text-fg">{c.testMessage}</span>
      {c.testedAt ? <span className="text-xs text-fg-muted">{when(c.testedAt)}{c.testedBy ? `, by ${c.testedBy}` : ''}</span> : null}
    </div>
  );
}

/** Actions shared by both cards: test the saved settings, and remove them. */
function useCardActions(orgId: string, path: 'ai' | 'email') {
  const qc = useQueryClient();
  const set = (d: Integrations) => qc.setQueryData(['integrations', orgId], d);
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string; integrations: Integrations }>(`/v1/orgs/${orgId}/integrations/${path}/test`, { method: 'POST' }),
    onSuccess: (r) => set(r.integrations),
  });
  const remove = useMutation({ mutationFn: () => api<Integrations>(`/v1/orgs/${orgId}/integrations/${path}`, { method: 'DELETE' }), onSuccess: set });
  return { test, remove, set };
}

function AiCard({ orgId, d }: { orgId: string; d: Integrations['ai'] }) {
  const listed = d.models.some((m) => m.id === (d.settings?.model ?? d.defaultModel));
  const [model, setModel] = useState(d.settings?.model ?? d.defaultModel);
  const [custom, setCustom] = useState(!listed);
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState(d.configured ? d.enabled : true);
  const [saved, setSaved] = useState(false);
  const { test, remove, set } = useCardActions(orgId, 'ai');
  const save = useMutation({
    mutationFn: () => api<Integrations>(`/v1/orgs/${orgId}/integrations/ai`, { method: 'PUT', body: { apiKey: key.trim() || null, model: model.trim(), enabled } }),
    onSuccess: (r) => (set(r), setKey(''), setSaved(true)),
  });
  return (
    <Card className="p-5" aria-label="AI (Claude)" role="region">
      <CardHeader
        title="AI: Anthropic Claude"
        description="Used by the copilot, collections reminders, bank reconciliation suggestions and the month-end review. Each AI feature is still switched on separately in the AI control center."
        actions={<InUse source={d.inUse} what="key" />}
      />
      {d.inUse === 'SERVER' && !d.configured ? <p className="mb-3 text-sm text-fg-muted">The server has a key set up, so AI works now. Add your own key to use your own Anthropic account and model.</p> : null}
      {d.secretUnreadable ? (
        <div className="mb-3">
          <Alert tone="warning" title="Enter the key again">The stored key was sealed with an encryption key this server no longer has, so it cannot be used. Paste the key again and save.</Alert>
        </div>
      ) : null}
      <form
        className="grid grid-cols-1 gap-3 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <Field label="API key" hint={d.secretHint && !d.secretUnreadable ? `A key ending ${d.secretHint} is stored. Leave this empty to keep it.` : 'From console.anthropic.com → API keys. It is stored encrypted and never shown again.'}>
          {(p) => <Input {...p} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={d.secretHint && !d.secretUnreadable ? `Stored: ${d.secretHint}` : 'sk-ant-…'} />}
        </Field>
        <Field label="Model" hint="Every AI feature uses this model.">
          {(p) =>
            custom ? (
              <Input {...p} value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-…" />
            ) : (
              <Select {...p} value={model} onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : setModel(e.target.value))}>
                {d.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                <option value="__custom">Another model…</option>
              </Select>
            )
          }
        </Field>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use this key for this organisation
        </label>
        <div className="flex flex-wrap items-center gap-2 md:col-span-2">
          <Button type="submit" loading={save.isPending}>Save</Button>
          {d.configured ? <Button type="button" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>Test connection</Button> : null}
          {d.configured ? <Button type="button" variant="ghost" onClick={() => confirm('Remove the stored AI key? AI features stop unless the server has a key of its own.') && remove.mutate()}>Remove</Button> : null}
          {saved ? <span role="status" className="text-sm text-positive">Saved</span> : null}
        </div>
      </form>
      <div className="mt-4 space-y-2 border-t border-line pt-3">
        <TestResult c={d} />
        <p className="text-xs text-fg-muted">The test sends one short request to Claude with this key. {d.updatedBy ? `Last changed ${when(d.updatedAt!)} by ${d.updatedBy}.` : ''}</p>
      </div>
      <ErrorAlert title="Not saved" error={save.error} />
      <ErrorAlert title="Could not test" error={test.error} />
      <ErrorAlert title="Could not remove" error={remove.error} />
    </Card>
  );
}

const PORTS = { TLS: 465, STARTTLS: 587, NONE: 25 } as const;

function EmailCard({ orgId, d }: { orgId: string; d: Integrations['email'] }) {
  const s = d.settings;
  const [f, setF] = useState({
    host: s?.host ?? '',
    port: String(s?.port ?? 587),
    security: s?.security ?? ('STARTTLS' as EmailSettings['security']),
    username: s?.username ?? '',
    fromAddress: s?.fromAddress ?? '',
    fromName: s?.fromName ?? '',
    replyTo: s?.replyTo ?? '',
  });
  const [password, setPassword] = useState('');
  const [enabled, setEnabled] = useState(d.configured ? d.enabled : true);
  const [saved, setSaved] = useState(false);
  const { test, remove, set } = useCardActions(orgId, 'email');
  const save = useMutation({
    mutationFn: () =>
      api<Integrations>(`/v1/orgs/${orgId}/integrations/email`, {
        method: 'PUT',
        body: { host: f.host.trim(), port: Number(f.port), security: f.security, username: f.username.trim() || null, password: password || null, fromAddress: f.fromAddress.trim(), fromName: f.fromName.trim() || null, replyTo: f.replyTo.trim() || null, enabled },
      }),
    onSuccess: (r) => (set(r), setPassword(''), setSaved(true)),
  });
  const upd = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => (setF((x) => ({ ...x, [k]: e.target.value })), setSaved(false));
  return (
    <Card className="p-5" aria-label="Email (SMTP)" role="region">
      <CardHeader
        title="Email: your mail server (SMTP)"
        description="Used for payment reminders and automation emails. Any provider that offers SMTP works: Google Workspace, Microsoft 365, Zoho Mail, Amazon SES, SendGrid, Brevo and others."
        actions={<InUse source={d.inUse} what="mail server" />}
      />
      {d.inUse === 'SERVER' && !d.configured ? <p className="mb-3 text-sm text-fg-muted">The server has a mail server set up, sending as {d.fromInUse}. Add your own to send from your own domain.</p> : null}
      {d.secretUnreadable ? (
        <div className="mb-3">
          <Alert tone="warning" title="Enter the password again">The stored password was sealed with an encryption key this server no longer has. Enter it again and save.</Alert>
        </div>
      ) : null}
      <form
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <Field label="Mail server">{(p) => <Input {...p} value={f.host} onChange={upd('host')} placeholder="smtp.example.com" />}</Field>
        <Field label="Security">
          {(p) => (
            <Select
              {...p}
              value={f.security}
              onChange={(e) => {
                const v = e.target.value as EmailSettings['security'];
                setF((x) => ({ ...x, security: v, port: String(PORTS[v]) }));
                setSaved(false);
              }}
            >
              <option value="STARTTLS">STARTTLS (usually port 587)</option>
              <option value="TLS">TLS (usually port 465)</option>
              {d.allowPlain ? <option value="NONE">None (testing only)</option> : null}
            </Select>
          )}
        </Field>
        <Field label="Port">{(p) => <Input {...p} inputMode="numeric" value={f.port} onChange={upd('port')} />}</Field>
        <Field label="Username">{(p) => <Input {...p} autoComplete="off" value={f.username} onChange={upd('username')} placeholder="Often your email address" />}</Field>
        <Field label="Password" hint={d.secretHint && !d.secretUnreadable ? `A password ending ${d.secretHint} is stored. Leave empty to keep it.` : 'An app password if your provider uses them. Stored encrypted.'}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => (setPassword(e.target.value), setSaved(false))} />}
        </Field>
        <div />
        <Field label="Sender name">{(p) => <Input {...p} value={f.fromName} onChange={upd('fromName')} placeholder="Accounts team" />}</Field>
        <Field label="Sender email">{(p) => <Input {...p} type="email" value={f.fromAddress} onChange={upd('fromAddress')} placeholder="accounts@yourcompany.com" />}</Field>
        <Field label="Reply-to (optional)">{(p) => <Input {...p} type="email" value={f.replyTo} onChange={upd('replyTo')} />}</Field>
        <label className="flex items-center gap-2 text-sm md:col-span-3">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Send this organisation&apos;s email through this server
        </label>
        <div className="flex flex-wrap items-center gap-2 md:col-span-3">
          <Button type="submit" loading={save.isPending}>Save</Button>
          {d.configured ? <Button type="button" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>Send a test email</Button> : null}
          {d.configured ? <Button type="button" variant="ghost" onClick={() => confirm('Remove this mail server? Emails stop unless the server has one of its own.') && remove.mutate()}>Remove</Button> : null}
          {saved ? <span role="status" className="text-sm text-positive">Saved</span> : null}
        </div>
      </form>
      <div className="mt-4 space-y-2 border-t border-line pt-3">
        <TestResult c={d} />
        <p className="text-xs text-fg-muted">The test connects, signs in and sends an email to you. {d.updatedBy ? `Last changed ${when(d.updatedAt!)} by ${d.updatedBy}.` : ''}</p>
      </div>
      <ErrorAlert title="Not saved" error={save.error} />
      <ErrorAlert title="Could not test" error={test.error} />
      <ErrorAlert title="Could not remove" error={remove.error} />
    </Card>
  );
}

/** Settings → Integrations: outside services an owner or admin connects in the app, with no server changes. */
export default function IntegrationsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['integrations', orgId], queryFn: () => api<Integrations>(`/v1/orgs/${orgId}/integrations`), enabled: !!org && can(org.role, 'org.manage') });
  if (!org) return null;
  if (!can(org.role, 'org.manage')) {
    return (
      <>
        <PageHeader title="Integrations" />
        <Alert tone="warning" title="Owners and admins only">Ask an owner or admin of this organisation to set up integrations.</Alert>
      </>
    );
  }
  const d = q.data;
  return (
    <>
      <PageHeader title="Integrations" description="Connect outside services here: no server settings or restarts needed. Keys and passwords are stored encrypted, are never shown again, and each organisation has its own." />
      <ErrorAlert title="Could not load integrations" error={q.error} />
      {d ? (
        <div className="space-y-4">
          <AiCard key={`ai-${d.ai.updatedAt}`} orgId={orgId} d={d.ai} />
          <EmailCard key={`email-${d.email.updatedAt}`} orgId={orgId} d={d.email} />
          <ApiKeysCard orgId={orgId} />
          <CrmWebhooksCard orgId={orgId} />
          <Card className="p-5" role="region" aria-label="Other connections">
            <CardHeader title="Other connections" />
            <ul className="space-y-2 text-sm text-fg-muted">
              <li>
                <span className="font-medium text-fg">Automation webhooks</span> are set per automation, with their own signing secret: see <Link className="text-accent hover:underline" href={`/orgs/${orgId}/automations`}>Automations</Link>.
              </li>
              <li>
                <span className="font-medium text-fg">E-invoicing and e-way bills</span> work through files today: the app prepares the JSON to upload on the IRP and e-way bill portals and reads their responses back. A direct connection through a GSP is not built yet; it will be added here when it is.
              </li>
            </ul>
          </Card>
        </div>
      ) : null}
    </>
  );
}
