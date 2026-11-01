'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useAccounts, useOrg, usePayrollSettings } from '@/lib/org';
import { can, type PayrollSettings } from '@/lib/types';

const ACCOUNTS = [
  ['salaryExpense', 'Gross salaries (expense)', 'EXPENSE', '6100 Salaries and Wages'],
  ['employerContribution', 'Employer PF and ESI (expense)', 'EXPENSE', '6110 Employer PF and ESI'],
  ['netPay', 'Net salaries payable', 'LIABILITY', '2410 Salaries payable'],
  ['pfPayable', 'PF payable', 'LIABILITY', '2411 PF payable'],
  ['esiPayable', 'ESI payable', 'LIABILITY', '2412 ESI payable'],
  ['ptPayable', 'Professional tax payable', 'LIABILITY', '2413 Professional tax payable'],
  ['tdsPayable', 'TDS on salary payable', 'LIABILITY', '2414 TDS on salary payable'],
] as const;
type Key = (typeof ACCOUNTS)[number][0];

interface Rules {
  pfWageCeilings: { from: string; value: string; source: string }[];
  pfRates: Record<string, string>;
  esi: { ceiling: string; employee: string; employer: string; source: string };
  incomeTax: { taxYear: string; slabs: { upTo: string | null; rate: string }[]; standardDeduction: string; rebateIncomeLimit: string; rebateMax: string; cess: string; source: string };
}

export default function PayrollSettingsPage() {
  const { org, orgId } = useOrg();
  const settings = usePayrollSettings();
  const accounts = useAccounts();
  const rules = useQuery({ queryKey: ['payroll-rules'], queryFn: () => api<Rules>(`/v1/orgs/${orgId}/payroll/rules`), staleTime: Infinity });
  const qc = useQueryClient();
  const [form, setForm] = useState<{ pfEstablishmentCode: string; esiEmployerCode: string; ptRegistration: string } | null>(null);
  const [choose, setChoose] = useState(false);
  const [acc, setAcc] = useState<Record<Key, string>>({ salaryExpense: '', employerContribution: '', netPay: '', pfPayable: '', esiPayable: '', ptPayable: '', tdsPayable: '' });
  const save = useMutation({
    mutationFn: () =>
      api<PayrollSettings>(`/v1/orgs/${orgId}/payroll/settings`, {
        method: 'PUT',
        body: { ...form, accounts: choose ? Object.fromEntries(ACCOUNTS.map(([k]) => [`${k}AccountId`, acc[k]])) : undefined },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['payroll-settings', orgId] });
      await qc.invalidateQueries({ queryKey: ['accounts', orgId] });
      setForm(null);
    },
  });
  if (!org) return null;
  const canManage = can(org.role, 'payroll.manage');
  const india = org.countryCode === 'IN' && org.functionalCurrency === 'INR';
  const s = settings.data;
  const configured = s?.configured ? s : null;
  const fmt = (v: string) => money(v, 'INR').replace(/\.00$/, '');
  const options = (type: string) => (accounts.data ?? []).filter((a) => a.isPostable && a.isActive && a.type === type && ![org.arAccountId, org.apAccountId, org.claimsAccountId].includes(a.id));
  const edit = () => {
    save.reset();
    setForm({ pfEstablishmentCode: configured?.pfEstablishmentCode ?? '', esiEmployerCode: configured?.esiEmployerCode ?? '', ptRegistration: configured?.ptRegistration ?? '' });
    if (configured) setAcc(Object.fromEntries(ACCOUNTS.map(([k]) => [k, configured.accounts[k].id])) as Record<Key, string>);
    setChoose(false);
  };

  return (
    <>
      <PageHeader
        title="Payroll settings"
        description="Registrations printed on payslips, and the accounts a pay run posts to. Talk2Tax works out pay, PF, ESI, professional tax and TDS on salary and posts them; it does not file returns or ECRs."
        actions={canManage && india && s && !form ? <Button onClick={edit}>{configured ? 'Edit settings' : 'Set up payroll'}</Button> : null}
      />
      {!india ? <Alert tone="warning" title="Payroll is for organisations in India">This organisation is in {org.countryCode} with books in {org.functionalCurrency}.</Alert> : null}
      {s && !configured && !form && india ? (
        <Card className="p-6">
          <h2 className="text-base font-semibold">Not set up yet</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">Add your PF establishment code and ESI employer code if you have them. Talk2Tax uses 6100 Salaries and Wages and creates accounts for employer contributions, net salaries, PF, ESI, professional tax and TDS on salary, unless you pick your own.</p>
        </Card>
      ) : null}

      {form ? (
        <Card className="max-w-3xl p-5">
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="PF establishment code" hint="Optional.">{(p) => <Input {...p} className="num" value={form.pfEstablishmentCode} maxLength={40} onChange={(e) => setForm({ ...form, pfEstablishmentCode: e.target.value })} />}</Field>
              <Field label="ESI employer code" hint="Optional.">{(p) => <Input {...p} className="num" value={form.esiEmployerCode} maxLength={40} onChange={(e) => setForm({ ...form, esiEmployerCode: e.target.value })} />}</Field>
              <Field label="PT registration" hint="Optional.">{(p) => <Input {...p} className="num" value={form.ptRegistration} maxLength={40} onChange={(e) => setForm({ ...form, ptRegistration: e.target.value })} />}</Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={choose} onChange={(e) => setChoose(e.target.checked)} /> Choose the accounts myself</label>
            {choose ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {ACCOUNTS.map(([k, label, type]) => (
                  <Field key={k} label={label}>
                    {(p) => (
                      <Select {...p} value={acc[k]} onChange={(e) => setAcc({ ...acc, [k]: e.target.value })}>
                        <option value="">Choose…</option>
                        {options(type).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                      </Select>
                    )}
                  </Field>
                ))}
              </div>
            ) : <p className="text-xs text-fg-muted">{configured ? 'The current accounts stay.' : `Accounts used: ${ACCOUNTS.map(([, , , d]) => d).join(', ')}. Missing ones are created.`}</p>}
            {save.error ? <Alert title="Not saved">{save.error.message}{save.error instanceof ApiError && save.error.issues.length ? <ul className="mt-1 list-inside list-disc">{save.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit" loading={save.isPending} disabled={choose && ACCOUNTS.some(([k]) => !acc[k])}>Save settings</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {configured && !form ? (
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Employer" actions={<Badge tone="positive">Set up</Badge>} />
            <dl className="grid grid-cols-[12rem_1fr] gap-y-2 px-5 pb-5 text-sm">
              <dt className="text-fg-muted">PF establishment code</dt><dd className="num">{configured.pfEstablishmentCode ?? '—'}</dd>
              <dt className="text-fg-muted">ESI employer code</dt><dd className="num">{configured.esiEmployerCode ?? '—'}</dd>
              <dt className="text-fg-muted">PT registration</dt><dd className="num">{configured.ptRegistration ?? '—'}</dd>
              {ACCOUNTS.map(([k, label]) => (
                <div key={k} className="contents">
                  <dt className="text-fg-muted">{label}</dt>
                  <dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/general-ledger?accountId=${configured.accounts[k].id}`}><span className="num">{configured.accounts[k].code}</span> · {configured.accounts[k].name}</Link></dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      ) : null}

      {rules.data ? (
        <Card className="mt-6">
          <CardHeader title="Statutory rules in use" description="The figures every payslip is worked out with, and where they come from. They change by notification; Talk2Tax adds new ones with the date they apply from." />
          <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <thead><tr><Th>Rule</Th><Th>Value</Th><Th>Source</Th></tr></thead>
              <tbody>
                {rules.data.pfWageCeilings.map((c) => (
                  <tr key={c.from}><Td>PF and EPS wage ceiling from {date(c.from)}</Td><Td className="num whitespace-nowrap">{fmt(c.value)} a month</Td><Td className="text-xs text-fg-muted">{c.source}</Td></tr>
                ))}
                <tr><Td>PF contributions</Td><Td className="num text-sm">Employee {rules.data.pfRates.employee}%, employer {rules.data.pfRates.employer}% (EPS {rules.data.pfRates.eps}% of capped wages), EDLI {rules.data.pfRates.edli}%, admin {rules.data.pfRates.admin}%</Td><Td className="text-xs text-fg-muted">{rules.data.pfRates.source}</Td></tr>
                <tr><Td>ESI</Td><Td className="num text-sm">Covers wages up to {fmt(rules.data.esi.ceiling)}; employee {rules.data.esi.employee}%, employer {rules.data.esi.employer}%</Td><Td className="text-xs text-fg-muted">{rules.data.esi.source}</Td></tr>
                <tr><Td>Professional tax</Td><Td className="text-sm">Maharashtra: {fmt('175')} above {fmt('7500')}; {fmt('200')} above {fmt('10000')} ({fmt('300')} in February); women nil up to {fmt('25000')}</Td><Td className="text-xs text-fg-muted">Maharashtra State Tax on Professions Act 1975, Schedule I. Other states are not built yet.</Td></tr>
                <tr>
                  <Td>TDS on salary, {rules.data.incomeTax.taxYear}</Td>
                  <Td className="num text-sm">New regime: {rules.data.incomeTax.slabs.map((x) => `${x.rate}%${x.upTo ? ` to ${fmt(x.upTo)}` : ' above'}`).join(', ')}. Standard deduction {fmt(rules.data.incomeTax.standardDeduction)}; rebate up to {fmt(rules.data.incomeTax.rebateMax)} on income to {fmt(rules.data.incomeTax.rebateIncomeLimit)}; cess {rules.data.incomeTax.cess}%</Td>
                  <Td className="text-xs text-fg-muted">{rules.data.incomeTax.source}</Td>
                </tr>
              </tbody>
            </Table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
