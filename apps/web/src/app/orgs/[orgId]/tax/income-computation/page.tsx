'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Adjustment = { label: string; section: string | null; kind: 'ADD' | 'DEDUCT'; amount: string };
type Input_ = { regime: string; taxDepreciation: string | null; broughtForwardLoss: string; adjustments: Adjustment[]; otherCredits: string };
interface Computation {
  taxYear: string;
  from: string;
  to: string;
  yearEnded: boolean;
  currency: string;
  status: 'DRAFT' | 'FINAL';
  saved: boolean;
  input: Input_;
  regimes: { key: string; label: string }[];
  regimeLabel: string;
  lines: { key: string; label: string; section: string | null; kind: 'START' | 'ADD' | 'DEDUCT'; amount: string }[];
  businessIncome: string;
  broughtForwardLoss: string;
  lossSetOff: string;
  totalIncome: string;
  roundedIncome: string;
  lossCarriedForward: string;
  taxInBooks: string;
  tax: { tax: string; surchargeRate: string; surcharge: string; marginalRelief: string; cess: string; total: string };
  credits: { tds: string; advanceTax: string; other: string; total: string };
  payable: string;
  refund: string;
  warnings: string[];
  sources: { cashPaymentDays: number; tdsAccount: { code: string; name: string } | null; advanceTaxAccount: { code: string; name: string } | null };
  updatedBy: string | null;
  finalisedBy: string | null;
  finalisedAt: string | null;
  changedSince: { then: string; now: string } | null;
}

const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
const yearsBack = (n: number) => {
  const t = new Date(Date.now() + 5.5 * 3_600_000); // not money
  const start = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
  return Array.from({ length: n }, (_, i) => `${start - i}-${String((start - i + 1) % 100).padStart(2, '0')}`); // not money
};

/** Income tax computation (TAX-019, TAX-020): total income and tax for a financial year from the books. */
export default function IncomeComputationPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const years = yearsBack(4);
  const [year, setYear] = useState(years[1]!);
  const key = ['income-computation', orgId, year];
  const q = useQuery({ queryKey: key, queryFn: () => api<Computation>(`/v1/orgs/${orgId}/tax/income-computation?year=${year}`) });
  const [draft, setDraft] = useState<Input_ | null>(null);
  const [confirming, setConfirming] = useState(false);
  const base = `/v1/orgs/${orgId}/tax/income-computation/${year}`;
  const save = useMutation({ mutationFn: (i: Input_) => api<Computation>(base, { method: 'PUT', body: i }), onSuccess: (r) => { setDraft(null); qc.setQueryData(key, r); } });
  const finalise = useMutation({ mutationFn: () => api<Computation>(`${base}/finalise`, { method: 'POST' }), onSuccess: (r) => { setConfirming(false); qc.setQueryData(key, r); } });
  if (!org) return null;
  const r = q.data?.taxYear === year ? q.data : undefined;
  const c = r?.currency ?? org.functionalCurrency;
  const final = r?.status === 'FINAL';
  const canManage = can(org.role, 'accounts.manage');
  const input = draft ?? r?.input;
  const set = (patch: Partial<Input_>) => input && setDraft({ ...input, ...patch });
  const valid = !!input && (input.taxDepreciation === null || input.taxDepreciation === '' || AMOUNT.test(input.taxDepreciation)) && AMOUNT.test(input.broughtForwardLoss) && AMOUNT.test(input.otherCredits) && input.adjustments.every((a) => a.label.trim() && AMOUNT.test(a.amount));
  const body = (i: Input_): Input_ => ({ ...i, taxDepreciation: i.taxDepreciation === '' ? null : i.taxDepreciation, adjustments: i.adjustments.map((a) => ({ ...a, section: a.section?.trim() || null })) });
  return (
    <>
      <PageHeader
        title="Income tax computation"
        description="The computation of total income and tax for a financial year, as prepared for the return of income: profit before tax from the books, adjusted under the Income-tax Act, with tax at the corporate rates less TDS and advance tax. It prepares figures for your tax professional to check; it files nothing."
        actions={
          <span className="flex items-center gap-2 print:hidden">
            <Button variant="ghost" size="sm" disabled={!r} onClick={() => window.print()}>Print</Button>
            {canManage && r && r.saved && !final && r.yearEnded ? <Button size="sm" onClick={() => setConfirming(true)}>Finalise computation</Button> : null}
          </span>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <Field label="Financial year">
          {(p) => (
            <Select {...p} className="w-40" value={year} onChange={(e) => { setYear(e.target.value); setDraft(null); }}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          )}
        </Field>
      </div>
      <ErrorAlert title="Could not load the computation" error={q.error} />
      {r && input ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {final ? <Badge tone="positive">Final</Badge> : r.yearEnded ? <Badge>Draft</Badge> : <Badge tone="warning">Year in progress</Badge>}
            <span>{date(r.from)} to {date(r.to)}. {r.regimeLabel}.</span>
            {final ? <span>Finalised by {r.finalisedBy} on {date(r.finalisedAt!.slice(0, 10))}; these are the figures as they stood then.</span> : <span>Figures are live from the books until the computation is finalised.</span>}
          </div>
          {r.changedSince ? (
            <div className="mb-4"><Alert tone="warning" title="The books changed after finalising">Profit before tax was {r.changedSince.then} in this computation and is {r.changedSince.now} in the books now.</Alert></div>
          ) : null}
          {r.warnings.map((w) => <div key={w} className="mb-4"><Alert tone="warning" title="Check before filing">{w}{w.startsWith('Choose') ? <> <Link className="underline" href={`/orgs/${orgId}/tax/advance-tax`}>Advance tax</Link></> : null}</Alert></div>)}

          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total income" value={<Money value={r.totalIncome} currency={c} />} sub={`Rounded to ${money(r.roundedIncome, c)} (section 288A)`} />
            <Stat label="Tax and cess" value={<Money value={r.tax.total} currency={c} />} sub={`Surcharge ${r.tax.surchargeRate}%`} />
            <Stat label="Tax already paid" value={<Money value={r.credits.total} currency={c} />} sub="TDS, advance tax and other" />
            {r.refund !== '0.00' ? <Stat label="Refund due" value={<Money value={r.refund} currency={c} />} tone="positive" /> : <Stat label="Self-assessment tax to pay" value={<Money value={r.payable} currency={c} />} tone={r.payable === '0.00' ? 'positive' : 'warning'} />}
          </div>

          <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
            <Card>
              <CardHeader title="Computation of total income" description="Profits and gains of business or profession, from the books. Income tax charged in the books is left out of the profit." />
              <Table aria-label="Computation of total income" className="[&_td]:align-top">
                <thead><Tr><Th>Item</Th><Th>Section</Th><Th numeric>Amount</Th></Tr></thead>
                <tbody>
                  {r.lines.map((l) => (
                    <Tr key={l.key}>
                      <Td>{l.kind === 'ADD' ? 'Add: ' : l.kind === 'DEDUCT' ? 'Less: ' : ''}{l.label}</Td>
                      <Td>{l.section ?? ''}</Td>
                      <Td numeric>{l.kind === 'DEDUCT' ? '(' : ''}<Money value={l.amount} currency={c} />{l.kind === 'DEDUCT' ? ')' : ''}</Td>
                    </Tr>
                  ))}
                  <Tr className="font-semibold"><Td>Income from business</Td><Td /><Td numeric><Money value={r.businessIncome} currency={c} /></Td></Tr>
                  {r.lossSetOff !== '0.00' ? <Tr><Td>Less: brought forward business loss set off</Td><Td>72</Td><Td numeric>(<Money value={r.lossSetOff} currency={c} />)</Td></Tr> : null}
                  <Tr className="font-semibold"><Td>Total income</Td><Td /><Td numeric><Money value={r.totalIncome} currency={c} /></Td></Tr>
                  {r.lossCarriedForward !== '0.00' ? <Tr><Td>Business loss carried forward</Td><Td>72</Td><Td numeric><Money value={r.lossCarriedForward} currency={c} /></Td></Tr> : null}
                </tbody>
              </Table>
              <p className="px-4 py-3 text-xs text-fg-muted">Income tax in the books: {money(r.taxInBooks, c)}. Cash payments over 10,000: {r.sources.cashPaymentDays} {r.sources.cashPaymentDays === 1 ? 'day' : 'days'} from the <Link className="underline" href={`/orgs/${orgId}/tax/tax-audit`}>tax audit</Link> working.</p>
            </Card>
            <Card>
              <CardHeader title="Tax on total income" description="At the chosen rates, with surcharge (and marginal relief) and 4% cess, less tax already paid. Interest under sections 234A to 234C is not worked out here." />
              <Table aria-label="Tax on total income">
                <tbody>
                  <Tr><Td>Tax on {money(r.roundedIncome, c)}</Td><Td numeric><Money value={r.tax.tax} currency={c} /></Td></Tr>
                  <Tr><Td>Surcharge at {r.tax.surchargeRate}%</Td><Td numeric><Money value={r.tax.surcharge} currency={c} /></Td></Tr>
                  {r.tax.marginalRelief !== '0.00' ? <Tr><Td>Less: marginal relief</Td><Td numeric>(<Money value={r.tax.marginalRelief} currency={c} />)</Td></Tr> : null}
                  <Tr><Td>Health and education cess</Td><Td numeric><Money value={r.tax.cess} currency={c} /></Td></Tr>
                  <Tr className="font-semibold"><Td>Tax and cess (rounded to 10)</Td><Td numeric><Money value={r.tax.total} currency={c} /></Td></Tr>
                  <Tr><Td>Less: TDS{r.sources.tdsAccount ? ` (${r.sources.tdsAccount.code})` : ''}</Td><Td numeric>(<Money value={r.credits.tds} currency={c} />)</Td></Tr>
                  <Tr><Td>Less: advance tax{r.sources.advanceTaxAccount ? ` (${r.sources.advanceTaxAccount.code})` : ''}</Td><Td numeric>(<Money value={r.credits.advanceTax} currency={c} />)</Td></Tr>
                  <Tr><Td>Less: other tax paid</Td><Td numeric>(<Money value={r.credits.other} currency={c} />)</Td></Tr>
                  <Tr className="font-semibold"><Td>{r.refund !== '0.00' ? 'Refund due' : 'Self-assessment tax to pay'}</Td><Td numeric><Money value={r.refund !== '0.00' ? r.refund : r.payable} currency={c} /></Td></Tr>
                </tbody>
              </Table>
            </Card>
          </div>

          <Card className="mt-4 print:hidden">
            <CardHeader title="Preparer's inputs" description={final ? 'Frozen with the computation.' : r.updatedBy ? `Last saved by ${r.updatedBy}.` : 'What the books cannot tell: the tax regime, depreciation under the Act, losses brought forward and other adjustments with their sections.'} />
            <ErrorAlert title="Not saved" error={save.error} />
            <form className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); save.mutate(body(input)); }}>
              <Field label="Tax regime">{(p) => <Select {...p} disabled={final || !canManage} value={input.regime} onChange={(e) => set({ regime: e.target.value })}>{r.regimes.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>}</Field>
              <Field label="Depreciation under section 32">{(p) => <Input {...p} disabled={final || !canManage} inputMode="decimal" placeholder="Not entered" value={input.taxDepreciation ?? ''} onChange={(e) => set({ taxDepreciation: e.target.value })} />}</Field>
              <Field label="Business loss brought forward">{(p) => <Input {...p} disabled={final || !canManage} inputMode="decimal" value={input.broughtForwardLoss} onChange={(e) => set({ broughtForwardLoss: e.target.value })} />}</Field>
              <Field label="Other tax paid">{(p) => <Input {...p} disabled={final || !canManage} inputMode="decimal" value={input.otherCredits} onChange={(e) => set({ otherCredits: e.target.value })} />}</Field>
              <div className="sm:col-span-2 lg:col-span-4">
                <div className="mb-2 text-sm font-medium">Other additions and deductions</div>
                {input.adjustments.map((a, n) => (
                  <div key={n} className="mb-2 grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
                    <Input aria-label={`Adjustment ${n + 1} description`} disabled={final || !canManage} maxLength={200} value={a.label} onChange={(e) => set({ adjustments: input.adjustments.map((x, i) => (i === n ? { ...x, label: e.target.value } : x)) })} />
                    <Input aria-label={`Adjustment ${n + 1} section`} disabled={final || !canManage} maxLength={20} placeholder="Section" value={a.section ?? ''} onChange={(e) => set({ adjustments: input.adjustments.map((x, i) => (i === n ? { ...x, section: e.target.value } : x)) })} />
                    <Select aria-label={`Adjustment ${n + 1} add or deduct`} disabled={final || !canManage} value={a.kind} onChange={(e) => set({ adjustments: input.adjustments.map((x, i) => (i === n ? { ...x, kind: e.target.value as Adjustment['kind'] } : x)) })}>
                      <option value="ADD">Add back</option>
                      <option value="DEDUCT">Deduct</option>
                    </Select>
                    <Input aria-label={`Adjustment ${n + 1} amount`} disabled={final || !canManage} inputMode="decimal" value={a.amount} onChange={(e) => set({ adjustments: input.adjustments.map((x, i) => (i === n ? { ...x, amount: e.target.value } : x)) })} />
                    {!final && canManage ? <Button type="button" variant="ghost" size="sm" onClick={() => set({ adjustments: input.adjustments.filter((_, i) => i !== n) })}>Remove</Button> : <span />}
                  </div>
                ))}
                {!final && canManage ? <Button type="button" variant="ghost" size="sm" disabled={input.adjustments.length >= 50} onClick={() => set({ adjustments: [...input.adjustments, { label: '', section: '', kind: 'ADD', amount: '' }] })}>Add an adjustment</Button> : null}
              </div>
              {!final && canManage ? (
                <div className="flex items-center justify-end gap-3 text-xs text-fg-muted sm:col-span-2 lg:col-span-4">
                  {draft ? 'Unsaved changes' : null}
                  <Button type="submit" variant="secondary" disabled={!valid || (!draft && r.saved)} loading={save.isPending}>Save computation</Button>
                </div>
              ) : null}
            </form>
          </Card>
          {confirming ? (
            <Dialog open onOpenChange={(o) => !o && setConfirming(false)} title={`Finalise the computation for ${r.taxYear}?`} description="The figures and your inputs are frozen as they are now and cannot be changed or deleted. Later postings to the year are shown against it.">
              <ErrorAlert title="Not finalised" error={finalise.error} />
              {draft ? <p className="mb-3 text-sm text-warning">Save your changes first: unsaved changes would be lost.</p> : null}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                <Button loading={finalise.isPending} disabled={!!draft} onClick={() => finalise.mutate()}>Finalise</Button>
              </div>
            </Dialog>
          ) : null}
        </>
      ) : null}
    </>
  );
}
