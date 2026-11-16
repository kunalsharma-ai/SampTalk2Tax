'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useEInvoiceSettings, useGstRegistration, useOrg } from '@/lib/org';
import { can, type EInvoiceSettings } from '@/lib/types';

interface Draft {
  applicableFrom: string;
  aatoTenCroreOrMore: boolean;
  tradeName: string;
  address1: string;
  address2: string;
  city: string;
  pincode: string;
  goodsUnit: string;
  irpPublicKey: string;
  keepKey: boolean;
}
const PIN = /^[1-9][0-9]{5}$/;

export default function EInvoiceSettingsPage() {
  const { org, orgId } = useOrg();
  const settings = useEInvoiceSettings();
  const reg = useGstRegistration();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({
    mutationFn: (d: Draft) =>
      api<EInvoiceSettings>(`/v1/orgs/${orgId}/e-invoicing/settings`, {
        method: 'PUT',
        body: {
          applicableFrom: d.applicableFrom,
          aatoTenCroreOrMore: d.aatoTenCroreOrMore,
          tradeName: d.tradeName.trim() || null,
          address1: d.address1,
          address2: d.address2.trim() || null,
          city: d.city,
          pincode: d.pincode,
          goodsUnit: d.goodsUnit,
          ...(d.keepKey ? {} : { irpPublicKey: d.irpPublicKey.trim() || null }),
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['einvoice-settings', orgId] });
      await qc.invalidateQueries({ queryKey: ['einvoice', orgId] });
      setDraft(null);
    },
  });
  if (!org) return null;
  const s = settings.data;
  const configured = s?.configured ? s : null;
  const canManage = can(org.role, 'accounts.manage');
  const registered = reg.data?.registered ? reg.data : null;
  const start = () => {
    save.reset();
    setDraft(
      configured
        ? { applicableFrom: configured.applicableFrom, aatoTenCroreOrMore: configured.aatoTenCroreOrMore, tradeName: configured.tradeName ?? '', address1: configured.address1, address2: configured.address2 ?? '', city: configured.city, pincode: configured.pincode, goodsUnit: configured.goodsUnit, irpPublicKey: '', keepKey: configured.irpPublicKeySet }
        : { applicableFrom: registered?.effectiveFrom ?? '', aatoTenCroreOrMore: false, tradeName: '', address1: '', address2: '', city: '', pincode: '', goodsUnit: 'NOS', irpPublicKey: '', keepKey: false },
    );
  };
  const valid = draft && draft.applicableFrom && draft.address1.trim() && draft.city.trim().length >= 3 && PIN.test(draft.pincode) && /^[A-Z]{3}$/.test(draft.goodsUnit);

  return (
    <>
      <PageHeader
        title="E-invoicing settings"
        description="E-invoicing reports each B2B invoice and credit note to the government's Invoice Registration Portal (IRP), which returns an IRN and a signed QR code. Talk2Tax prepares the JSON for the IRP and records what it returns. It does not connect to the IRP itself."
        actions={canManage && registered && s && !draft ? <Button onClick={start}>{configured ? 'Edit settings' : 'Set up e-invoicing'}</Button> : null}
      />
      {s && !s.gstRegistered ? (
        <Alert tone="warning" title="Register for GST first">
          E-invoices carry your GSTIN. <Link className="underline" href={`/orgs/${orgId}/settings/gst`}>Add the GST registration</Link>, then come back.
        </Alert>
      ) : null}
      {s && !configured && !draft && s.gstRegistered ? (
        <Card className="p-6">
          <h2 className="text-base font-semibold">Not set up yet</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            E-invoicing is compulsory once your aggregate turnover in any year from 2017-18 crossed ₹5 crore. Add the date it applies to you from and the address that appears as the seller on every e-invoice. Turn on the 30-day limit if your turnover is ₹10 crore or more: the IRP then refuses invoices older than 30 days.
          </p>
        </Card>
      ) : null}

      {draft ? (
        <Card className="max-w-3xl p-5">
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            <Field label="E-invoicing applies from" hint="Documents dated earlier are not e-invoiced.">
              {(p) => <Input {...p} type="date" value={draft.applicableFrom} onChange={(e) => setDraft({ ...draft, applicableFrom: e.target.value })} />}
            </Field>
            <Field label="Trade name" hint="Optional; printed next to the legal name.">
              {(p) => <Input {...p} maxLength={100} value={draft.tradeName} onChange={(e) => setDraft({ ...draft, tradeName: e.target.value })} />}
            </Field>
            <Field label="Address line 1">{(p) => <Input {...p} maxLength={100} value={draft.address1} onChange={(e) => setDraft({ ...draft, address1: e.target.value })} />}</Field>
            <Field label="Address line 2">{(p) => <Input {...p} maxLength={100} value={draft.address2} onChange={(e) => setDraft({ ...draft, address2: e.target.value })} />}</Field>
            <Field label="City">{(p) => <Input {...p} maxLength={50} value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />}</Field>
            <Field label="PIN code" error={draft.pincode && !PIN.test(draft.pincode) ? 'Six digits, not starting with 0' : undefined}>
              {(p) => <Input {...p} className="num" inputMode="numeric" maxLength={6} value={draft.pincode} onChange={(e) => /^\d{0,6}$/.test(e.target.value) && setDraft({ ...draft, pincode: e.target.value })} />}
            </Field>
            <Field label="Unit for goods" hint="The GST unit quantity code used on goods lines, such as NOS (numbers), KGS or PCS.">
              {(p) => <Input {...p} className="num uppercase" maxLength={3} value={draft.goodsUnit} onChange={(e) => setDraft({ ...draft, goodsUnit: e.target.value.toUpperCase() })} />}
            </Field>
            <label className="flex items-start gap-2 self-end pb-2 text-sm">
              <input type="checkbox" className="mt-0.5 accent-[var(--t2t-accent)]" checked={draft.aatoTenCroreOrMore} onChange={(e) => setDraft({ ...draft, aatoTenCroreOrMore: e.target.checked })} />
              <span>Turnover of ₹10 crore or more (the IRP accepts documents only within 30 days of their date)</span>
            </label>
            <div className="sm:col-span-2">
              {draft.keepKey ? (
                <p className="text-sm text-fg-muted">
                  An IRP public key is saved; signed QR codes are verified with it. <button type="button" className="text-accent underline" onClick={() => setDraft({ ...draft, keepKey: false })}>Replace or remove it</button>
                </p>
              ) : (
                <Field label="IRP public key (optional)" hint="The RSA public key the IRP signs with, in PEM format, from the e-invoice portal's API section. With it, every imported QR code is checked against the signature; without it, imports are marked 'signature not verified'.">
                  {(p) => <Textarea {...p} rows={4} className="num text-xs" placeholder="-----BEGIN PUBLIC KEY-----" value={draft.irpPublicKey} onChange={(e) => setDraft({ ...draft, irpPublicKey: e.target.value })} />}
                </Field>
              )}
            </div>
            {save.error ? <div className="sm:col-span-2"><Alert title="Not saved">{save.error instanceof ApiError ? [save.error.message, ...save.error.issues].join(' · ') : 'Try again.'}</Alert></div> : null}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button type="submit" loading={save.isPending} disabled={!valid}>Save settings</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {configured && !draft ? (
        <Card className="max-w-3xl">
          <CardHeader title="Seller details" actions={<Badge tone="positive">Set up</Badge>} />
          <dl className="grid grid-cols-[12rem_1fr] gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">GSTIN</dt>
            <dd className="num font-medium">{registered?.gstin}</dd>
            <dt className="text-fg-muted">Legal name</dt>
            <dd>{registered?.legalName ?? org.legalName ?? org.name}{configured.tradeName ? <span className="text-fg-muted"> · trading as {configured.tradeName}</span> : null}</dd>
            <dt className="text-fg-muted">Address</dt>
            <dd>{[configured.address1, configured.address2, configured.city, configured.pincode].filter(Boolean).join(', ')}</dd>
            <dt className="text-fg-muted">Applies from</dt>
            <dd>{date(configured.applicableFrom)}</dd>
            <dt className="text-fg-muted">30-day limit</dt>
            <dd>{configured.aatoTenCroreOrMore ? 'Applies (turnover ₹10 crore or more)' : 'Does not apply'}</dd>
            <dt className="text-fg-muted">Unit for goods</dt>
            <dd className="num">{configured.goodsUnit}</dd>
            <dt className="text-fg-muted">Signature check</dt>
            <dd>{configured.irpPublicKeySet ? <Badge tone="positive">IRP key saved</Badge> : <Badge>No IRP key; signatures not verified</Badge>}</dd>
          </dl>
          <p className="border-t border-line px-5 py-3 text-sm text-fg-muted">
            Customers need a GSTIN, an address, a city and a PIN code. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/tax/e-invoices`}>Open the e-invoice register</Link>
          </p>
        </Card>
      ) : null}
    </>
  );
}
