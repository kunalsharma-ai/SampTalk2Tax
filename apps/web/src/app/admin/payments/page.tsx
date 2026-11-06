'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMeWithRole } from '@/lib/admin';

interface Gateway {
  provider: 'STRIPE' | 'RAZORPAY';
  name: string;
  configured: boolean;
  enabled: boolean;
  mode: 'TEST' | 'LIVE';
  currencies: string[];
  keyId: string | null;
  secretHint: string | null;
  webhookHint: string | null;
  needsReentry: boolean;
  lastTest: { at: string; ok: boolean; message: string } | null;
  webhookUrl: string;
  webhookEvents: string[];
}
interface Profile { legalName: string; address: string; countryCode: string; gstin: string | null; email: string | null; gstRate: string; sacCode: string; invoicePrefix: string }
interface Settings { gateways: Gateway[]; profile: (Profile & { stateCode: string | null; updatedAt: string }) | null }

const HELP: Record<Gateway['provider'], { where: string; secret: string; webhook: string }> = {
  RAZORPAY: { where: 'Razorpay Dashboard → Account & Settings → API Keys, and Webhooks', secret: 'Key secret', webhook: 'Webhook secret' },
  STRIPE: { where: 'Stripe Dashboard → Developers → API keys, and Webhooks (add an endpoint)', secret: 'Secret key (sk_…)', webhook: 'Webhook signing secret (whsec_…)' },
};

function GatewayCard({ g, manage, onSaved }: { g: Gateway; manage: boolean; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ enabled: g.enabled, mode: g.mode, currencies: g.currencies, keyId: g.keyId ?? '', secret: '', webhookSecret: '' });
  useEffect(() => setForm((f) => ({ ...f, enabled: g.enabled, mode: g.mode, currencies: g.currencies, keyId: g.keyId ?? '' })), [g.enabled, g.mode, g.currencies, g.keyId]);
  const save = useMutation({
    mutationFn: () => api(`/v1/admin/payments/gateways/${g.provider.toLowerCase()}`, { method: 'PUT', body: { enabled: form.enabled, mode: form.mode, currencies: form.currencies, keyId: g.provider === 'RAZORPAY' ? form.keyId : null, secret: form.secret || null, webhookSecret: form.webhookSecret || null } }),
    onSuccess: async () => { setForm((f) => ({ ...f, secret: '', webhookSecret: '' })); await onSaved(); },
  });
  const test = useMutation({ mutationFn: () => api<{ ok: boolean; message: string }>(`/v1/admin/payments/gateways/${g.provider.toLowerCase()}/test`, { method: 'POST' }), onSuccess: onSaved });
  const remove = useMutation({ mutationFn: () => api(`/v1/admin/payments/gateways/${g.provider.toLowerCase()}`, { method: 'DELETE' }), onSuccess: onSaved });
  const toggle = (c: string) => setForm((f) => ({ ...f, currencies: f.currencies.includes(c) ? f.currencies.filter((x) => x !== c) : [...f.currencies, c] }));
  const h = HELP[g.provider];
  return (
    <Card aria-label={g.name}>
      <CardHeader
        title={g.name}
        description={g.provider === 'RAZORPAY' ? 'Cards, UPI, net banking and wallets in India; international cards when enabled on your Razorpay account.' : 'Cards and wallets worldwide.'}
        actions={<div className="flex gap-2">{g.enabled ? <Badge tone="positive">Taking payments</Badge> : g.configured ? <Badge tone="neutral">Off</Badge> : <Badge tone="neutral">Not set up</Badge>}{g.configured ? <Badge tone={g.mode === 'LIVE' ? 'warning' : 'violet'}>{g.mode === 'LIVE' ? 'Live' : 'Test mode'}</Badge> : null}</div>}
      />
      <form className="grid gap-4 px-5 pb-5 pt-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="text-sm text-fg-muted sm:col-span-2">Find the keys in {h.where}. They are encrypted before they are stored and never shown again.</p>
        {g.needsReentry ? <div className="sm:col-span-2"><Alert tone="warning" title="Enter the keys again">The stored keys cannot be read because the server’s encryption key changed.</Alert></div> : null}
        <Field label="Mode">{(p) => <Select {...p} value={form.mode} disabled={!manage} onChange={(e) => setForm({ ...form, mode: e.target.value as 'TEST' | 'LIVE' })}><option value="TEST">Test (no real money)</option><option value="LIVE">Live</option></Select>}</Field>
        <fieldset className="text-sm">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Takes payments in</legend>
          {['INR', 'USD'].map((c) => (
            <label key={c} className="mr-4 inline-flex items-center gap-2"><input type="checkbox" checked={form.currencies.includes(c)} disabled={!manage} onChange={() => toggle(c)} /> {c}</label>
          ))}
        </fieldset>
        {g.provider === 'RAZORPAY' ? <Field label="Key id (rzp_…)">{(p) => <Input {...p} value={form.keyId} disabled={!manage} autoComplete="off" onChange={(e) => setForm({ ...form, keyId: e.target.value })} />}</Field> : null}
        <Field label={h.secret} hint={g.secretHint ? `Stored: ${g.secretHint}. Leave empty to keep it.` : undefined}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={form.secret} disabled={!manage} onChange={(e) => setForm({ ...form, secret: e.target.value })} />}</Field>
        <Field label={h.webhook} hint={g.webhookHint ? `Stored: ${g.webhookHint}. Leave empty to keep it.` : undefined}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={form.webhookSecret} disabled={!manage} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} />}</Field>
        <div className="text-sm sm:col-span-2">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Webhook address to enter at {g.name}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2"><code className="rounded bg-surface-raised px-2 py-1 text-xs" data-testid={`webhook-url-${g.provider}`}>{g.webhookUrl}</code><Button type="button" size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(g.webhookUrl)}>Copy</Button></p>
          <p className="mt-1 text-xs text-fg-faint">Events: {g.webhookEvents.join(', ')}</p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.enabled} disabled={!manage} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Take subscription payments through {g.name}</label>
        {g.lastTest ? <p className={`text-sm sm:col-span-2 ${g.lastTest.ok ? 'text-positive' : 'text-negative'}`} role="status">Checked {dateTime(g.lastTest.at)}: {g.lastTest.message}</p> : null}
        <div className="sm:col-span-2"><ErrorAlert title="Not saved" error={save.error ?? test.error ?? remove.error} /></div>
        {manage ? (
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" loading={save.isPending}>Save</Button>
            {g.configured ? <Button type="button" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>Test connection</Button> : null}
            {g.configured ? <Button type="button" variant="ghost" loading={remove.isPending} onClick={() => window.confirm(`Remove ${g.name} and its keys?`) && remove.mutate()}>Remove</Button> : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}

function ProfileCard({ profile, manage, onSaved }: { profile: Settings['profile']; manage: boolean; onSaved: () => Promise<void> }) {
  const blank: Profile = { legalName: '', address: '', countryCode: 'IN', gstin: '', email: '', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' };
  const [f, setF] = useState<Profile>(profile ? { ...profile, gstin: profile.gstin ?? '', email: profile.email ?? '' } : blank);
  const save = useMutation({ mutationFn: () => api('/v1/admin/payments/profile', { method: 'PUT', body: { legalName: f.legalName, address: f.address, countryCode: f.countryCode, gstin: f.gstin || null, email: f.email || null, gstRate: f.gstRate, sacCode: f.sacCode, invoicePrefix: f.invoicePrefix } }), onSuccess: onSaved });
  return (
    <Card aria-label="Seller details">
      <CardHeader title="Seller details" description="Printed on every subscription invoice. With a GSTIN, invoices to organisations in India carry GST (CGST and SGST in your state, IGST elsewhere); exports of the service are zero-rated." />
      <form className="grid gap-4 px-5 pb-5 pt-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Legal name">{(p) => <Input {...p} value={f.legalName} disabled={!manage} onChange={(e) => setF({ ...f, legalName: e.target.value })} />}</Field>
        <Field label="Billing email">{(p) => <Input {...p} type="email" value={f.email ?? ''} disabled={!manage} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <div className="sm:col-span-2"><Field label="Address">{(p) => <Textarea {...p} rows={2} value={f.address} disabled={!manage} onChange={(e) => setF({ ...f, address: e.target.value })} />}</Field></div>
        <Field label="Country">{(p) => <Input {...p} maxLength={2} className="uppercase" value={f.countryCode} disabled={!manage} onChange={(e) => setF({ ...f, countryCode: e.target.value.toUpperCase() })} />}</Field>
        <Field label="GSTIN (optional)" hint="The state code is taken from its first two digits">{(p) => <Input {...p} maxLength={15} className="uppercase" value={f.gstin ?? ''} disabled={!manage} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} />}</Field>
        <Field label="GST rate (%)">{(p) => <Input {...p} inputMode="decimal" value={f.gstRate} disabled={!manage} onChange={(e) => setF({ ...f, gstRate: e.target.value })} />}</Field>
        <Field label="SAC code">{(p) => <Input {...p} value={f.sacCode} disabled={!manage} onChange={(e) => setF({ ...f, sacCode: e.target.value })} />}</Field>
        <Field label="Invoice number prefix" hint="Numbers look like T2T/26-27/00001 (at most 16 characters)">{(p) => <Input {...p} maxLength={4} className="uppercase" value={f.invoicePrefix} disabled={!manage} onChange={(e) => setF({ ...f, invoicePrefix: e.target.value.toUpperCase() })} />}</Field>
        <div className="sm:col-span-2"><ErrorAlert title="Not saved" error={save.error} /></div>
        {manage ? <div className="sm:col-span-2"><Button type="submit" loading={save.isPending}>Save seller details</Button>{save.isSuccess ? <span role="status" className="ml-3 text-sm text-positive">Saved</span> : null}</div> : null}
      </form>
    </Card>
  );
}

/** Platform administration → Payments: the gateways that take subscription payments, and the seller details on invoices. */
export default function AdminPaymentsPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const q = useQuery({ queryKey: ['admin-payments'], queryFn: () => api<Settings>('/v1/admin/payments') });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-payments'] });
  return (
    <>
      <PageHeader
        title="Payments"
        description="How organisations pay for Talk2Tax. Each currency is paid through one gateway; customers pay on the gateway’s own page, and a payment counts only when the gateway confirms it with a signed webhook (or when Talk2Tax asks it)."
      />
      <ErrorAlert title="Could not load payment settings" error={q.error} />
      {q.data ? (
        <div className="grid gap-6">
          {!q.data.profile ? <Alert tone="warning" title="Add the seller details first">Invoices cannot be issued without the legal name and tax details printed on them.</Alert> : null}
          {!q.data.gateways.some((g) => g.enabled) ? <Alert tone="warning" title="No gateway is taking payments">Organisations can still request a plan; you activate it when payment arrives by transfer.</Alert> : null}
          <ProfileCard profile={q.data.profile} manage={manage} onSaved={refresh} />
          <div className="grid gap-6 xl:grid-cols-2">
            {q.data.gateways.map((g) => <GatewayCard key={g.provider} g={g} manage={manage} onSaved={refresh} />)}
          </div>
        </div>
      ) : null}
    </>
  );
}
