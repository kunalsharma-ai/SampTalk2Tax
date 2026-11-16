'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { money } from '@/lib/format';
import { useEWayBillSettings, useGstRegistration, useOrg } from '@/lib/org';
import { can, type EWayBillSettings } from '@/lib/types';

interface Draft {
  threshold: string;
  intraStateThreshold: string;
  address1: string;
  address2: string;
  city: string;
  pincode: string;
  goodsUnit: string;
}
const PIN = /^[1-9][0-9]{5}$/;
const AMT = /^\d{0,15}(\.\d{0,2})?$/;

export default function EWayBillSettingsPage() {
  const { org, orgId } = useOrg();
  const settings = useEWayBillSettings();
  const reg = useGstRegistration();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({
    mutationFn: (d: Draft) =>
      api<EWayBillSettings>(`/v1/orgs/${orgId}/e-way-bills/settings`, {
        method: 'PUT',
        body: { threshold: d.threshold, intraStateThreshold: d.intraStateThreshold || null, address1: d.address1, address2: d.address2.trim() || null, city: d.city, pincode: d.pincode, goodsUnit: d.goodsUnit },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['ewaybill-settings', orgId] });
      await qc.invalidateQueries({ queryKey: ['ewaybill', orgId] });
      setDraft(null);
    },
  });
  if (!org) return null;
  const s = settings.data;
  const configured = s?.configured ? s : null;
  const canManage = can(org.role, 'accounts.manage');
  const registered = reg.data?.registered ? reg.data : null;
  const stateName = s?.stateCode ? placeOfSupplyName(s.stateCode) : null;
  const start = () => {
    save.reset();
    const sug = s && !s.configured ? s.suggested : null;
    setDraft(
      configured
        ? { threshold: configured.threshold.replace(/\.00$/, ''), intraStateThreshold: configured.intraStateThreshold?.replace(/\.00$/, '') ?? '', address1: configured.address1, address2: configured.address2 ?? '', city: configured.city, pincode: configured.pincode, goodsUnit: configured.goodsUnit }
        : { threshold: '50000', intraStateThreshold: '', address1: sug?.address1 ?? '', address2: sug?.address2 ?? '', city: sug?.city ?? '', pincode: sug?.pincode ?? '', goodsUnit: sug?.goodsUnit ?? 'NOS' },
    );
  };
  const valid = draft && draft.threshold && draft.address1.trim() && draft.city.trim() && PIN.test(draft.pincode) && /^[A-Z]{3}$/.test(draft.goodsUnit);

  return (
    <>
      <PageHeader
        title="E-way bill settings"
        description="An e-way bill is needed before goods worth more than the threshold move (CGST Rule 138). Talk2Tax works out which invoices need one, prepares the JSON for ewaybillgst.gov.in and records the e-way bill the portal generates. It does not connect to the portal itself."
        actions={canManage && registered && s && !draft ? <Button onClick={start}>{configured ? 'Edit settings' : 'Set up e-way bills'}</Button> : null}
      />
      {s && !s.gstRegistered ? (
        <Alert tone="warning" title="Register for GST first">
          E-way bills carry your GSTIN. <Link className="underline" href={`/orgs/${orgId}/settings/gst`}>Add the GST registration</Link>, then come back.
        </Alert>
      ) : null}
      {s && !configured && !draft && s.gstRegistered ? (
        <Card className="p-6">
          <h2 className="text-base font-semibold">Not set up yet</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Add the address goods are dispatched from and the value threshold: ₹50,000 under Rule 138(1). Some states set a higher threshold for movement within the state; enter yours if it applies.
          </p>
        </Card>
      ) : null}

      {draft ? (
        <Card className="max-w-3xl p-5">
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            <Field label="Threshold (₹)" hint="Consignment value (goods with GST) above which an e-way bill is needed.">
              {(p) => <Input {...p} inputMode="decimal" value={draft.threshold} onChange={(e) => AMT.test(e.target.value) && setDraft({ ...draft, threshold: e.target.value })} />}
            </Field>
            <Field label={`Within ${stateName ?? 'your state'} (₹, optional)`} hint="Only when your state notified its own threshold for movement within it.">
              {(p) => <Input {...p} inputMode="decimal" value={draft.intraStateThreshold} onChange={(e) => AMT.test(e.target.value) && setDraft({ ...draft, intraStateThreshold: e.target.value })} />}
            </Field>
            <Field label="Dispatch address line 1">{(p) => <Input {...p} maxLength={120} value={draft.address1} onChange={(e) => setDraft({ ...draft, address1: e.target.value })} />}</Field>
            <Field label="Dispatch address line 2">{(p) => <Input {...p} maxLength={120} value={draft.address2} onChange={(e) => setDraft({ ...draft, address2: e.target.value })} />}</Field>
            <Field label="City">{(p) => <Input {...p} maxLength={50} value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />}</Field>
            <Field label="PIN code" error={draft.pincode && !PIN.test(draft.pincode) ? 'Six digits, not starting with 0' : undefined}>
              {(p) => <Input {...p} className="num" inputMode="numeric" maxLength={6} value={draft.pincode} onChange={(e) => /^\d{0,6}$/.test(e.target.value) && setDraft({ ...draft, pincode: e.target.value })} />}
            </Field>
            <Field label="Unit for goods" hint="The GST unit quantity code on goods lines, such as NOS, KGS or PCS.">
              {(p) => <Input {...p} className="num uppercase" maxLength={3} value={draft.goodsUnit} onChange={(e) => setDraft({ ...draft, goodsUnit: e.target.value.toUpperCase() })} />}
            </Field>
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
          <CardHeader title="E-way bills" actions={<Badge tone="positive">Set up</Badge>} />
          <dl className="grid grid-cols-[12rem_1fr] gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">GSTIN</dt>
            <dd className="num font-medium">{registered?.gstin}</dd>
            <dt className="text-fg-muted">Threshold</dt>
            <dd>{money(configured.threshold, 'INR')}{configured.intraStateThreshold ? <span className="text-fg-muted"> · {money(configured.intraStateThreshold, 'INR')} within {stateName}</span> : null}</dd>
            <dt className="text-fg-muted">Dispatch from</dt>
            <dd>{[configured.address1, configured.address2, configured.city, configured.pincode].filter(Boolean).join(', ')}</dd>
            <dt className="text-fg-muted">Unit for goods</dt>
            <dd className="num">{configured.goodsUnit}</dd>
          </dl>
          <p className="border-t border-line px-5 py-3 text-sm text-fg-muted">
            Customers need an address, a city and a PIN code. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/tax/e-way-bills`}>Open the e-way bill register</Link>
          </p>
        </Card>
      ) : null}
    </>
  );
}
