'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tanIssue } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, money } from '@/lib/format';
import { thresholdText } from '@/lib/gst';
import { useAccounts, useOrg, useWithholdingSections, useWithholdingSettings } from '@/lib/org';
import { can, type WithholdingSection, type WithholdingSettings, type WithholdingTemplate } from '@/lib/types';

interface SectionDraft {
  kind: 'TDS' | 'TCS';
  code: string;
  name: string;
  rate: string;
  rateIndividualHuf: string;
  rateNoPan: string;
  singleThreshold: string;
  aggregateThreshold: string;
  thresholdWindow: 'TAX_YEAR' | 'MONTH';
  thresholdBasis: 'WHOLE' | 'EXCESS';
  validFrom: string;
  source: string;
}
const blankSection = (kind: 'TDS' | 'TCS'): SectionDraft => ({ kind, code: '', name: '', rate: '', rateIndividualHuf: '', rateNoPan: kind === 'TDS' ? '20' : '5', singleThreshold: '', aggregateThreshold: '', thresholdWindow: 'TAX_YEAR', thresholdBasis: 'WHOLE', validFrom: '2026-04-01', source: '' });
const PCT = /^\d{0,3}(\.\d{0,6})?$/;
const AMT = /^\d{0,15}(\.\d{0,2})?$/;

export default function WithholdingSettingsPage() {
  const { org, orgId } = useOrg();
  const settings = useWithholdingSettings();
  const sections = useWithholdingSections(true);
  const templates = useQuery({ queryKey: ['withholding-templates'], queryFn: () => api<WithholdingTemplate[]>(`/v1/orgs/${orgId}/withholding/templates`), staleTime: Infinity });
  const accounts = useAccounts();
  const qc = useQueryClient();
  const [tan, setTan] = useState<string | null>(null);
  const [chooseAccounts, setChooseAccounts] = useState(false);
  const [acc, setAcc] = useState({ tdsPayableAccountId: '', tcsPayableAccountId: '' });
  const [section, setSection] = useState<SectionDraft | null>(null);
  const fmt = (v: string) => money(v, 'INR').replace(/\.00$/, '');

  const saveSettings = useMutation({
    mutationFn: () => api<WithholdingSettings>(`/v1/orgs/${orgId}/withholding/settings`, { method: 'PUT', body: { tan, accounts: chooseAccounts ? acc : undefined } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['withholding-settings', orgId] });
      await qc.invalidateQueries({ queryKey: ['accounts', orgId] });
      setTan(null);
    },
  });
  const addSection = useMutation({
    mutationFn: (body: Record<string, string | null>) => api<WithholdingSection>(`/v1/orgs/${orgId}/withholding/sections`, { method: 'POST', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['withholding-sections', orgId] });
      setSection(null);
    },
  });
  const toggle = useMutation({
    mutationFn: (s: WithholdingSection) => api(`/v1/orgs/${orgId}/withholding/sections/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['withholding-sections', orgId] }),
  });

  if (!org) return null;
  const canManage = can(org.role, 'accounts.manage');
  const india = org.countryCode === 'IN' && org.functionalCurrency === 'INR';
  const s = settings.data;
  const configured = s?.configured ? s : null;
  const tanCheck = tan !== null && tan.trim() ? tanIssue(tan.trim().toUpperCase()) : null;
  const liabilities = (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && a.type === 'LIABILITY' && ![org.arAccountId, org.apAccountId, org.claimsAccountId].includes(a.id));
  const have = new Set((sections.data ?? []).map((x) => `${x.kind}:${x.code}`));
  const missing = (templates.data ?? []).filter((t) => !have.has(`${t.kind}:${t.code}`));

  return (
    <>
      <PageHeader
        title="TDS and TCS settings"
        description="Income tax deducted at source on bills (TDS) and collected at source on invoices (TCS). Talk2Tax works out the tax, posts it, tracks deposits and keeps the register. It does not file statements or connect to the income-tax portal."
        actions={canManage && india && s && tan === null ? <Button onClick={() => { saveSettings.reset(); setTan(configured?.tan ?? ''); setAcc({ tdsPayableAccountId: configured?.accounts.tdsPayable.id ?? '', tcsPayableAccountId: configured?.accounts.tcsPayable.id ?? '' }); setChooseAccounts(!!configured); }}>{configured ? 'Edit settings' : 'Set up TDS and TCS'}</Button> : null}
      />
      {!india ? <Alert tone="warning" title="TDS and TCS are for organisations in India">This organisation is in {org.countryCode} with books in {org.functionalCurrency}.</Alert> : null}

      {s && !configured && tan === null && india ? (
        <Card className="p-6">
          <h2 className="text-base font-semibold">Not set up yet</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Add your TAN (tax deduction and collection account number). Talk2Tax creates a TDS payable and a TCS payable account unless you pick your own. Then add the sections you deduct under, from the Income-tax Act 2025 templates or your own.
          </p>
        </Card>
      ) : null}

      {tan !== null ? (
        <Card className="max-w-2xl p-5">
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); saveSettings.mutate(); }}>
            <Field label="TAN" error={tanCheck ?? undefined} hint="Four letters, five digits and a letter, as on your TAN allotment letter.">
              {(p) => <Input {...p} value={tan} maxLength={10} className="num uppercase" onChange={(e) => setTan(e.target.value.toUpperCase())} />}
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={chooseAccounts} onChange={(e) => setChooseAccounts(e.target.checked)} /> Choose the payable accounts myself</label>
            {chooseAccounts ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {(['tdsPayableAccountId', 'tcsPayableAccountId'] as const).map((k) => (
                  <Field key={k} label={k === 'tdsPayableAccountId' ? 'TDS payable account' : 'TCS payable account'}>
                    {(p) => (
                      <Select {...p} value={acc[k]} onChange={(e) => setAcc({ ...acc, [k]: e.target.value })}>
                        <option value="">Choose…</option>
                        {liabilities.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                      </Select>
                    )}
                  </Field>
                ))}
              </div>
            ) : <p className="text-xs text-fg-muted">{configured ? 'The current accounts stay.' : 'Accounts 2320 TDS payable and 2321 TCS payable will be created under Liabilities.'}</p>}
            {saveSettings.error ? <Alert title="Not saved">{saveSettings.error.message}{saveSettings.error instanceof ApiError && saveSettings.error.issues.length ? <ul className="mt-1 list-inside list-disc">{saveSettings.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setTan(null)}>Cancel</Button>
              <Button type="submit" loading={saveSettings.isPending} disabled={!tan.trim() || !!tanCheck || (chooseAccounts && (!acc.tdsPayableAccountId || !acc.tcsPayableAccountId))}>Save settings</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {configured && tan === null ? (
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Deductor" actions={<Badge tone="positive">Set up</Badge>} />
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2 px-5 pb-5 text-sm">
              <dt className="text-fg-muted">TAN</dt>
              <dd className="num font-medium">{configured.tan}</dd>
              {(['tdsPayable', 'tcsPayable'] as const).map((k) => (
                <div key={k} className="contents">
                  <dt className="text-fg-muted">{k === 'tdsPayable' ? 'TDS posts to' : 'TCS posts to'}</dt>
                  <dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/general-ledger?accountId=${configured.accounts[k].id}`}><span className="num">{configured.accounts[k].code}</span> · {configured.accounts[k].name}</Link></dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <CardHeader
              title="Sections"
              description="Choose a section on a bill (TDS) or an invoice (TCS), or set a default on the vendor or customer. A section's rate and thresholds cannot change after it is created; add a new one when the law changes and deactivate the old one."
              actions={canManage ? (
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { addSection.reset(); setSection(blankSection('TDS')); }}>New TDS section</Button>
                  <Button variant="secondary" size="sm" onClick={() => { addSection.reset(); setSection(blankSection('TCS')); }}>New TCS section</Button>
                </div>
              ) : null}
            />
            <div className="overflow-x-auto">
              <Table className="min-w-[760px]">
                <thead>
                  <tr><Th>Section</Th><Th>Applies to</Th><Th numeric>Rate</Th><Th>Threshold</Th><Th>From</Th><Th /></tr>
                </thead>
                <tbody>
                  {(sections.data ?? []).map((x) => (
                    <tr key={x.id} className={x.isActive ? '' : 'opacity-60'}>
                      <Td><Badge tone={x.kind === 'TDS' ? 'accent' : 'violet'}>{x.kind}</Badge> <span className="num ml-1 font-medium">{x.code}</span></Td>
                      <Td>{x.name}{x.source ? <span className="block text-xs text-fg-faint">{x.source}</span> : null}</Td>
                      <Td numeric className="whitespace-nowrap">
                        {x.rate}%{x.rateIndividualHuf ? <span className="block text-xs text-fg-muted">{x.rateIndividualHuf}% individual/HUF</span> : null}
                        <span className="block text-xs text-fg-muted">{x.rateNoPan}% without PAN</span>
                      </Td>
                      <Td className="text-sm">{thresholdText(x, fmt)}</Td>
                      <Td className="whitespace-nowrap">{date(x.validFrom)}</Td>
                      <Td className="text-right">{canManage ? <Button size="sm" variant="ghost" onClick={() => toggle.mutate(x)}>{x.isActive ? 'Deactivate' : 'Activate'}</Button> : null}{!x.isActive ? <Badge>Inactive</Badge> : null}</Td>
                    </tr>
                  ))}
                  {sections.data?.length === 0 ? <tr><Td colSpan={6} className="py-6 text-center text-fg-muted">No sections yet. Add them from the templates below.</Td></tr> : null}
                </tbody>
              </Table>
            </div>
          </Card>

          {missing.length && canManage ? (
            <Card>
              <CardHeader title="Templates: Income-tax Act 2025, s.393(1)" description="Rates and thresholds from the table in s.393(1) (payments to residents, tax years from 1 April 2026), as published by the Income Tax Department. The no-PAN rate is a default to confirm against the Act. Check that each applies to you before adding it." />
              <ul className="divide-y divide-line">
                {missing.map((t) => (
                  <li key={t.code} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                    <div>
                      <span className="num font-medium">{t.code}</span> · {t.name}
                      <span className="block text-xs text-fg-muted">{t.rate}%{t.rateIndividualHuf ? ` (${t.rateIndividualHuf}% individual/HUF)` : ''}, {thresholdText(t, fmt)}</span>
                    </div>
                    <Button size="sm" variant="secondary" aria-label={`Add ${t.code}`} loading={addSection.isPending && (addSection.variables as { template?: string })?.template === t.code} onClick={() => addSection.mutate({ template: t.code })}>Add</Button>
                  </li>
                ))}
              </ul>
              {addSection.error && !section ? <div className="px-5 pb-4"><Alert title="Not added">{addSection.error.message}</Alert></div> : null}
            </Card>
          ) : null}
        </div>
      ) : null}

      <Dialog open={!!section} onOpenChange={(o) => !o && setSection(null)} title={`New ${section?.kind} section`} description="Enter the provision as the Act states it. This cannot be edited later.">
        {section ? (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); addSection.mutate({ ...section, rateIndividualHuf: section.rateIndividualHuf || null, singleThreshold: section.singleThreshold || null, aggregateThreshold: section.aggregateThreshold || null, source: section.source || null }); }}>
            <Field label="Section code">{(p) => <Input {...p} value={section.code} maxLength={40} placeholder={section.kind === 'TCS' ? 'e.g. 394-scrap' : 'e.g. 393(1)-6(i)'} onChange={(e) => setSection({ ...section, code: e.target.value })} />}</Field>
            <Field label="Description">{(p) => <Input {...p} value={section.name} maxLength={200} onChange={(e) => setSection({ ...section, name: e.target.value })} />}</Field>
            <Field label="Rate (%)">{(p) => <Input {...p} className="num" inputMode="decimal" value={section.rate} onChange={(e) => PCT.test(e.target.value) && setSection({ ...section, rate: e.target.value })} />}</Field>
            <Field label="Rate without PAN (%)" hint="The higher of this and the rate applies.">{(p) => <Input {...p} className="num" inputMode="decimal" value={section.rateNoPan} onChange={(e) => PCT.test(e.target.value) && setSection({ ...section, rateNoPan: e.target.value })} />}</Field>
            <Field label="Individual/HUF rate (%)" hint="Optional.">{(p) => <Input {...p} className="num" inputMode="decimal" value={section.rateIndividualHuf} onChange={(e) => PCT.test(e.target.value) && setSection({ ...section, rateIndividualHuf: e.target.value })} />}</Field>
            <Field label="Applies from">{(p) => <Input {...p} type="date" value={section.validFrom} onChange={(e) => setSection({ ...section, validFrom: e.target.value })} />}</Field>
            <Field label="Single-document threshold (₹)" hint="Optional.">{(p) => <Input {...p} className="num" inputMode="decimal" value={section.singleThreshold} disabled={section.thresholdBasis === 'EXCESS'} onChange={(e) => AMT.test(e.target.value) && setSection({ ...section, singleThreshold: e.target.value })} />}</Field>
            <Field label="Aggregate threshold (₹)" hint="Optional.">{(p) => <Input {...p} className="num" inputMode="decimal" value={section.aggregateThreshold} onChange={(e) => AMT.test(e.target.value) && setSection({ ...section, aggregateThreshold: e.target.value })} />}</Field>
            <Field label="Aggregate over">{(p) => <Select {...p} value={section.thresholdWindow} onChange={(e) => setSection({ ...section, thresholdWindow: e.target.value as SectionDraft['thresholdWindow'] })}><option value="TAX_YEAR">The tax year (April to March)</option><option value="MONTH">Each month</option></Select>}</Field>
            <Field label="Once over the threshold">{(p) => <Select {...p} value={section.thresholdBasis} onChange={(e) => setSection({ ...section, thresholdBasis: e.target.value as SectionDraft['thresholdBasis'], singleThreshold: e.target.value === 'EXCESS' ? '' : section.singleThreshold })}><option value="WHOLE">Tax the whole amount</option><option value="EXCESS">Tax only the excess</option></Select>}</Field>
            <div className="sm:col-span-2"><Field label="Source (optional)">{(p) => <Input {...p} value={section.source} maxLength={300} placeholder="Act, section and table entry" onChange={(e) => setSection({ ...section, source: e.target.value })} />}</Field></div>
            {addSection.error ? <div className="sm:col-span-2"><Alert title="Not saved">{addSection.error.message}{addSection.error instanceof ApiError && addSection.error.issues.length ? <ul className="mt-1 list-inside list-disc">{addSection.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert></div> : null}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" variant="ghost" onClick={() => setSection(null)}>Cancel</Button>
              <Button type="submit" loading={addSection.isPending} disabled={!section.code.trim() || !section.name.trim() || !section.rate || !section.rateNoPan}>Save section</Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
