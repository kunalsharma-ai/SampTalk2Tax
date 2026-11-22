'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money as fmt } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Input_ {
  regime: string | null;
  revenueChange: string;
  revenueGstRate: string;
  expenseChange: string;
  expenseGstRate: string;
  extraDepreciation: string;
  disallowed: string;
}
interface Result {
  regime: string;
  regimeLabel: string;
  bookProfit: string;
  taxableIncome: string;
  tax: { tax: string; surchargeRate: string; surcharge: string; marginalRelief: string; cess: string; total: string };
  taxChange: string;
  netPayable: string;
  profitAfterTax: string;
  effectiveRate: string | null;
  gst: { output: string; input: string; net: string };
  cashEffect: string;
  notes: string[];
}
interface Baseline { taxYear: string; from: string; to: string; asOf: string; method: 'ANNUALISE' | 'ESTIMATE'; regime: string; regimeLabel: string; income: string; tax: string; credits: string; netLiability: string }
interface Data {
  currency: string;
  baseline: Baseline;
  regimes: { key: string; label: string }[];
  gstRates: string[];
  comparison: { regime: string; label: string; total: string; current: boolean; saving: string }[];
  scenarios: { id: string; name: string; note: string | null; createdBy: string | null; createdAt: string; input: Input_; result: Result }[];
}

const blank = { regime: '', revenueChange: '', revenueGstRate: '18', expenseChange: '', expenseGstRate: '18', extraDepreciation: '', disallowed: '' };
const signedTone = (x: string, upIsBad = true) => (/^-/.test(x) ? (upIsBad ? 'positive' : 'negative') : /[1-9]/.test(x) ? (upIsBad ? 'negative' : 'positive') : 'neutral');

/** Tax scenario simulations (TAX-049): what-if changes against the year's advance tax estimate. */
export default function TaxScenariosPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const key = ['tax-scenarios', orgId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Data>(`/v1/orgs/${orgId}/tax/scenarios`) });
  const [f, setF] = useState(blank);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const body = () => ({
    regime: f.regime || null,
    revenueChange: f.revenueChange.trim() || '0',
    revenueGstRate: f.revenueGstRate,
    expenseChange: f.expenseChange.trim() || '0',
    expenseGstRate: f.expenseGstRate,
    extraDepreciation: f.extraDepreciation.trim() || '0',
    disallowed: f.disallowed.trim() || '0',
  });
  const sim = useMutation({ mutationFn: () => api<{ result: Result }>(`/v1/orgs/${orgId}/tax/scenarios/simulate`, { method: 'POST', body: body() }) });
  const save = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/tax/scenarios`, { method: 'POST', body: { ...body(), name, note: note || null } }),
    onSuccess: () => {
      setName('');
      setNote('');
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/v1/orgs/${orgId}/tax/scenarios/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  if (!org) return null;
  const d = q.data;
  const manage = can(org.role, 'accounts.manage');
  const r = sim.data?.result;
  const set = (k: keyof typeof blank, v: string) => {
    setF({ ...f, [k]: v });
    sim.reset();
  };
  const cur = d?.currency ?? org.functionalCurrency;
  const money = (x: string) => <Money value={x} currency={cur} />;
  const m = (x: string) => fmt(x, cur);
  return (
    <>
      <PageHeader
        title="Tax scenarios"
        description="What a change to the year's business would do to income tax and GST: more or fewer sales, more or fewer expenses, new depreciation, expenses that are not deductible and another tax regime, each worked out against the year's advance tax estimate. Nothing here changes the books."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/tax/advance-tax`}>Advance tax estimate</Link>}
      />
      <ErrorAlert title="Could not load tax scenarios" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Taxable income estimate" value={money(d.baseline.income)} sub={`Tax year ${d.baseline.taxYear}, ${d.baseline.method === 'ESTIMATE' ? 'your estimate' : `books to ${date(d.baseline.asOf)} for a full year`}`} />
            <Stat label="Tax on the estimate" value={money(d.baseline.tax)} sub={d.baseline.regimeLabel} />
            <Stat label="Tax credits" value={money(d.baseline.credits)} sub="TDS and other credits" />
            <Stat label="Net tax payable" value={money(d.baseline.netLiability)} />
          </div>

          <Card className="mb-4">
            <CardHeader title="Regimes compared" description="The tax on the estimate under each regime open to this kind of business, lowest first. A lower rate may need conditions to be met." />
            <Table aria-label="Regimes compared">
              <thead><Tr><Th>Regime</Th><Th numeric>Tax</Th><Th numeric>Saving on the estimate</Th></Tr></thead>
              <tbody>
                {d.comparison.map((c) => (
                  <Tr key={c.regime}>
                    <Td>{c.label} {c.current ? <Badge tone="accent">Current</Badge> : null}</Td>
                    <Td numeric>{money(c.total)}</Td>
                    <Td numeric className={/^-/.test(c.saving) ? 'text-negative' : /[1-9]/.test(c.saving) ? 'text-positive' : ''}>{money(c.saving)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card className="mb-4">
            <CardHeader title="Try a scenario" description={`Changes on the estimate for the year, in ${d.currency} before GST. Use a minus sign for less.`} />
            <form
              className="p-4"
              onSubmit={(e) => {
                e.preventDefault();
                sim.mutate();
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Change in sales">{(p) => <Input {...p} inputMode="decimal" value={f.revenueChange} onChange={(e) => set('revenueChange', e.target.value)} />}</Field>
                <Field label="GST on sales">
                  {(p) => <Select {...p} value={f.revenueGstRate} onChange={(e) => set('revenueGstRate', e.target.value)}>{d.gstRates.map((g) => <option key={g} value={g}>{g}%</option>)}</Select>}
                </Field>
                <Field label="Change in expenses" hint="Deductible">{(p) => <Input {...p} inputMode="decimal" value={f.expenseChange} onChange={(e) => set('expenseChange', e.target.value)} />}</Field>
                <Field label="GST on expenses" hint="Claimed back as input credit">
                  {(p) => <Select {...p} value={f.expenseGstRate} onChange={(e) => set('expenseGstRate', e.target.value)}>{d.gstRates.map((g) => <option key={g} value={g}>{g}%</option>)}</Select>}
                </Field>
                <Field label="Extra depreciation" hint="On new assets; not cash">{(p) => <Input {...p} inputMode="decimal" value={f.extraDepreciation} onChange={(e) => set('extraDepreciation', e.target.value)} />}</Field>
                <Field label="Expenses not deductible" hint="Already in the books; added back">{(p) => <Input {...p} inputMode="decimal" value={f.disallowed} onChange={(e) => set('disallowed', e.target.value)} />}</Field>
                <Field label="Tax regime">
                  {(p) => (
                    <Select {...p} value={f.regime} onChange={(e) => set('regime', e.target.value)}>
                      <option value="">Same as the estimate</option>
                      {d.regimes.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                    </Select>
                  )}
                </Field>
                <div className="flex items-end"><Button type="submit" loading={sim.isPending}>Work it out</Button></div>
              </div>
            </form>
            <ErrorAlert title="Could not work out the scenario" error={sim.error} />
            {r ? (
              <section aria-label="Scenario result" className="border-t border-border p-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Stat label="Taxable income" value={money(r.taxableIncome)} sub={r.regimeLabel} />
                  <Stat label="Income tax" value={money(r.tax.total)} sub={`Tax ${m(r.tax.tax)}, surcharge ${m(r.tax.surcharge)}${/[1-9]/.test(r.tax.marginalRelief) ? ` less relief ${m(r.tax.marginalRelief)}` : ''}, cess ${m(r.tax.cess)}`} />
                  <Stat label="Change in tax" value={money(r.taxChange)} tone={signedTone(r.taxChange)} sub={`Net payable after credits ${m(r.netPayable)}`} />
                  <Stat label="Profit after tax" value={money(r.profitAfterTax)} sub={r.effectiveRate ? `Effective rate ${r.effectiveRate}%` : 'No profit'} />
                  <Stat label="GST on the change" value={money(r.gst.net)} sub={`Collected ${m(r.gst.output)}, input credit ${m(r.gst.input)}`} />
                  <Stat label="Cash effect" value={money(r.cashEffect)} tone={signedTone(r.cashEffect, false)} sub="Sales less expenses less the change in tax" />
                </div>
                {r.notes.length ? <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-fg-muted">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
                {manage ? (
                  <form
                    className="mt-4 grid gap-3 sm:grid-cols-[16rem_1fr_auto]"
                    onSubmit={(e) => {
                      e.preventDefault();
                      save.mutate();
                    }}
                  >
                    <Field label="Scenario name">{(p) => <Input {...p} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />}</Field>
                    <Field label="Scenario note" hint="Optional">{(p) => <Textarea {...p} rows={1} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}</Field>
                    <div className="flex items-end"><Button type="submit" variant="secondary" disabled={!name.trim()} loading={save.isPending}>Save scenario</Button></div>
                  </form>
                ) : null}
                <ErrorAlert title="Could not save the scenario" error={save.error} />
              </section>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Saved scenarios" description="Each worked out again against the current estimate, so they move when the estimate does." />
            <ErrorAlert title="Could not delete the scenario" error={del.error} />
            {d.scenarios.length ? (
              <Table aria-label="Saved scenarios">
                <thead>
                  <Tr><Th>Scenario</Th><Th>Regime</Th><Th numeric>Taxable income</Th><Th numeric>Income tax</Th><Th numeric>Change in tax</Th><Th numeric>Profit after tax</Th><Th numeric>GST on the change</Th><Th numeric>Cash effect</Th>{manage ? <Th /> : null}</Tr>
                </thead>
                <tbody>
                  {d.scenarios.map((s) => (
                    <Tr key={s.id}>
                      <Td>{s.name}<div className="text-xs text-fg-muted">{s.note ? `${s.note} · ` : ''}{s.createdBy ?? 'Unknown'}, {date(s.createdAt.slice(0, 10))}</div></Td>
                      <Td className="text-sm">{s.result.regimeLabel}</Td>
                      <Td numeric>{money(s.result.taxableIncome)}</Td>
                      <Td numeric>{money(s.result.tax.total)}</Td>
                      <Td numeric className={/^-/.test(s.result.taxChange) ? 'text-positive' : /[1-9]/.test(s.result.taxChange) ? 'text-negative' : ''}>{money(s.result.taxChange)}</Td>
                      <Td numeric>{money(s.result.profitAfterTax)}</Td>
                      <Td numeric>{money(s.result.gst.net)}</Td>
                      <Td numeric>{money(s.result.cashEffect)}</Td>
                      {manage ? <Td><Button variant="secondary" size="sm" aria-label={`Delete ${s.name}`} loading={del.isPending && del.variables === s.id} onClick={() => del.mutate(s.id)}>Delete</Button></Td> : null}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No saved scenarios">{manage ? 'Work out a scenario above and save it to compare it with others.' : 'Nobody has saved a scenario for this year yet.'}</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
