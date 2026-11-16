'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { checkGstin, placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useAccounts, useGstRegistration, useOrg } from '@/lib/org';
import { can, type GstRegistration } from '@/lib/types';

const HEADS = [
  { key: 'outputCgst', label: 'Output CGST', type: 'LIABILITY', field: 'outputCgstAccountId' },
  { key: 'outputSgst', label: 'Output SGST/UTGST', type: 'LIABILITY', field: 'outputSgstAccountId' },
  { key: 'outputIgst', label: 'Output IGST', type: 'LIABILITY', field: 'outputIgstAccountId' },
  { key: 'inputCgst', label: 'Input CGST', type: 'ASSET', field: 'inputCgstAccountId' },
  { key: 'inputSgst', label: 'Input SGST/UTGST', type: 'ASSET', field: 'inputSgstAccountId' },
  { key: 'inputIgst', label: 'Input IGST', type: 'ASSET', field: 'inputIgstAccountId' },
] as const;

interface Draft {
  gstin: string;
  legalName: string;
  effectiveFrom: string;
  chooseAccounts: boolean;
  accounts: Record<(typeof HEADS)[number]['field'], string>;
}

export default function GstSettingsPage() {
  const { org, orgId } = useOrg();
  const reg = useGstRegistration();
  const accounts = useAccounts();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({
    mutationFn: (d: Draft) =>
      api<GstRegistration>(`/v1/orgs/${orgId}/gst/registration`, {
        method: 'PUT',
        body: { gstin: d.gstin, legalName: d.legalName || null, effectiveFrom: d.effectiveFrom, accounts: d.chooseAccounts ? d.accounts : undefined },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['gst-registration', orgId] });
      await qc.invalidateQueries({ queryKey: ['accounts', orgId] });
      setDraft(null);
    },
  });
  if (!org) return null;
  const canManage = can(org.role, 'accounts.manage');
  const r = reg.data;
  const india = org.countryCode === 'IN' && org.functionalCurrency === 'INR';
  const check = draft?.gstin.trim() ? checkGstin(draft.gstin) : null;
  const control = new Set([org.arAccountId, org.apAccountId, org.claimsAccountId]);
  const usable = (type: string) => (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && !control.has(a.id) && a.type === type);
  const startEdit = () => {
    save.reset();
    setDraft(
      r?.registered
        ? { gstin: r.gstin, legalName: r.legalName ?? '', effectiveFrom: r.effectiveFrom, chooseAccounts: true, accounts: Object.fromEntries(HEADS.map((h) => [h.field, r.accounts[h.key].id])) as Draft['accounts'] }
        : { gstin: '', legalName: org.legalName ?? '', effectiveFrom: `${today().slice(0, 8)}01`, chooseAccounts: false, accounts: Object.fromEntries(HEADS.map((h) => [h.field, ''])) as Draft['accounts'] },
    );
  };
  const locked = r?.registered && !!r.firstDocumentDate;

  return (
    <>
      <PageHeader
        title="GST settings"
        description="Your GST registration decides how GST rates work: CGST and SGST/UTGST inside your state, IGST across states and on exports. Talk2Tax prepares return summaries; it does not file returns or connect to the GST portal."
        actions={canManage && india && r && !draft ? <Button onClick={startEdit}>{r.registered ? 'Edit registration' : 'Set up GST'}</Button> : null}
      />
      {!india ? <Alert tone="warning" title="GST is for organisations in India">This organisation is in {org.countryCode} with books in {org.functionalCurrency}. India GST needs an Indian organisation that keeps its books in INR.</Alert> : null}
      {reg.error ? <Alert title="Could not load">{(reg.error as Error).message}</Alert> : null}

      {r && !r.registered && !draft && india ? (
        <Card className="p-6">
          <h2 className="text-base font-semibold">Not registered yet</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Add your GSTIN to charge GST on invoices and claim input tax on bills. Talk2Tax creates six accounts for output and input CGST, SGST/UTGST and IGST unless you pick your own.
            From the effective date, every invoice and bill line needs a GST rate (nil-rated, exempt and non-GST rates cover lines without tax) and an HSN or SAC code.
          </p>
        </Card>
      ) : null}

      {r?.registered && !draft ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
          <Card>
            <CardHeader title="Registration" actions={<Badge tone="positive">Active</Badge>} />
            <dl className="grid grid-cols-[9rem_1fr] gap-y-3 px-5 pb-5 text-sm">
              <dt className="text-fg-muted">GSTIN</dt>
              <dd className="num font-medium">{r.gstin}</dd>
              <dt className="text-fg-muted">Legal name</dt>
              <dd>{r.legalName ?? '—'}</dd>
              <dt className="text-fg-muted">State</dt>
              <dd>{r.stateCode} · {r.stateName}</dd>
              <dt className="text-fg-muted">GST applies from</dt>
              <dd>{date(r.effectiveFrom)}</dd>
              <dt className="text-fg-muted">First GST document</dt>
              <dd>{r.firstDocumentDate ? date(r.firstDocumentDate) : 'None yet'}</dd>
            </dl>
            {locked ? <p className="border-t border-line px-5 py-3 text-xs text-fg-muted">Documents already carry this GSTIN and post to these accounts, so they can no longer change.</p> : null}
          </Card>
          <Card>
            <CardHeader title="Where GST posts" description="Output tax on invoices is a liability; input tax on bills is an asset you set off against it." />
            <dl className="grid grid-cols-[11rem_1fr] gap-y-2 px-5 pb-5 text-sm">
              {HEADS.map((h) => (
                <div key={h.key} className="contents">
                  <dt className="text-fg-muted">{h.label}</dt>
                  <dd>
                    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/general-ledger?accountId=${r.accounts[h.key].id}`}>
                      <span className="num">{r.accounts[h.key].code}</span> · {r.accounts[h.key].name}
                    </Link>
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card className="lg:col-span-2 p-5 text-sm text-fg-muted">
            <p className="font-medium text-fg">Next steps</p>
            <ul className="mt-2 list-inside list-disc space-y-1">
              <li>Create GST rates under <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/tax-rates`}>Tax rates</Link>, including nil-rated, exempt and non-GST ones.</li>
              <li>Add GSTINs to <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers`}>customers</Link> and <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendors`}>vendors</Link>; the state comes from the GSTIN.</li>
              <li>Review each month in <Link className="text-accent hover:underline" href={`/orgs/${orgId}/tax/gst-returns`}>GST returns</Link>.</li>
            </ul>
          </Card>
        </div>
      ) : null}

      {draft ? (
        <Card>
          <CardHeader title={r?.registered ? 'Edit GST registration' : 'Set up GST'} />
          <form className="grid gap-4 px-5 pb-5 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            {save.error ? (
              <div className="sm:col-span-3">
                <Alert title="Could not save">{save.error instanceof ApiError ? [save.error.message, ...save.error.issues].join(' · ') : 'Try again.'}</Alert>
              </div>
            ) : null}
            <Field label="GSTIN" error={check && !check.valid ? check.issues[0] : undefined} hint={check?.valid ? `State ${check.stateCode} · ${placeOfSupplyName(check.stateCode!)}. Format and check character verified.` : '15 characters, e.g. 29ABCDE1234F1Z5'}>
              {(p) => <Input {...p} required disabled={!!locked} className="num uppercase" maxLength={15} value={draft.gstin} onChange={(e) => setDraft({ ...draft, gstin: e.target.value.toUpperCase() })} />}
            </Field>
            <Field label="Legal name">{(p) => <Input {...p} maxLength={200} value={draft.legalName} onChange={(e) => setDraft({ ...draft, legalName: e.target.value })} />}</Field>
            <Field label="GST applies from" hint="Documents dated on or after this use GST rates.">
              {(p) => <Input {...p} type="date" required max={r?.registered && r.firstDocumentDate ? r.firstDocumentDate : undefined} value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />}
            </Field>
            {!r?.registered ? (
              <fieldset className="flex flex-col gap-2 text-sm sm:col-span-3">
                <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">GST accounts</legend>
                <label className="flex items-center gap-2"><input type="radio" className="accent-[var(--t2t-accent)]" checked={!draft.chooseAccounts} onChange={() => setDraft({ ...draft, chooseAccounts: false })} /> Create the standard accounts (2310–2312 output, 1451–1453 input)</label>
                <label className="flex items-center gap-2"><input type="radio" className="accent-[var(--t2t-accent)]" checked={draft.chooseAccounts} onChange={() => setDraft({ ...draft, chooseAccounts: true })} /> Use accounts I already have</label>
              </fieldset>
            ) : null}
            {draft.chooseAccounts
              ? HEADS.map((h) => (
                  <Field key={h.key} label={h.label}>
                    {(p) => (
                      <Select {...p} required disabled={!!locked} value={draft.accounts[h.field]} onChange={(e) => setDraft({ ...draft, accounts: { ...draft.accounts, [h.field]: e.target.value } })}>
                        <option value="">{h.type === "ASSET" ? "Choose an asset account…" : "Choose a liability account…"}</option>
                        {usable(h.type).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                      </Select>
                    )}
                  </Field>
                ))
              : null}
            <div className="flex justify-end gap-2 sm:col-span-3">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button type="submit" loading={save.isPending} disabled={!check?.valid}>{r?.registered ? 'Save changes' : 'Register for GST'}</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </>
  );
}
