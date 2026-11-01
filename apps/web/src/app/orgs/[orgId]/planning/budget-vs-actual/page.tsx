'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { DateInput } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { BUDGET_STATUS, type BudgetOverview, type BudgetVariance, type Granularity, type Variance, type VarianceFigures } from '@/lib/budgets';
import { date, money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

const GRAN: { value: Granularity; label: string }[] = [
  { value: 'MONTH', label: 'Months' },
  { value: 'QUARTER', label: 'Quarters' },
  { value: 'YEAR', label: 'Year' },
];

export default function BudgetVsActualPage() {
  return (
    <Suspense>
      <BudgetVsActual />
    </Suspense>
  );
}

function BudgetVsActual() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const budgetParam = params.get('budget');
  const granularity = (params.get('by') as Granularity | null) ?? 'QUARTER';
  const asOf = params.get('asOf') ?? today();
  const fy = params.get('fy');
  const overview = useQuery({ queryKey: ['budgets', orgId, fy], queryFn: () => api<BudgetOverview>(`/v1/orgs/${orgId}/budgets${fy ? `?fiscalYear=${fy}` : ''}`), enabled: !budgetParam || !!fy });
  // Without a choice: the year's approved version, else its latest.
  const chosen = budgetParam ?? overview.data?.budgets.find((b) => b.status === 'APPROVED')?.id ?? overview.data?.budgets[0]?.id ?? null;
  const v = useQuery({
    queryKey: ['budget-variance', orgId, chosen, granularity, asOf],
    queryFn: () => api<BudgetVariance>(`/v1/orgs/${orgId}/budgets/${chosen}/variance?granularity=${granularity}&asOf=${asOf}`),
    enabled: !!chosen,
  });
  const year = useQuery({
    queryKey: ['budgets', orgId, String(v.data?.budget.fiscalYear ?? '')],
    queryFn: () => api<BudgetOverview>(`/v1/orgs/${orgId}/budgets?fiscalYear=${v.data!.budget.fiscalYear}`),
    enabled: !!v.data,
  });
  if (!org) return null;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, val] of Object.entries(patch)) if (val === null) next.delete(k); else next.set(k, val);
    router.replace(`/orgs/${orgId}/planning/budget-vs-actual?${next.toString()}`);
  };
  const d = v.data;
  const c = d?.currency ?? org.functionalCurrency;
  const years = (year.data ?? overview.data)?.years ?? [];

  return (
    <>
      <PageHeader
        title="Budget vs actual"
        description="A budget version against posted revenue and expenses. Favourable means revenue above budget or spending below it. Periods that have not started show the budget only; the period in progress compares its whole budget with the actuals so far."
        actions={<DateInput label="As of" value={asOf} onChange={(x) => set({ asOf: x })} />}
      />
      <ErrorAlert title="Could not load" error={overview.error ?? v.error} />
      {!chosen && overview.data ? (
        <EmptyState title={`No budget for FY${overview.data.fiscalYear}`} action={<Link className="text-accent hover:underline" href={`/orgs/${orgId}/planning/budgets?fy=${overview.data.fiscalYear}`}>Create one on the Budgets page</Link>}>
          Budget vs actual compares a budget version with the books.
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {overview.data.years.map((y) => <Button key={y.fiscalYear} size="sm" variant="ghost" onClick={() => set({ fy: String(y.fiscalYear), budget: null })}>{y.label}</Button>)}
          </div>
        </EmptyState>
      ) : null}
      {d ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Year
              <Select className="w-32" value={d.budget.fiscalYear} onChange={(e) => set({ fy: e.target.value, budget: null })}>
                {years.map((y) => <option key={y.fiscalYear} value={y.fiscalYear}>{y.label}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Version
              <Select className="w-72" value={d.budget.id} onChange={(e) => set({ budget: e.target.value })}>
                {(year.data?.budgets ?? []).map((b) => <option key={b.id} value={b.id}>v{b.version} · {b.name} ({BUDGET_STATUS[b.status].label.toLowerCase()})</option>)}
              </Select>
            </label>
            <div className="flex gap-1" role="group" aria-label="Group by">
              {GRAN.map((g) => <Button key={g.value} size="sm" variant={g.value === granularity ? 'secondary' : 'ghost'} aria-pressed={g.value === granularity} onClick={() => set({ by: g.value })}>{g.label}</Button>)}
            </div>
            <span className="ml-auto flex items-center gap-2 text-sm text-fg-muted">
              <Badge tone={BUDGET_STATUS[d.budget.status].tone}>{BUDGET_STATUS[d.budget.status].label}</Badge>
              <Link className="text-accent hover:underline" href={`/orgs/${orgId}/planning/budgets/${d.budget.id}`}>Open version</Link>
            </span>
          </div>
          {d.budget.status !== 'APPROVED' ? (
            <p className="mb-4 rounded border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
              This version is {BUDGET_STATUS[d.budget.status].label.toLowerCase()}, not the approved budget.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <YtdStat label="Revenue, year to date" f={d.revenue} currency={c} />
            <YtdStat label="Expenses, year to date" f={d.expenses} currency={c} />
            <YtdStat label="Net income, year to date" f={d.netIncome} currency={c} />
            <Stat label="Full-year budget" value={money(d.netIncome.fullYearBudget, c)} sub={`Net income · revenue ${money(d.revenue.fullYearBudget, c)}`} />
          </div>
          <p className="mt-2 text-xs text-fg-muted">
            {d.actualsThrough ? `Actuals are posted journals from ${date(d.buckets[0].from)} to ${date(d.actualsThrough)}; ${d.periodsStarted} of 12 months have started.` : `FY${d.budget.fiscalYear} has not started on ${date(d.asOf)}, so there are no actuals yet.`}
          </p>

          <Card className="mt-4">
            <CardHeader title={`FY${d.budget.fiscalYear} · v${d.budget.version} ${d.budget.name}`} description="Each cell shows the actual, the budget and the difference." />
            <Table className={granularity === 'MONTH' ? 'min-w-[1900px]' : undefined}>
              <thead>
                <tr>
                  <Th className="sticky left-0 z-10 bg-surface">Account</Th>
                  {d.buckets.map((b) => (
                    <Th key={b.key} numeric>
                      {b.label}
                      {b.inProgress ? <span className="block font-normal normal-case text-fg-faint">in progress</span> : null}
                    </Th>
                  ))}
                  {granularity !== 'YEAR' ? <Th numeric>Year to date</Th> : null}
                  <Th numeric>Full-year budget</Th>
                </tr>
              </thead>
              <tbody>
                {(['REVENUE', 'EXPENSE'] as const).map((type) => (
                  <Fragment key={type}>
                    <tr>
                      <Td colSpan={d.buckets.length + 3} className="sticky left-0 bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">{type === 'REVENUE' ? 'Revenue' : 'Expenses'}</Td>
                    </tr>
                    {d.rows.filter((r) => r.type === type).map((r) => (
                      <tr key={r.accountId} aria-label={`${r.code} ${r.name}`}>
                        <Td className="sticky left-0 z-10 min-w-56 bg-surface">
                          <span className="num text-fg-muted">{r.code}</span> {r.name}
                          {!r.budgeted ? <Badge tone="warning" className="ml-1">Not budgeted</Badge> : null}
                        </Td>
                        {r.buckets.map((x, i) => <Cell key={i} v={x} currency={c} />)}
                        {granularity !== 'YEAR' ? <Cell v={r.yearToDate} currency={c} strong /> : null}
                        <Td numeric className="text-fg-muted"><Money value={r.fullYearBudget} currency={c} /></Td>
                      </tr>
                    ))}
                    <TotalRow label={type === 'REVENUE' ? 'Total revenue' : 'Total expenses'} f={type === 'REVENUE' ? d.revenue : d.expenses} currency={c} showYtd={granularity !== 'YEAR'} />
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <TotalRow label="Net income" f={d.netIncome} currency={c} showYtd={granularity !== 'YEAR'} big />
              </tfoot>
            </Table>
            {!d.rows.length ? <p className="px-5 py-4 text-sm text-fg-muted">This version has no amounts and nothing has been posted yet.</p> : null}
          </Card>
        </>
      ) : null}
    </>
  );
}

function tone(v: Variance) {
  return v.favourable === null ? 'text-fg-muted' : v.favourable ? 'text-positive' : 'text-negative';
}

function Cell({ v, currency, strong }: { v: Variance; currency: string; strong?: boolean }) {
  return (
    <Td numeric className="whitespace-nowrap align-top">
      {v.actual === null ? (
        <span className="text-fg-faint" title="Not started">
          <span className="block">—</span>
          <span className="block text-xs">budget {money(v.budget, currency)}</span>
        </span>
      ) : (
        <>
          <span className={strong ? 'block font-semibold' : 'block'}>{money(v.actual, currency)}</span>
          <span className="block text-xs text-fg-muted">of {money(v.budget, currency)}</span>
          <span className={`block text-xs ${tone(v)}`}>
            {v.variance && !v.variance.startsWith('-') && v.variance !== '0.00' ? '+' : ''}
            {money(v.variance, currency)}
            {v.percent !== null ? ` (${v.percent}%)` : ''}
          </span>
        </>
      )}
    </Td>
  );
}

function TotalRow({ label, f, currency, showYtd, big }: { label: string; f: VarianceFigures; currency: string; showYtd: boolean; big?: boolean }) {
  return (
    <tr className="bg-surface-raised/40">
      <Td className={`sticky left-0 z-10 bg-surface font-semibold ${big ? 'text-base' : ''}`}>{label}</Td>
      {f.buckets.map((x, i) => <Cell key={i} v={x} currency={currency} strong />)}
      {showYtd ? <Cell v={f.yearToDate} currency={currency} strong /> : null}
      <Td numeric className="whitespace-nowrap font-semibold"><Money value={f.fullYearBudget} currency={currency} signed /></Td>
    </tr>
  );
}

function YtdStat({ label, f, currency }: { label: string; f: VarianceFigures; currency: string }) {
  const y = f.yearToDate;
  return (
    <Stat
      label={label}
      value={y.actual === null ? '—' : money(y.actual, currency)}
      tone={y.favourable === null ? 'neutral' : y.favourable ? 'positive' : 'negative'}
      sub={
        y.actual === null
          ? `Budget ${money(y.budget, currency)}`
          : `Budget ${money(y.budget, currency)} · ${y.favourable ? 'favourable' : 'unfavourable'} ${money(y.variance!.replace('-', ''), currency)}${y.percent !== null ? ` (${y.percent.replace('-', '')}%)` : ''}`
      }
    />
  );
}
