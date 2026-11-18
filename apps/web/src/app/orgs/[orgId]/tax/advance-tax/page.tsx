'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, SectionHelpSlot, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Regime = 'COMPANY_22' | 'COMPANY_25' | 'COMPANY_30' | 'FIRM_30';
type Method = 'ANNUALISE' | 'ESTIMATE';
interface AccountRef { id: string; code: string; name: string }
interface Plan {
  regime: Regime;
  method: Method;
  estimatedIncome: string | null;
  adjustments: { label: string; amount: string }[];
  paidAccountId: string | null;
  tdsAccountId: string | null;
  otherCredits: string;
  paidAccount: AccountRef | null;
  tdsAccount: AccountRef | null;
}
interface AdvanceTax {
  taxYear: string;
  from: string;
  to: string;
  asOf: string;
  currency: string;
  saved: { updatedAt: string; updatedBy: string | null } | null;
  plan: Plan;
  regimes: { key: Regime; label: string; note: string }[];
  income: { profitToDate: string; taxExpenseExcluded: string; daysElapsed: number; daysInYear: number; projected: string; adjustments: string; taxable: string };
  tax: { tax: string; surchargeRate: string; surcharge: string; marginalRelief: string; cess: string; total: string };
  credits: { tds: string; other: string; total: string };
  netLiability: string;
  required: boolean;
  threshold: string;
  paid: string;
  remaining: string;
  payments: { date: string; amount: string }[];
  instalments: { number: number; dueDate: string; share: string; required: string; paidByDue: string; status: 'PAID' | 'SHORT' | 'UPCOMING'; toPay: string }[];
}
interface Account { id: string; code: string; name: string; type: string; isPostable: boolean; isActive: boolean }

const STATUS: Record<AdvanceTax['instalments'][number]['status'], { label: string; tone: 'positive' | 'negative' | 'neutral' }> = {
  PAID: { label: 'Paid', tone: 'positive' },
  SHORT: { label: 'Short', tone: 'negative' },
  UPCOMING: { label: 'Upcoming', tone: 'neutral' },
};

/** Advance tax (TAX-021): the year's estimated tax and the four instalments against payments in the books. */
export default function AdvanceTaxPage() {
  const { org, orgId } = useOrg();
  const [year, setYear] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['advance-tax', orgId, year], queryFn: () => api<AdvanceTax>(`/v1/orgs/${orgId}/tax/advance-tax${year ? `?taxYear=${year}` : ''}`) });
  const [editing, setEditing] = useState(false);
  if (!org) return null;
  const d = q.data;
  const manage = can(org.role, 'accounts.manage');
  const startYear = d ? Number(d.taxYear.slice(0, 4)) : null;
  const label = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  return (
    <>
      <PageHeader
        title="Advance tax"
        description="The income tax for the year worked out from your books or your estimate, and what should be paid by each instalment date. For companies, firms and LLPs. Check the rates against the year's Finance Act before paying."
        actions={
          startYear ? (
            <Select aria-label="Tax year" value={d!.taxYear} onChange={(e) => setYear(e.target.value)}>
              {[startYear + 1, startYear, startYear - 1].map((y) => <option key={y} value={label(y)}>Tax year {label(y)}</option>)}
            </Select>
          ) : null
        }
      />
      <ErrorAlert title="Could not load advance tax" error={q.error as Error | null} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Tax for the year" value={<Money value={d.tax.total} currency={d.currency} />} sub={`On taxable income of ${new Intl.NumberFormat('en-IN').format(Number(d.income.taxable))}`} />
            <Stat label="After tax credits" value={<Money value={d.netLiability} currency={d.currency} />} sub={d.required ? 'Advance tax is due' : `Under ₹${new Intl.NumberFormat('en-IN').format(Number(d.threshold))}: no advance tax due`} />
            <Stat label="Paid so far" value={<Money value={d.paid} currency={d.currency} />} sub={d.plan.paidAccount ? `${d.plan.paidAccount.code} ${d.plan.paidAccount.name}` : 'Choose the advance tax account'} />
            <Stat label="Still to pay" value={<Money value={d.remaining} currency={d.currency} />} sub={`Tax year ${d.from.slice(0, 4)}-${d.to.slice(2, 4)}, books to ${date(d.asOf)}`} />
          </div>
          {editing ? <PlanEditor orgId={orgId} data={d} onDone={() => setEditing(false)} /> : <PlanCard data={d} canEdit={manage} onEdit={() => setEditing(true)} />}
          <Card className="mb-4">
            <CardHeader title="Tax for the year" help={<SectionHelpSlot title="Tax for the year" />} description={d.regimes.find((r) => r.key === d.plan.regime)?.note} />
            <Table aria-label="Tax for the year">
              <tbody>
                <Tr><Td>Profit before tax in the books, {date(d.from)} to {date(d.asOf)}</Td><Td numeric><Money value={d.income.profitToDate} currency={d.currency} signed /></Td></Tr>
                {d.plan.method === 'ANNUALISE' ? <Tr><Td>Scaled to the full year ({d.income.daysElapsed} of {d.income.daysInYear} days)</Td><Td numeric><Money value={d.income.projected} currency={d.currency} signed /></Td></Tr> : <Tr><Td>Your estimate for the year</Td><Td numeric><Money value={d.income.projected} currency={d.currency} signed /></Td></Tr>}
                {d.plan.adjustments.map((a, i) => <Tr key={i}><Td className="pl-8">{a.label}</Td><Td numeric><Money value={a.amount} currency={d.currency} signed /></Td></Tr>)}
                <Tr><Td className="font-medium">Taxable income (rounded to tens; a loss counts as nil)</Td><Td numeric className="font-medium"><Money value={d.income.taxable} currency={d.currency} /></Td></Tr>
                <Tr><Td>Tax at {d.regimes.find((r) => r.key === d.plan.regime)?.label.match(/\((\d+%)\)/)?.[1] ?? 'the rate'}</Td><Td numeric><Money value={d.tax.tax} currency={d.currency} /></Td></Tr>
                <Tr><Td>Surcharge ({d.tax.surchargeRate}%)</Td><Td numeric><Money value={d.tax.surcharge} currency={d.currency} /></Td></Tr>
                {Number(d.tax.marginalRelief) > 0 ? <Tr><Td>Marginal relief</Td><Td numeric><Money value={`-${d.tax.marginalRelief}`} currency={d.currency} signed /></Td></Tr> : null}
                <Tr><Td>Health and education cess (4%)</Td><Td numeric><Money value={d.tax.cess} currency={d.currency} /></Td></Tr>
                <Tr><Td className="font-medium">Tax for the year (rounded to tens)</Td><Td numeric className="font-medium"><Money value={d.tax.total} currency={d.currency} /></Td></Tr>
                <Tr><Td>Less tax deducted or collected at source{d.plan.tdsAccount ? ` (${d.plan.tdsAccount.code} ${d.plan.tdsAccount.name})` : ''}</Td><Td numeric><Money value={`-${d.credits.tds}`} currency={d.currency} signed /></Td></Tr>
                {Number(d.credits.other) > 0 ? <Tr><Td>Less other credits</Td><Td numeric><Money value={`-${d.credits.other}`} currency={d.currency} signed /></Td></Tr> : null}
                <Tr><Td className="font-medium">Advance tax for the year</Td><Td numeric className="font-medium"><Money value={d.required ? d.netLiability : '0'} currency={d.currency} /></Td></Tr>
              </tbody>
            </Table>
            {Number(d.income.taxExpenseExcluded) !== 0 ? <p className="px-5 py-3 text-xs text-fg-muted">Income tax expense of <Money value={d.income.taxExpenseExcluded} currency={d.currency} /> in the books is left out of the profit.</p> : null}
          </Card>
          <Card>
            <CardHeader title="Advance tax instalments" help={<SectionHelpSlot title="Advance tax instalments" />} description={<>Payments are the posted debits to the advance tax account. Mark each one paid in the <Link className="text-accent underline" href={`/orgs/${orgId}/tax/compliance`}>Compliance calendar</Link> with the challan.</>} />
            <Table aria-label="Advance tax instalments">
              <thead><tr><Th>Due by</Th><Th numeric>Share of the year</Th><Th numeric>Due by then</Th><Th numeric>Paid by then</Th><Th numeric>To pay</Th><Th>Status</Th></tr></thead>
              <tbody>
                {d.instalments.map((i) => (
                  <Tr key={i.number}>
                    <Td className="whitespace-nowrap">{date(i.dueDate)}</Td>
                    <Td numeric>{i.share}%</Td>
                    <Td numeric><Money value={i.required} currency={d.currency} /></Td>
                    <Td numeric><Money value={i.paidByDue} currency={d.currency} /></Td>
                    <Td numeric><Money value={i.toPay} currency={d.currency} /></Td>
                    <Td><Badge tone={STATUS[i.status].tone}>{i.status === 'SHORT' ? `Short by ${new Intl.NumberFormat('en-IN').format(Number(i.toPay))}` : STATUS[i.status].label}</Badge></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {d.payments.length ? (
              <p className="px-5 py-3 text-sm text-fg-muted">Payments this year: {d.payments.map((p, i) => <span key={i}>{i ? ', ' : ''}{date(p.date)} <Money value={p.amount} currency={d.currency} signed /></span>)}</p>
            ) : null}
          </Card>
        </>
      ) : null}
    </>
  );
}

function PlanCard({ data: d, canEdit, onEdit }: { data: AdvanceTax; canEdit: boolean; onEdit: () => void }) {
  const regime = d.regimes.find((r) => r.key === d.plan.regime)!;
  return (
    <Card className="mb-4">
      <CardHeader
        title="Advance tax plan"
        help={<SectionHelpSlot title="Advance tax plan" />}
        description={d.saved ? `Saved ${date(d.saved.updatedAt.slice(0, 10))}${d.saved.updatedBy ? ` by ${d.saved.updatedBy}` : ''}` : 'Not saved for this year yet: showing the defaults. Check the tax rate and choose the accounts.'}
        actions={canEdit ? <Button size="sm" variant="secondary" onClick={onEdit}>Edit plan</Button> : null}
      />
      <dl className="grid gap-x-6 gap-y-2 p-5 text-sm sm:grid-cols-2">
        <div><dt className="text-fg-muted">Taxed as</dt><dd>{regime.label}</dd></div>
        <div><dt className="text-fg-muted">Income for the year</dt><dd>{d.plan.method === 'ANNUALISE' ? 'Profit so far, scaled to a full year' : 'Your estimate'}</dd></div>
        <div><dt className="text-fg-muted">Advance tax paid account</dt><dd>{d.plan.paidAccount ? `${d.plan.paidAccount.code} ${d.plan.paidAccount.name}` : 'Not chosen'}</dd></div>
        <div><dt className="text-fg-muted">Tax deducted at source account</dt><dd>{d.plan.tdsAccount ? `${d.plan.tdsAccount.code} ${d.plan.tdsAccount.name}` : 'Not chosen'}</dd></div>
      </dl>
    </Card>
  );
}

function PlanEditor({ orgId, data: d, onDone }: { orgId: string; data: AdvanceTax; onDone: () => void }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts', orgId], queryFn: () => api<Account[]>(`/v1/orgs/${orgId}/accounts`) });
  const assets = (accounts.data ?? []).filter((a) => a.type === 'ASSET' && a.isPostable && a.isActive);
  const [f, setF] = useState({
    regime: d.plan.regime,
    method: d.plan.method,
    estimatedIncome: d.plan.estimatedIncome ?? '',
    adjustments: d.plan.adjustments,
    paidAccountId: d.plan.paidAccountId ?? '',
    tdsAccountId: d.plan.tdsAccountId ?? '',
    otherCredits: d.plan.otherCredits,
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/v1/orgs/${orgId}/tax/advance-tax`, {
        method: 'PUT',
        body: {
          taxYear: d.taxYear,
          regime: f.regime,
          method: f.method,
          estimatedIncome: f.method === 'ESTIMATE' ? f.estimatedIncome.trim() || null : null,
          adjustments: f.adjustments.filter((a) => a.label.trim() || a.amount.trim()),
          paidAccountId: f.paidAccountId || null,
          tdsAccountId: f.tdsAccountId || null,
          otherCredits: f.otherCredits.trim() || '0',
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['advance-tax', orgId] });
      onDone();
    },
  });
  const setAdj = (i: number, patch: Partial<{ label: string; amount: string }>) => setF({ ...f, adjustments: f.adjustments.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  return (
    <Card className="mb-4">
      <CardHeader title={`Advance tax plan for ${d.taxYear}`} help={<SectionHelpSlot title="Advance tax plan" />} description="Saving changes only how the tax is worked out; nothing is posted." />
      <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Taxed as" hint={d.regimes.find((r) => r.key === f.regime)?.note}>{(p) => (
            <Select {...p} value={f.regime} onChange={(e) => setF({ ...f, regime: e.target.value as Regime })}>
              {d.regimes.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </Select>
          )}</Field>
          <Field label="Income for the year">{(p) => (
            <Select {...p} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as Method })}>
              <option value="ANNUALISE">Profit so far, scaled to a full year</option>
              <option value="ESTIMATE">My own estimate</option>
            </Select>
          )}</Field>
          {f.method === 'ESTIMATE' ? <Field label="Estimated profit before tax for the year">{(p) => <Input {...p} className="num" inputMode="decimal" value={f.estimatedIncome} onChange={(e) => setF({ ...f, estimatedIncome: e.target.value })} required />}</Field> : null}
        </div>
        <fieldset>
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Adjustments to taxable income</legend>
          <div className="space-y-2">
            {f.adjustments.map((a, i) => (
              <div key={i} className="grid grid-cols-[1fr_10rem_auto] items-center gap-2">
                <Input aria-label={`Adjustment ${i + 1}`} value={a.label} onChange={(e) => setAdj(i, { label: e.target.value })} placeholder="Penalties not allowed" maxLength={100} />
                <Input aria-label={`Amount for adjustment ${i + 1}`} className="num text-right" inputMode="decimal" value={a.amount} onChange={(e) => setAdj(i, { amount: e.target.value })} placeholder="+ adds, - takes off" />
                <Button type="button" size="sm" variant="ghost" aria-label={`Remove adjustment ${i + 1}`} onClick={() => setF({ ...f, adjustments: f.adjustments.filter((_, j) => j !== i) })}>Remove</Button>
              </div>
            ))}
          </div>
          <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => setF({ ...f, adjustments: [...f.adjustments, { label: '', amount: '' }] })}>Add an adjustment</Button>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Advance tax paid account">{(p) => (
            <Select {...p} value={f.paidAccountId} onChange={(e) => setF({ ...f, paidAccountId: e.target.value })}>
              <option value="">Not chosen</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </Select>
          )}</Field>
          <Field label="Tax deducted at source account">{(p) => (
            <Select {...p} value={f.tdsAccountId} onChange={(e) => setF({ ...f, tdsAccountId: e.target.value })}>
              <option value="">Not chosen</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </Select>
          )}</Field>
          <Field label="Other tax credits">{(p) => <Input {...p} className="num" inputMode="decimal" value={f.otherCredits} onChange={(e) => setF({ ...f, otherCredits: e.target.value })} />}</Field>
        </div>
        <ErrorAlert title="Could not save the plan" error={save.error as Error | null} />
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>Save plan</Button>
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
