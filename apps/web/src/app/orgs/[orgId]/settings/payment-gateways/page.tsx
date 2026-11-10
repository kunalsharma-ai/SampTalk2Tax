'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { OrgGateway, OrgGateways } from '@/lib/payment-links';
import { can } from '@/lib/types';

const HELP: Record<OrgGateway['provider'], { where: string; secret: string; webhook: string; about: string }> = {
  RAZORPAY: { where: 'Razorpay Dashboard → Account & Settings → API Keys, and Webhooks', secret: 'Key secret', webhook: 'Webhook secret', about: 'Cards, UPI, net banking and wallets in India; international cards when your Razorpay account allows them.' },
  STRIPE: { where: 'Stripe Dashboard → Developers → API keys, and Webhooks (add an endpoint)', secret: 'Secret key (sk_…)', webhook: 'Webhook signing secret (whsec_…)', about: 'Cards and wallets worldwide.' },
};

function GatewayCard({ orgId, g, d, onSaved }: { orgId: string; g: OrgGateway; d: OrgGateways; onSaved: () => Promise<void> }) {
  const init = () => ({ enabled: g.configured ? g.enabled : true, mode: g.mode, currencies: g.currencies, keyId: g.keyId ?? '', depositAccountId: g.depositAccount?.id ?? '', secret: '', webhookSecret: '' });
  const [form, setForm] = useState(init);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setForm(init()), [g.updatedAt]);
  const path = `/v1/orgs/${orgId}/settings/payment-gateways/${g.provider.toLowerCase()}`;
  const save = useMutation({
    mutationFn: () => api(path, { method: 'PUT', body: { enabled: form.enabled, mode: form.mode, currencies: form.currencies, keyId: g.provider === 'RAZORPAY' ? form.keyId : null, secret: form.secret || null, webhookSecret: form.webhookSecret || null, depositAccountId: form.depositAccountId || null } }),
    onSuccess: onSaved,
  });
  const test = useMutation({ mutationFn: () => api<{ ok: boolean; message: string }>(`${path}/test`, { method: 'POST' }), onSuccess: onSaved });
  const remove = useMutation({ mutationFn: () => api(path, { method: 'DELETE' }), onSuccess: onSaved });
  const toggle = (c: string) => setForm((f) => ({ ...f, currencies: f.currencies.includes(c) ? f.currencies.filter((x) => x !== c) : [...f.currencies, c] }));
  const h = HELP[g.provider];
  return (
    <Card aria-label={g.name} role="region">
      <CardHeader
        title={g.name}
        description={h.about}
        actions={<div className="flex gap-2">{g.enabled ? <Badge tone="positive">Taking payments</Badge> : g.configured ? <Badge tone="neutral">Off</Badge> : <Badge tone="neutral">Not set up</Badge>}{g.configured ? <Badge tone={g.mode === 'LIVE' ? 'warning' : 'violet'}>{g.mode === 'LIVE' ? 'Live' : 'Test mode'}</Badge> : null}</div>}
      />
      <form className="grid gap-4 px-5 pb-5 pt-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="text-sm text-fg-muted sm:col-span-2">Use your own {g.name} account. Find the keys in {h.where}. They are encrypted before they are stored and never shown again.</p>
        {g.needsReentry ? <div className="sm:col-span-2"><Alert tone="warning" title="Enter the keys again">The stored keys cannot be read because the server’s encryption key changed.</Alert></div> : null}
        <Field label="Mode">{(p) => <Select {...p} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'TEST' | 'LIVE' })}><option value="TEST">Test (no real money)</option><option value="LIVE">Live</option></Select>}</Field>
        <fieldset className="text-sm">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Takes payments in</legend>
          {d.currencies.map((c) => (
            <label key={c} className="mr-4 inline-flex items-center gap-2"><input type="checkbox" checked={form.currencies.includes(c)} onChange={() => toggle(c)} /> {c}</label>
          ))}
        </fieldset>
        {g.provider === 'RAZORPAY' ? <Field label="Key id (rzp_…)">{(p) => <Input {...p} value={form.keyId} autoComplete="off" onChange={(e) => setForm({ ...form, keyId: e.target.value })} />}</Field> : null}
        <Field label={h.secret} hint={g.secretHint ? `Stored: ${g.secretHint}. Leave empty to keep it.` : undefined}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />}</Field>
        <Field label={h.webhook} hint={g.webhookHint ? `Stored: ${g.webhookHint}. Leave empty to keep it.` : undefined}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={form.webhookSecret} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} />}</Field>
        <Field label="Paid out to" hint="The bank account the gateway settles into. Receipts from payment links are recorded here.">
          {(p) => (
            <Select {...p} value={form.depositAccountId} onChange={(e) => setForm({ ...form, depositAccountId: e.target.value })}>
              <option value="">Choose a bank account…</option>
              {d.depositAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </Select>
          )}
        </Field>
        <div className="text-sm sm:col-span-2">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Webhook address to enter at {g.name}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2"><code className="break-all rounded bg-surface-raised px-2 py-1 text-xs" data-testid={`webhook-url-${g.provider}`}>{g.webhookUrl}</code><Button type="button" size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(g.webhookUrl)}>Copy</Button></p>
          <p className="mt-1 text-xs text-fg-faint">Events: {g.webhookEvents.join(', ')}</p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Send payment links through {g.name}</label>
        {g.lastTest ? <p className={`text-sm sm:col-span-2 ${g.lastTest.ok ? 'text-positive' : 'text-negative'}`} role="status">Checked {dateTime(g.lastTest.at)}: {g.lastTest.message}</p> : null}
        <div className="sm:col-span-2"><ErrorAlert title="Not saved" error={save.error ?? test.error ?? remove.error} /></div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" loading={save.isPending}>Save</Button>
          {g.configured ? <Button type="button" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>Test connection</Button> : null}
          {g.configured ? <Button type="button" variant="ghost" loading={remove.isPending} onClick={() => window.confirm(`Remove ${g.name} and its keys?`) && remove.mutate()}>Remove</Button> : null}
          {save.isSuccess ? <span role="status" className="text-sm text-positive">Saved</span> : null}
        </div>
      </form>
    </Card>
  );
}

/** Settings → Payment gateways: the organisation's own Razorpay and Stripe accounts for payment links on invoices. */
export default function PaymentGatewaysPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const allowed = !!org && can(org.role, 'org.manage');
  const q = useQuery({ queryKey: ['payment-gateways', orgId], queryFn: () => api<OrgGateways>(`/v1/orgs/${orgId}/settings/payment-gateways`), enabled: allowed });
  if (!org) return null;
  if (!allowed) {
    return (
      <>
        <PageHeader title="Payment gateways" />
        <Alert tone="warning" title="Owners and admins only">Ask an owner or admin of this organisation to set up payment gateways.</Alert>
      </>
    );
  }
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['payment-gateways', orgId] });
    await qc.invalidateQueries({ queryKey: ['payment-links', orgId] });
  };
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Payment gateways"
        description="Connect your own Razorpay or Stripe account so customers can pay invoices online through a payment link. A payment counts only when the gateway confirms it with a signed webhook, or when you check the link; the receipt is then recorded into the bank account you choose."
      />
      <ErrorAlert title="Could not load payment gateways" error={q.error} />
      {d ? (
        <div className="grid gap-6">
          {!d.depositAccounts.length ? <Alert tone="warning" title="Add a bank account first">Payment link receipts go into a bank account. Add one in the chart of accounts.</Alert> : null}
          <div className="grid gap-6 xl:grid-cols-2">
            {d.gateways.map((g) => <GatewayCard key={g.provider} orgId={orgId} g={g} d={d} onSaved={refresh} />)}
          </div>
          <Card role="region" aria-label="Recent notices">
            <CardHeader title="Recent notices" description="The last notices your gateways sent, whether their signature was valid and what was done. A notice with a bad signature is recorded and ignored." />
            {d.notices.length ? (
              <Table>
                <thead><tr><Th>Received</Th><Th>Gateway</Th><Th>Event</Th><Th>Signature</Th><Th>Outcome</Th></tr></thead>
                <tbody>
                  {d.notices.map((n, i) => (
                    <Tr key={i}>
                      <Td className="text-fg-muted">{dateTime(n.receivedAt)}</Td>
                      <Td>{n.provider === 'STRIPE' ? 'Stripe' : 'Razorpay'}</Td>
                      <Td className="num text-xs">{n.type || '—'}</Td>
                      <Td>{n.signatureOk ? <Badge tone="positive">Valid</Badge> : <Badge tone="negative">Refused</Badge>}</Td>
                      <Td className="text-sm">{n.outcome}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : <p className="px-5 pb-5 text-sm text-fg-muted">No notices yet. They arrive when a customer pays a link.</p>}
          </Card>
          <p className="text-sm text-fg-muted">Links made so far are listed under <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/payment-links`}>Payment links</Link>.</p>
        </div>
      ) : null}
    </>
  );
}
