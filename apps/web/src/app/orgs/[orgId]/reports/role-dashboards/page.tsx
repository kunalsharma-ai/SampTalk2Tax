'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Table, Td, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Sparkline } from '@/components/kpis/sparkline';
import { Money } from '@/components/money';
import {
  type AccountantView,
  AGING_LABEL,
  type CloseRow,
  type ControllerView,
  type InternalAuditorView,
  type PendingApprovals,
  type ProcurementView,
  type AiAdminView,
  type DepartmentManagerView,
  DepartmentSpendChart,
  type ExternalAuditorView,
  type OrgAdminView,
  ProjectBars,
  type ProjectFinanceView,
  type FinanceDirectorView,
  type PlanFigure,
  PlanQuarterBars,
  type AnalystView,
  type Movement,
  MarginChart,
  PayrollCostBars,
  type PayrollManagerView,
  type Aging,
  AgingBars,
  type Attention,
  type BoardView,
  type ExpenseManagerView,
  type PayablesView,
  type ReceivablesView,
  type TaxManagerView,
  CashRunwayChart,
  type CeoView,
  type CfoView,
  type ComplianceView,
  type DashboardRole,
  QuarterBars,
  RevenueBars,
  type RiskOfficerView,
  type RoleDashboard,
  type RoleKpi,
  type TaxMonth,
  type TreasuryView,
} from '@/components/reports/role-dashboards';
import { LEVEL, RiskGauge } from '@/components/reports/risk-monitor';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { formatChange, formatKpi, monthLabel } from '@/lib/kpis';
import { useOrg } from '@/lib/org';

const ROLES: { role: DashboardRole; label: string }[] = [
  { role: 'CEO', label: 'CEO' },
  { role: 'CFO', label: 'CFO' },
  { role: 'TREASURY', label: 'Treasury' },
  { role: 'RISK', label: 'Risk officer' },
  { role: 'COMPLIANCE', label: 'Compliance' },
  { role: 'BOARD', label: 'Board and investors' },
  { role: 'AR_MANAGER', label: 'Receivables' },
  { role: 'AP_MANAGER', label: 'Payables' },
  { role: 'TAX_MANAGER', label: 'Tax manager' },
  { role: 'EXPENSE_MANAGER', label: 'Expenses' },
  { role: 'ACCOUNTANT', label: 'Accountant' },
  { role: 'CONTROLLER', label: 'Controller' },
  { role: 'INTERNAL_AUDITOR', label: 'Internal audit' },
  { role: 'PROCUREMENT', label: 'Procurement' },
  { role: 'PAYROLL_MANAGER', label: 'Payroll' },
  { role: 'AI_ADMIN', label: 'AI agents' },
  { role: 'ANALYST', label: 'Financial analyst' },
  { role: 'FINANCE_DIRECTOR', label: 'Finance director' },
  { role: 'DEPARTMENT_MANAGER', label: 'Department manager' },
  { role: 'EXTERNAL_AUDITOR', label: 'External auditor' },
  { role: 'PROJECT_FINANCE', label: 'Project finance' },
  { role: 'ORG_ADMIN', label: 'Organisation admin' },
];
const TONE = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' } as const;
const SEVERITY = { CRITICAL: 'negative', HIGH: 'warning', WATCH: 'neutral' } as const;
const GROUP = { CUSTOMERS: 'Customers (revenue)', VENDORS: 'Vendors (spending)', CASH: 'Cash and bank accounts', BORROWING: 'Lenders (borrowing)' } as const;
const BAND = { NONE: 'No revenue yet', LOW: 'Spread across many customers', MODERATE: 'Moderately concentrated', HIGH: 'Highly concentrated' } as const;

export default function RoleDashboardsPage() {
  return (
    <Suspense>
      <RoleDashboards />
    </Suspense>
  );
}

function RoleDashboards() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get('role');
  const role: DashboardRole = ROLES.some((r) => r.role === raw) ? (raw as DashboardRole) : 'CEO';
  const roles = useQuery({ queryKey: ['role-dashboards', orgId], queryFn: () => api<{ roles: { role: DashboardRole; available: boolean }[] }>(`/v1/orgs/${orgId}/reports/role-dashboards`) });
  const closed = new Set((roles.data?.roles ?? []).filter((x) => !x.available).map((x) => x.role));
  const departmentId = role === 'DEPARTMENT_MANAGER' ? params.get('department') : null;
  const q = useQuery({
    enabled: !closed.has(role),
    queryKey: ['role-dashboard', orgId, role, departmentId],
    queryFn: () => api<RoleDashboard>(`/v1/orgs/${orgId}/reports/role-dashboards/${role}${departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : ''}`),
  });
  if (!org) return null;
  const r = q.data && q.data.role === role ? q.data : null;
  const c = r?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Role dashboards"
        description="One dashboard for each role that reads the books, each laid out around the questions that role asks: the CEO, the CFO, treasury, the risk officer, compliance, the board or investors, the receivables, payables, tax and expense managers, the accountant, the controller, internal audit, procurement, payroll, the AI agent administrator, the financial analyst, the finance director, a department manager, the external auditor, project finance and the organisation admin. Every figure comes from your posted books and Talk2Tax's own checks."
      />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Dashboard for">
        {ROLES.map((x) => (
          <Button key={x.role} role="tab" aria-selected={x.role === role} disabled={closed.has(x.role)} title={closed.has(x.role) ? 'Not open to your role' : undefined} size="sm" variant={x.role === role ? 'primary' : 'ghost'} onClick={() => router.replace(`?role=${x.role}`)}>
            {x.label}
          </Button>
        ))}
      </div>
      <ErrorAlert title="Could not read this dashboard" error={q.error} />
      {closed.has(role) ? <p className="text-sm text-fg-muted" role="status">This dashboard is not open to your role. Ask an owner for access.</p> : null}
      {r ? (
        <div role="tabpanel" aria-label={`${r.name} dashboard`} className="grid gap-4">
          <p className="text-sm text-fg-muted">
            <span className="font-medium text-fg">{r.name}.</span> {r.question}
          </p>
          {r.ceo ? <Ceo v={r.ceo} c={c} orgId={orgId} /> : null}
          {r.cfo ? <Cfo v={r.cfo} c={c} orgId={orgId} /> : null}
          {r.treasury ? <Treasury v={r.treasury} c={c} orgId={orgId} /> : null}
          {r.risk ? <RiskOfficer v={r.risk} orgId={orgId} /> : null}
          {r.compliance ? <Compliance v={r.compliance} c={c} orgId={orgId} /> : null}
          {r.board ? <Board v={r.board} c={c} /> : null}
          {r.receivables ? <Receivables v={r.receivables} c={c} orgId={orgId} /> : null}
          {r.payables ? <Payables v={r.payables} c={c} orgId={orgId} /> : null}
          {r.tax ? <TaxManager v={r.tax} c={c} orgId={orgId} /> : null}
          {r.expenses ? <ExpenseManager v={r.expenses} c={c} orgId={orgId} /> : null}
          {r.accountant ? <Accountant v={r.accountant} c={c} orgId={orgId} /> : null}
          {r.controller ? <Controller v={r.controller} c={c} orgId={orgId} /> : null}
          {r.audit ? <InternalAuditor v={r.audit} orgId={orgId} /> : null}
          {r.procurement ? <Procurement v={r.procurement} c={c} orgId={orgId} /> : null}
          {r.payroll ? <PayrollManager v={r.payroll} c={c} orgId={orgId} /> : null}
          {r.ai ? <AiAdmin v={r.ai} orgId={orgId} /> : null}
          {r.analyst ? <Analyst v={r.analyst} c={c} /> : null}
          {r.director ? <FinanceDirector v={r.director} c={c} orgId={orgId} /> : null}
          {r.department ? <DepartmentManager v={r.department} c={c} orgId={orgId} onChoose={(id) => router.replace(`?role=DEPARTMENT_MANAGER&department=${encodeURIComponent(id)}`)} /> : null}
          {r.externalAudit ? <ExternalAuditor v={r.externalAudit} c={c} orgId={orgId} /> : null}
          {r.projects ? <ProjectFinance v={r.projects} c={c} orgId={orgId} /> : null}
          {r.admin ? <OrgAdmin v={r.admin} orgId={orgId} /> : null}
        </div>
      ) : !q.error && !closed.has(role) ? <p className="text-sm text-fg-muted">Reading the dashboard…</p> : null}
    </>
  );
}

function KpiTile({ k, c, big }: { k: RoleKpi; c: string; big?: boolean }) {
  return (
    <div className={cn('rounded-[var(--t2t-radius-md)] border border-line p-4', big && 'p-5')} role="group" aria-label={k.label} title={k.formula}>
      <p className="text-xs uppercase tracking-wide text-fg-muted">{k.label}</p>
      <p className={cn('num mt-1 font-semibold', big ? 'text-3xl' : 'text-xl')}>{formatKpi(k.value, k.unit, c)}</p>
      <p className={cn('mt-1 text-xs', k.improved === true ? 'text-positive' : k.improved === false ? 'text-negative' : 'text-fg-muted')}>
        {k.value === null ? k.reason : k.change !== null ? `${formatChange(k.change, k.unit, c)} on the month before` : 'Nothing to compare with'}
      </p>
      {k.target ? <Badge className="mt-2" tone={k.target.status === 'MET' ? 'positive' : k.target.status === 'MISSED' ? 'negative' : 'neutral'}>Target {k.target.status === 'MET' ? 'met' : k.target.status === 'MISSED' ? 'missed' : 'not measured'}</Badge> : null}
    </div>
  );
}

function AttentionList({ items, orgId, empty }: { items: Attention[]; orgId: string; empty: string }) {
  if (!items.length) return <p className="px-5 py-4 text-sm text-fg-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line" aria-label="Items needing attention">
      {items.map((a, i) => (
        <li key={i} className="flex items-start gap-3 px-5 py-3 text-sm">
          <Badge tone={TONE[a.level]}>{a.level.toLowerCase()}</Badge>
          <div className="min-w-0 flex-1">
            <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}${a.href}`}>{a.title}</Link>
            <p className="text-xs text-fg-muted">{a.area} · {a.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function TaxMonths({ months, totals, c, label }: { months: TaxMonth[]; totals: { amount: string; low: string; high: string; known: string }; c: string; label: string }) {
  if (!months.length) return <p className="px-5 py-4 text-sm text-fg-muted">No tax payments are expected in this window, or the compliance calendar is not set up yet.</p>;
  return (
    <Table aria-label={label}>
      <thead><Tr><Th>Month</Th><Th numeric>Payments</Th><Th numeric>Expected</Th><Th numeric>Range</Th><Th numeric>Already known</Th></Tr></thead>
      <tbody>
        {months.map((m) => (
          <Tr key={m.month}><Td>{monthLabel(m.month)}</Td><Td numeric>{m.payments}</Td><Td numeric><Money value={m.amount} currency={c} /></Td><Td numeric><Money value={m.low} currency={c} /> to <Money value={m.high} currency={c} /></Td><Td numeric><Money value={m.known} currency={c} /></Td></Tr>
        ))}
        <Tr><Td className="font-semibold">Total</Td><Td /><Td numeric className="font-semibold"><Money value={totals.amount} currency={c} /></Td><Td numeric><Money value={totals.low} currency={c} /> to <Money value={totals.high} currency={c} /></Td><Td numeric><Money value={totals.known} currency={c} /></Td></Tr>
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------- CEO: headline, growth, cash, risk

function Ceo({ v, c, orgId }: { v: CeoView; c: string; orgId: string }) {
  return (
    <>
      <Card role="region" aria-label="The headline">
        <CardHeader title="The headline" description={`${monthLabel(v.month)}${v.inProgress ? ', so far' : ''}: revenue, how much of it is kept, and how cash is moving.`} />
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">{v.headline.map((k) => <KpiTile key={k.key} k={k} c={c} big />)}</div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card role="region" aria-label="Revenue by month" className="xl:col-span-2">
          <CardHeader title="Revenue by month" description="Operating revenue posted in each of the last 13 months." />
          <RevenueBars months={v.revenue} currency={c} />
          <div className="overflow-x-auto">
            <Table aria-label="Revenue by month figures">
              <thead><Tr>{v.revenue.map((m) => <Th key={m.month} numeric>{monthLabel(m.month)}</Th>)}</Tr></thead>
              <tbody><Tr>{v.revenue.map((m) => <Td key={m.month} numeric><Money value={m.value} currency={c} /></Td>)}</Tr></tbody>
            </Table>
          </div>
        </Card>
        <div className="grid gap-4">
          <Card role="region" aria-label="Cash position">
            <CardHeader title="Cash position" description="Cash and bank today, and where the cash forecast expects it in 90 days." />
            <dl className="grid gap-3 p-5 text-sm">
              <div className="flex items-baseline justify-between gap-2"><dt className="text-fg-muted">Today</dt><dd className="num text-xl font-semibold"><Money value={v.cash.now} currency={c} /></dd></div>
              <div className="flex items-baseline justify-between gap-2"><dt className="text-fg-muted">In 90 days</dt><dd className="num text-xl font-semibold"><Money value={v.cash.in90Days} currency={c} /></dd></div>
              <div><dt className="text-fg-muted">Lowest point</dt><dd><Money value={v.cash.lowest.amount} currency={c} /> on {date(v.cash.lowest.date)}</dd></div>
            </dl>
          </Card>
          <Card role="region" aria-label="Risk at a glance">
            <CardHeader title="Risk at a glance" description="The risk monitor's overall score." />
            <div className="flex items-center gap-4 px-5 pb-4">
              <RiskGauge score={v.risk.score} level={v.risk.level} />
              <p className="text-sm">{v.risk.focus.length ? <>Look first at {v.risk.focus.slice(0, 3).join(', ')}.</> : 'Nothing needs attention.'} <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/risk-monitor`}>Risk monitor</Link></p>
            </div>
          </Card>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Needs attention now">
          <CardHeader title="Needs attention now" description="The few things across risk, collections, payments and deadlines to act on first." />
          <AttentionList items={v.attention} orgId={orgId} empty="Nothing needs your attention right now." />
        </Card>
        <Card role="region" aria-label="Largest customers">
          <CardHeader title="Largest customers" description={`Revenue over the last 12 months. The largest customer is ${v.customers.largestShare ?? '—'}% of revenue and the top five ${v.customers.topFiveShare ?? '—'}%.`} />
          {v.customers.top.length ? (
            <ul className="flex flex-col gap-3 p-5 text-sm" aria-label="Customers by revenue">
              {v.customers.top.map((x) => (
                <li key={x.name}>
                  <div className="flex justify-between gap-2"><span>{x.name}</span><span><Money value={x.revenue} currency={c} /> · {x.share}%</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-surface-hover" aria-hidden="true"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${Number(x.share ?? 0)}%` }} /></div>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No revenue posted in the last 12 months.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- CFO: margins, liquidity, working capital, tax

function KpiRows({ kpis, c, label, trend }: { kpis: RoleKpi[]; c: string; label: string; trend?: boolean }) {
  return (
    <Table aria-label={label}>
      <thead><Tr><Th>Measure</Th><Th numeric>This month</Th><Th numeric>Month before</Th><Th numeric>Change</Th>{trend ? <Th>Trend</Th> : null}<Th>Target</Th></Tr></thead>
      <tbody>
        {kpis.map((k) => (
          <Tr key={k.key}>
            <Td><span title={k.formula}>{k.label}</span></Td>
            <Td numeric className="font-semibold">{formatKpi(k.value, k.unit, c)}</Td>
            <Td numeric>{formatKpi(k.previous, k.unit, c)}</Td>
            <Td numeric className={k.improved === true ? 'text-positive' : k.improved === false ? 'text-negative' : undefined}>{formatChange(k.change, k.unit, c) || '—'}</Td>
            {trend ? <Td className="w-32"><Sparkline values={(k.series ?? []).map((s) => s.value)} tone="var(--t2t-accent)" /></Td> : null}
            <Td>{k.target ? `${k.target.comparator === 'AT_LEAST' ? 'At least' : 'At most'} ${formatKpi(k.target.target, k.unit, c)}` : '—'}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

function Cfo({ v, c, orgId }: { v: CfoView; c: string; orgId: string }) {
  const w = v.workingCapital;
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card role="region" aria-label="Margins">
          <CardHeader title="Margins" description={`${monthLabel(v.month)}: how much of each rupee of revenue is kept at each level, with the last 13 months as a trend.`} />
          <div className="overflow-x-auto"><KpiRows kpis={v.profitability} c={c} label="Margins by month" trend /></div>
        </Card>
        <Card role="region" aria-label="Liquidity and leverage">
          <CardHeader title="Liquidity and leverage" description="Whether short-term assets cover short-term debts, and how much of the business is funded by others." />
          <div className="overflow-x-auto"><KpiRows kpis={v.liquidity} c={c} label="Liquidity and leverage measures" /></div>
        </Card>
      </div>
      <Card role="region" aria-label="Owed both ways">
        <CardHeader title="Owed both ways" description="What customers owe the business and what it owes vendors today, side by side." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/reports/kpis`}>All KPIs</Link>} />
        <div className="grid gap-4 p-5 md:grid-cols-3">
          <dl className="grid gap-1 text-sm" aria-label="Receivables">
            <dt className="text-xs uppercase tracking-wide text-fg-muted">Customers owe</dt>
            <dd className="num text-2xl font-semibold"><Money value={w.receivables.open} currency={c} /></dd>
            <dd>{w.receivables.invoices} open invoice{w.receivables.invoices === 1 ? '' : 's'}; <Money value={w.receivables.overdue} currency={c} /> overdue</dd>
            <dd><Money value={w.receivables.toChase} currency={c} /> to chase, <Money value={w.receivables.disputed} currency={c} /> disputed</dd>
          </dl>
          <dl className="grid gap-1 text-sm" aria-label="Payables">
            <dt className="text-xs uppercase tracking-wide text-fg-muted">We owe vendors</dt>
            <dd className="num text-2xl font-semibold"><Money value={w.payables.open} currency={c} /></dd>
            <dd>{w.payables.bills} open bill{w.payables.bills === 1 ? '' : 's'}; <Money value={w.payables.overdue} currency={c} /> overdue</dd>
            <dd><Money value={w.payables.payNow} currency={c} /> to pay now{Number(w.payables.short) > 0 ? <>, <span className="text-negative"><Money value={w.payables.short} currency={c} /> short</span></> : null}; <Money value={w.payables.offerSavings} currency={c} /> early-payment savings on offer</dd>
          </dl>
          <div className="overflow-x-auto"><KpiRows kpis={v.efficiency} c={c} label="Working capital days" /></div>
        </div>
      </Card>
      <Card role="region" aria-label="Tax going out">
        <CardHeader title="Tax going out" description={`Tax payments expected over the next 3 months.${v.tax.overdue ? ` ${v.tax.overdue} payment${v.tax.overdue === 1 ? ' is' : 's are'} overdue.` : ''}`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/tax/forecast`}>Tax forecast</Link>} />
        <div className="overflow-x-auto"><TaxMonths months={v.tax.months} totals={v.tax.totals} c={c} label="Tax payments by month for the CFO" /></div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Treasury: cash by account, 90 days, pay and collect

function Treasury({ v, c, orgId }: { v: TreasuryView; c: string; orgId: string }) {
  const f = v.forecast;
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-4">
        <Card role="region" aria-label="Cash by account">
          <CardHeader title="Cash by account" description="Cash and bank balances from the books today." />
          <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Cash and bank accounts">
            {v.accounts.map((a) => <li key={a.id} className="flex justify-between gap-2 px-5 py-2.5"><span>{a.code} · {a.name}</span><Money value={a.balance} currency={c} signed /></li>)}
            <li className="flex justify-between gap-2 px-5 py-2.5 font-semibold"><span>Total</span><Money value={f.opening} currency={c} signed /></li>
          </ul>
          <div className={cn('m-5 rounded-[var(--t2t-radius-md)] border p-3 text-sm', f.headroom.breaks ? 'border-negative/40 bg-negative/10' : 'border-line')} role="status" aria-label="Headroom">
            <p className="text-xs uppercase tracking-wide text-fg-muted">Headroom at the lowest point</p>
            <p className="num text-xl font-semibold"><Money value={f.headroom.headroom} currency={c} signed /></p>
            <p className="text-xs text-fg-muted">Lowest expected cash on {date(f.headroom.lowestOn)} ({f.headroom.daysToLowest} days away), above a minimum of <Money value={f.minimumBalance} currency={c} />.{f.belowBuffer.base ? ` Falls below the minimum on ${date(f.belowBuffer.base)}.` : ''}</p>
          </div>
        </Card>
        <Card role="region" aria-label="Cash over the next 90 days" className="xl:col-span-3">
          <CardHeader title="Cash over the next 90 days" description={`From the cash forecast: open invoices and bills on the dates they are expected to be paid, and planned items.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/cash-flow`}>Cash forecast</Link>} />
          <p className="px-5 pt-3 text-sm">Expected in 90 days: <Money value={f.closing.base} currency={c} className="font-semibold" /> (likely <Money value={f.closing.low} currency={c} /> to <Money value={f.closing.high} currency={c} />).</p>
          <CashRunwayChart buckets={f.buckets} currency={c} buffer={f.minimumBalance} />
          <div className="overflow-x-auto">
            <Table aria-label="Cash by week">
              <thead><Tr><Th>Week</Th><Th numeric>Money in</Th><Th numeric>Money out</Th><Th numeric>Expected cash</Th><Th numeric>Likely range</Th></Tr></thead>
              <tbody>
                {f.buckets.map((b) => (
                  <Tr key={b.from}><Td className="whitespace-nowrap">{date(b.from)} to {date(b.to)}</Td><Td numeric><Money value={b.inflow} currency={c} /></Td><Td numeric><Money value={b.outflow} currency={c} /></Td><Td numeric className="font-semibold"><Money value={b.closing} currency={c} signed /></Td><Td numeric><Money value={b.low} currency={c} /> to <Money value={b.high} currency={c} /></Td></Tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Bills to pay first">
          <CardHeader title="Bills to pay first" description="From payment priorities: bills in the order to pay them against the cash there is." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/payment-priorities`}>Payment priorities</Link>} />
          <p className="px-5 pt-3 text-sm">Pay now <Money value={v.payments.summary.payNow} currency={c} />, on the due date <Money value={v.payments.summary.onDue} currency={c} />{Number(v.payments.summary.short) > 0 ? <>, <span className="text-negative"><Money value={v.payments.summary.short} currency={c} /> short</span></> : null}.</p>
          {v.payments.bills.length ? (
            <Table aria-label="Bills in payment order">
              <thead><Tr><Th>Vendor</Th><Th>Bill</Th><Th>Due</Th><Th numeric>Amount</Th><Th>Advice</Th></Tr></thead>
              <tbody>{v.payments.bills.map((b) => <Tr key={b.id}><Td>{b.vendor}</Td><Td>{b.number || '—'}</Td><Td className="whitespace-nowrap">{date(b.dueDate)}</Td><Td numeric><Money value={b.due} currency={c} /></Td><Td>{b.actionLabel}</Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No bills are waiting to be paid.</p>}
        </Card>
        <Card role="region" aria-label="Money coming in">
          <CardHeader title="Money coming in" description={`Open invoices customers are expected to pay in the next ${v.collections.days} days, from how each customer has paid before.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/sales/collection-priorities`}>Collection priorities</Link>} />
          <p className="px-5 pt-3 text-sm"><Money value={v.collections.expected} currency={c} className="font-semibold" /> expected from {v.collections.count} invoice{v.collections.count === 1 ? '' : 's'}.</p>
          {v.collections.invoices.length ? (
            <Table aria-label="Invoices expected to be paid">
              <thead><Tr><Th>Customer</Th><Th>Invoice</Th><Th>Expected</Th><Th numeric>Open</Th></Tr></thead>
              <tbody>{v.collections.invoices.map((i) => <Tr key={i.id}><Td>{i.customer}</Td><Td>{i.number}</Td><Td className="whitespace-nowrap">{date(i.expectedOn)}</Td><Td numeric><Money value={i.open} currency={c} /></Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No customer payments are expected in this window.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Risk officer: score, areas, concentration

function RiskOfficer({ v, orgId }: { v: RiskOfficerView; orgId: string }) {
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card role="region" aria-label="Risk score today">
          <CardHeader title="Risk score today" description={v.previous ? `The last earlier reading, on ${date(v.previous.date)}, was ${v.previous.score}.` : 'The first reading; the trend builds up one reading a day.'} />
          <div className="flex flex-col items-center gap-2 px-5 pb-5">
            <RiskGauge score={v.score} level={v.level} />
            {v.history.length > 1 ? <div className="w-full"><Sparkline values={v.history.map((h) => String(h.score))} tone={LEVEL[v.level].colour} /></div> : null}
            {!v.complete ? <p className="text-xs text-fg-muted">Some areas are not open to your role.</p> : null}
          </div>
        </Card>
        <Card role="region" aria-label="Risk by area" className="xl:col-span-2">
          <CardHeader title="Risk by area" description="Each area's score from its own checks, with the high, medium and low findings behind it." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/reports/risk-monitor`}>Risk monitor</Link>} />
          <div className="grid grid-cols-2 gap-2 p-5 md:grid-cols-3" role="list" aria-label="Areas by score">
            {v.areas.map((a) => (
              <Link key={a.area} role="listitem" href={`/orgs/${orgId}${a.href}`} className="rounded-[var(--t2t-radius-md)] border border-line p-3 hover:bg-surface-hover" style={{ borderLeft: `4px solid ${a.available ? LEVEL[a.level].colour : 'var(--t2t-border)'}` }} aria-label={`${a.name}: ${a.available ? `${a.score}, ${LEVEL[a.level].label}` : 'not open to your role'}`}>
                <p className="text-sm font-medium">{a.name}</p>
                <p className="num text-2xl font-semibold">{a.available ? a.score : '—'}</p>
                <p className="text-xs text-fg-muted">{a.available ? `${a.high} high · ${a.medium} medium · ${a.low} low` : 'Not open to your role'}</p>
              </Link>
            ))}
          </div>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Concentration by group">
          <CardHeader title="Concentration by group" description={`How much the business leans on a few parties, ${monthLabel(v.dependencyPeriod.from)} to ${monthLabel(v.dependencyPeriod.to)}. HHI runs from near 0 (spread) to 10,000 (one party).`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/reports/dependencies`}>Financial dependencies</Link>} />
          <Table aria-label="Concentration of each group">
            <thead><Tr><Th>Group</Th><Th numeric>Parties</Th><Th numeric>Largest share</Th><Th numeric>HHI</Th><Th>Concentration</Th></Tr></thead>
            <tbody>
              {v.groups.map((g) => (
                <Tr key={g.group}><Td>{GROUP[g.group]}</Td><Td numeric>{g.count}</Td><Td numeric>{g.largestShare === null ? '—' : `${g.largestShare}%`}</Td><Td numeric>{g.count ? g.hhi : '—'}</Td><Td>{g.concentration ? <Badge tone={g.concentration === 'HIGH' ? 'negative' : g.concentration === 'MODERATE' ? 'warning' : 'positive'}>{g.concentration.toLowerCase()}</Badge> : '—'}</Td></Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card role="region" aria-label="Single dependencies">
          <CardHeader title="Single dependencies" description="One customer, vendor, account or lender carrying a large share of its group." />
          {v.dependencies.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Dependencies by severity">
              {v.dependencies.map((d, i) => <li key={i} className="flex items-start gap-3 px-5 py-2.5"><Badge tone={SEVERITY[d.severity]}>{d.severity.toLowerCase()}</Badge><span>{d.reason}</span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No single party carries a worrying share.</p>}
        </Card>
      </div>
      <Card role="region" aria-label="Findings to look at first">
        <CardHeader title="Findings to look at first" description="The most serious finding of each area, high before medium." />
        <AttentionList items={v.attention} orgId={orgId} empty="No high or medium findings in any area." />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Compliance: deadlines and tax

function Compliance({ v, c, orgId }: { v: ComplianceView; c: string; orgId: string }) {
  const stats: [string, number, 'negative' | 'warning' | 'neutral'][] = [
    ['Overdue', v.summary.overdue, 'negative'],
    ['Due in 7 days', v.summary.dueThisWeek, 'warning'],
    ['High risk of being late', v.summary.high, 'negative'],
    ['Medium risk', v.summary.medium, 'warning'],
  ];
  return (
    <>
      <Card role="region" aria-label="Deadlines at a glance">
        <CardHeader title="Deadlines at a glance" description={v.configured ? `Filings and payments open over the next ${v.days} days, with the risk of each being late from how past ones went.` : 'The compliance calendar is not set up yet, so no deadlines can be shown.'} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/tax/compliance-predictions`}>Deadline risk</Link>} />
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-5">
          {stats.map(([label, count, tone]) => (
            <div key={label} className="rounded-[var(--t2t-radius-md)] border border-line p-4" role="group" aria-label={label}>
              <p className="text-xs uppercase tracking-wide text-fg-muted">{label}</p>
              <p className={cn('num text-3xl font-semibold', count > 0 && (tone === 'negative' ? 'text-negative' : tone === 'warning' ? 'text-warning' : undefined))}>{count}</p>
            </div>
          ))}
          <div className="rounded-[var(--t2t-radius-md)] border border-accent/40 bg-accent/5 p-4" role="group" aria-label="Next deadline">
            <p className="text-xs uppercase tracking-wide text-fg-muted">Next deadline</p>
            {v.next ? <><p className="font-semibold">{v.next.name}</p><p className="text-sm">{v.next.periodLabel}, due {date(v.next.dueDate)} ({v.next.daysLeft} days)</p></> : <p className="text-sm text-fg-muted">None open in the window</p>}
          </div>
        </div>
      </Card>
      <Card role="region" aria-label="Deadlines in the next 60 days">
        <CardHeader title="Deadlines in the next 60 days" description="Overdue ones first, then by due date, with why each one is at risk." />
        {v.deadlines.length ? (
          <div className="overflow-x-auto">
            <Table aria-label="Open deadlines">
              <thead><Tr><Th>Obligation</Th><Th>Period</Th><Th>Due</Th><Th numeric>Days left</Th><Th>Risk</Th><Th>Why</Th></Tr></thead>
              <tbody>
                {v.deadlines.map((d) => (
                  <Tr key={d.key}><Td>{d.name}</Td><Td>{d.periodLabel}</Td><Td className="whitespace-nowrap">{date(d.dueDate)}</Td><Td numeric className={d.daysLeft < 0 ? 'text-negative' : undefined}>{d.daysLeft}</Td><Td><Badge tone={TONE[d.risk]}>{d.risk.toLowerCase()}</Badge></Td><Td className="text-xs">{d.reasons.join(' ') || '—'}</Td></Tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">No filings or payments are open in the next {v.days} days.</p>}
      </Card>
      <Card role="region" aria-label="Tax due in the next 3 months">
        <CardHeader title="Tax due in the next 3 months" description="What each tax payment is expected to be: known from returns and plans, or estimated from past periods." />
        <div className="overflow-x-auto"><TaxMonths months={v.tax.months} totals={v.tax.totals} c={c} label="Tax payments by month for compliance" /></div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Board: quarters and position, no names

function Board({ v, c }: { v: BoardView; c: string }) {
  return (
    <>
      <Card role="region" aria-label="Results by quarter">
        <CardHeader title="Results by quarter" description={`Calendar quarters of the 12 months to ${monthLabel(v.month)}. A quarter with fewer than 3 months started before that.`} />
        <QuarterBars quarters={v.quarters} currency={c} />
        <div className="overflow-x-auto">
          <Table aria-label="Results by quarter figures">
            <thead><Tr><Th>Quarter</Th><Th numeric>Months</Th><Th numeric>Revenue</Th><Th numeric>Growth</Th><Th numeric>Gross profit</Th><Th numeric>Net income</Th><Th numeric>Cash at the end</Th></Tr></thead>
            <tbody>
              {v.quarters.map((q) => (
                <Tr key={q.quarter}><Td>{q.quarter}</Td><Td numeric>{q.months}</Td><Td numeric><Money value={q.revenue} currency={c} /></Td><Td numeric>{q.revenueGrowth === null ? '—' : `${q.revenueGrowth}%`}</Td><Td numeric><Money value={q.grossProfit} currency={c} signed /></Td><Td numeric><Money value={q.netIncome} currency={c} signed /></Td><Td numeric><Money value={q.closingCash} currency={c} signed /></Td></Tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card role="region" aria-label="Financial position" className="xl:col-span-2">
          <CardHeader title="Financial position" description={`${monthLabel(v.month)}: margins, liquidity, leverage and how long the cash lasts.`} />
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">{v.position.map((k) => <KpiTile key={k.key} k={k} c={c} />)}</div>
        </Card>
        <Card role="region" aria-label="Customer concentration">
          <CardHeader title="Customer concentration" description="How much revenue depends on the largest customers over the last 12 months. Customers are not named in this view." />
          <div className="p-5 text-sm">
            <p className="text-lg font-semibold">{BAND[v.concentration.band]}</p>
            <p className="mt-2">The largest customer is {v.concentration.largestShare ?? '—'}% of revenue; the five largest {v.concentration.topFiveShare ?? '—'}%, out of {v.concentration.customers} customer{v.concentration.customers === 1 ? '' : 's'} with revenue.</p>
          </div>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Receivables and payables managers: ageing first

function AgingTable({ aging, c, label }: { aging: Aging; c: string; label: string }) {
  return (
    <Table aria-label={label}>
      <thead><Tr><Th>Age</Th><Th numeric>Items</Th><Th numeric>Open</Th><Th numeric>Share</Th></Tr></thead>
      <tbody>
        {aging.buckets.map((b) => <Tr key={b.bucket}><Td>{AGING_LABEL[b.bucket]}</Td><Td numeric>{b.count}</Td><Td numeric><Money value={b.amount} currency={c} /></Td><Td numeric>{b.share === null ? '—' : `${b.share}%`}</Td></Tr>)}
        <Tr><Td className="font-semibold">Total</Td><Td numeric>{aging.buckets.reduce((t, b) => t + b.count, 0)}</Td><Td numeric className="font-semibold"><Money value={aging.total} currency={c} /></Td><Td /></Tr>
      </tbody>
    </Table>
  );
}

function Receivables({ v, c, orgId }: { v: ReceivablesView; c: string; orgId: string }) {
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card role="region" aria-label="Receivables by age" className="xl:col-span-2">
          <CardHeader title="Receivables by age" description={`What customers owe today, by how far past the due date it is. ${v.dso ? `Days sales outstanding for ${monthLabel(v.month)}: ${formatKpi(v.dso.value, v.dso.unit, c)}.` : ''}`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/sales/ageing`}>Receivables ageing</Link>} />
          <p className="px-5 pt-3 text-sm"><Money value={v.aging.overdue} currency={c} className="font-semibold" /> of <Money value={v.aging.total} currency={c} /> is overdue.{v.doubtful.count ? ` ${v.doubtful.count} invoice${v.doubtful.count === 1 ? ' is' : 's are'} marked doubtful.` : ''}</p>
          <AgingBars aging={v.aging} currency={c} colour={0} />
          <div className="overflow-x-auto"><AgingTable aging={v.aging} c={c} label="Receivables by age figures" /></div>
        </Card>
        <Card role="region" aria-label="Overdue customers">
          <CardHeader title="Overdue customers" description="Every customer with an overdue balance, largest first." />
          {v.overdueCustomers.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Customers with overdue balances">
              {v.overdueCustomers.map((x) => (
                <li key={x.contactId} className="px-5 py-2.5">
                  <div className="flex justify-between gap-2"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${x.contactId}`}>{x.name}</Link><Money value={x.overdue} currency={c} /></div>
                  <p className="text-xs text-fg-muted">{x.invoices} invoice{x.invoices === 1 ? '' : 's'}, the oldest {x.oldestDaysLate} days late</p>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No customer is late.</p>}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Customers to chase first">
          <CardHeader title="Customers to chase first" description={`From collection priorities, scored on how each customer has paid before. ${v.collections.summary.callNow} to call now.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/sales/collection-priorities`}>Collection priorities</Link>} />
          {v.collections.customers.length ? (
            <Table aria-label="Customers in collection order">
              <thead><Tr><Th>Customer</Th><Th numeric>To chase</Th><Th numeric>Days late</Th><Th>Next step</Th></Tr></thead>
              <tbody>{v.collections.customers.map((x) => <Tr key={x.contactId}><Td>{x.name}</Td><Td numeric><Money value={x.toChase} currency={c} /></Td><Td numeric>{x.oldestOverdueDays}</Td><Td>{x.actionLabel}</Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">Nothing scored to chase yet. Priorities are learnt from paid invoices, so they appear as customers pay.</p>}
        </Card>
        <Card role="region" aria-label="Collections by week">
          <CardHeader title="Collections by week" description="Money expected from customers in each of the next 8 weeks, from how each one has paid before, against what the due dates alone say." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/sales/collection-forecast`}>Collection forecast</Link>} />
          <div className="overflow-x-auto">
            <Table aria-label="Expected collections by week">
              <thead><Tr><Th>Week</Th><Th numeric>Invoices</Th><Th numeric>Expected</Th><Th numeric>By due date</Th><Th numeric>Running total</Th></Tr></thead>
              <tbody>
                {v.forecast.weeks.map((w) => <Tr key={w.from}><Td className="whitespace-nowrap">{date(w.from)}</Td><Td numeric>{w.invoices}</Td><Td numeric><Money value={w.expected} currency={c} /></Td><Td numeric><Money value={w.byDueDate} currency={c} /></Td><Td numeric><Money value={w.cumulative} currency={c} /></Td></Tr>)}
                <Tr><Td>Later</Td><Td numeric>{v.forecast.later.invoices}</Td><Td numeric><Money value={v.forecast.later.expected} currency={c} /></Td><Td /><Td /></Tr>
              </tbody>
            </Table>
          </div>
        </Card>
      </div>
    </>
  );
}

function Payables({ v, c, orgId }: { v: PayablesView; c: string; orgId: string }) {
  const p = v.payments.summary;
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card role="region" aria-label="Payables by age" className="xl:col-span-2">
          <CardHeader title="Payables by age" description={`What the business owes vendors today, by how far past the due date it is. ${v.dpo ? `Days payables outstanding for ${monthLabel(v.month)}: ${formatKpi(v.dpo.value, v.dpo.unit, c)}.` : ''}`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/ageing`}>Payables ageing</Link>} />
          <p className="px-5 pt-3 text-sm"><Money value={v.aging.overdue} currency={c} className="font-semibold" /> of <Money value={v.aging.total} currency={c} /> is overdue.</p>
          <AgingBars aging={v.aging} currency={c} colour={3} />
          <div className="overflow-x-auto"><AgingTable aging={v.aging} c={c} label="Payables by age figures" /></div>
        </Card>
        <div className="grid gap-4">
          <Card role="region" aria-label="Held bills">
            <CardHeader title="Held bills" description="Draft bills that do not match their purchase order and receipts." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/bill-exceptions`}>Bill exceptions</Link>} />
            <p className="px-5 pt-3 text-sm">{v.exceptions.summary.bills} held, <Money value={v.exceptions.summary.atStake} currency={c} /> at stake{v.exceptions.summary.bills ? `, the oldest ${v.exceptions.summary.oldestDays} days` : ''}.</p>
            <ul className="flex flex-col gap-1 px-5 py-3 text-sm" aria-label="Held bills by next step">
              {v.exceptions.items.map((i) => <li key={i.id}>{i.vendor} ({i.order}): <Money value={i.atStake} currency={c} />, {i.nextActionLabel.toLowerCase()}</li>)}
            </ul>
          </Card>
          <Card role="region" aria-label="Payment checks">
            <CardHeader title="Payment checks" description={`Vendor payments of the last ${v.fraud.windowDays} days and batches waiting, checked for signs of fraud.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/payment-fraud`}>Payment fraud checks</Link>} />
            <p className="px-5 pt-3 text-sm">{v.fraud.summary.checked} checked, {v.fraud.summary.flagged} flagged ({v.fraud.summary.high} high).</p>
            <ul className="flex flex-col gap-1 px-5 py-3 text-sm" aria-label="Flagged payments">
              {v.fraud.payments.map((x, i) => <li key={i} className="flex items-center gap-2">{x.level ? <Badge tone={TONE[x.level]}>{x.level.toLowerCase()}</Badge> : null}{x.vendor}, <Money value={x.amount} currency={x.currency} /> on {date(x.date)}</li>)}
            </ul>
          </Card>
        </div>
      </div>
      <Card role="region" aria-label="Bills to pay, in order">
        <CardHeader title="Bills to pay, in order" description="From payment priorities: what to pay now, what to pay on the due date and what is blocked, against the cash there is." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/payment-priorities`}>Payment priorities</Link>} />
        <p className="px-5 pt-3 text-sm">Pay now <Money value={p.payNow} currency={c} />, on the due date <Money value={p.onDue} currency={c} />, blocked <Money value={p.blocked} currency={c} />{Number(p.short) > 0 ? <>, <span className="text-negative"><Money value={p.short} currency={c} /> short</span></> : null}. {p.offers ? <>{p.offers} early-payment offer{p.offers === 1 ? '' : 's'} worth <Money value={p.offerSavings} currency={c} />.</> : null}</p>
        {v.payments.bills.length ? (
          <Table aria-label="Bills for the payables manager">
            <thead><Tr><Th>Vendor</Th><Th>Bill</Th><Th>Due</Th><Th numeric>Amount</Th><Th>Advice</Th></Tr></thead>
            <tbody>{v.payments.bills.map((b) => <Tr key={b.id}><Td>{b.vendor}</Td><Td>{b.number || '—'}</Td><Td className="whitespace-nowrap">{date(b.dueDate)}</Td><Td numeric><Money value={b.due} currency={c} /></Td><Td>{b.actionLabel}</Td></Tr>)}</tbody>
          </Table>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">No bills are waiting to be paid.</p>}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Tax manager: payments, returns, GST check

function TaxManager({ v, c, orgId }: { v: TaxManagerView; c: string; orgId: string }) {
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card role="region" aria-label="Tax by area">
          <CardHeader title="Tax by area" description="Tax expected over the next 3 months, by tax." />
          {v.byArea.length ? (
            <Table aria-label="Tax expected by area">
              <thead><Tr><Th>Tax</Th><Th numeric>Payments</Th><Th numeric>Expected</Th></Tr></thead>
              <tbody>
                {v.byArea.map((a) => <Tr key={a.area}><Td>{a.area}</Td><Td numeric>{a.payments}</Td><Td numeric><Money value={a.amount} currency={c} /></Td></Tr>)}
                <Tr><Td className="font-semibold">Total</Td><Td /><Td numeric className="font-semibold"><Money value={v.payments.totals.amount} currency={c} /></Td></Tr>
              </tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">{v.configured ? 'No tax payments expected in the next 3 months.' : 'Set up the compliance calendar to see tax payments.'}</p>}
        </Card>
        <Card role="region" aria-label="GST books against documents" className="xl:col-span-2">
          <CardHeader title="GST books against documents" description={`Whether the GST accounts agree with the invoices and bills of ${monthLabel(v.gst.period)}, and the mistakes found in them.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/tax/gst-reconciliation?period=${v.gst.period}`}>GST reconciliation</Link>} />
          {v.gst.registered ? (
            <dl className="grid gap-3 p-5 text-sm sm:grid-cols-4">
              <div><dt className="text-fg-muted">Result</dt><dd>{v.gst.agrees ? <Badge tone="positive">agrees</Badge> : <Badge tone="negative">differs</Badge>}</dd></div>
              <div><dt className="text-fg-muted">Difference</dt><dd><Money value={v.gst.difference} currency={c} signed /></dd></div>
              <div><dt className="text-fg-muted">Documents checked</dt><dd className="num">{v.gst.documentsChecked}</dd></div>
              <div><dt className="text-fg-muted">Mistakes found</dt><dd>{v.gst.discrepancies.high} high · {v.gst.discrepancies.medium} medium · {v.gst.discrepancies.low} low</dd></div>
            </dl>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No GST registration is set up, so there is nothing to reconcile. Add it under Settings → GST.</p>}
        </Card>
      </div>
      <Card role="region" aria-label="Tax payments due">
        <CardHeader title="Tax payments due" description={`Each payment expected over the next 3 months, how it was worked out and its likely range.${v.payments.overdue ? ` ${v.payments.overdue} overdue.` : ''}`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/tax/forecast`}>Tax forecast</Link>} />
        {v.payments.items.length ? (
          <div className="overflow-x-auto">
            <Table aria-label="Tax payments for the tax manager">
              <thead><Tr><Th>Payment</Th><Th>Period</Th><Th>Due</Th><Th>Basis</Th><Th numeric>Expected</Th><Th numeric>Range</Th></Tr></thead>
              <tbody>{v.payments.items.map((i) => <Tr key={i.key}><Td>{i.name}</Td><Td>{i.periodLabel}</Td><Td className="whitespace-nowrap">{date(i.dueDate)}</Td><Td>{i.method.toLowerCase()}</Td><Td numeric><Money value={i.amount} currency={c} /></Td><Td numeric><Money value={i.low} currency={c} /> to <Money value={i.high} currency={c} /></Td></Tr>)}</tbody>
            </Table>
          </div>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">No tax payments expected in the next 3 months.</p>}
      </Card>
      <Card role="region" aria-label="Returns and their risk">
        <CardHeader title="Returns and their risk" description="Filings and payments open over the next 60 days, with what the books say before each one." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/tax/compliance-predictions`}>Deadline risk</Link>} />
        {v.returns.length ? (
          <div className="overflow-x-auto">
            <Table aria-label="Returns by due date">
              <thead><Tr><Th>Return or payment</Th><Th>Period</Th><Th>Due</Th><Th numeric>Days left</Th><Th>Risk</Th><Th>Before filing</Th></Tr></thead>
              <tbody>{v.returns.map((x) => <Tr key={x.key}><Td>{x.name}</Td><Td>{x.periodLabel}</Td><Td className="whitespace-nowrap">{date(x.dueDate)}</Td><Td numeric className={x.daysLeft < 0 ? 'text-negative' : undefined}>{x.daysLeft}</Td><Td><Badge tone={TONE[x.risk]}>{x.risk.toLowerCase()}</Badge></Td><Td className="text-xs">{x.signals.join(' ') || '—'}</Td></Tr>)}</tbody>
            </Table>
          </div>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">{v.configured ? 'No filings or payments open in the next 60 days.' : 'Set up the compliance calendar to see returns.'}</p>}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Expense manager: decisions, risk, receipts, budgets

const BUDGET = { OVER: { label: 'Over budget', tone: 'negative' }, AT_RISK: { label: 'At risk', tone: 'warning' }, ON_TRACK: { label: 'On track', tone: 'positive' }, NO_BUDGET: { label: 'No budget', tone: 'neutral' } } as const;

function ExpenseManager({ v, c, orgId }: { v: ExpenseManagerView; c: string; orgId: string }) {
  const tiles: [string, string, boolean][] = [
    ['Claims waiting', String(v.approvals.count), v.approvals.count > 0],
    ['Oldest waiting', `${v.approvals.oldestDays} days`, v.approvals.oldestDays > 7],
    ['High-risk claims', String(v.risk.summary.high), v.risk.summary.high > 0],
    ['Spend without a receipt', String(v.receipts.missing), v.receipts.missing > 0],
  ];
  return (
    <>
      <Card role="region" aria-label="Expenses at a glance">
        <CardHeader title="Expenses at a glance" description="Claims waiting for a decision, risky claims of the last 90 days and card or bank spending of the last 30 days without a receipt." />
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map(([label, value, warn]) => (
            <div key={label} className="rounded-[var(--t2t-radius-md)] border border-line p-4" role="group" aria-label={label}>
              <p className="text-xs uppercase tracking-wide text-fg-muted">{label}</p>
              <p className={cn('num text-3xl font-semibold', warn && 'text-warning')}>{value}</p>
            </div>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Claims waiting for a decision">
          <CardHeader title="Claims waiting for a decision" description={v.approvals.totals.length ? `Oldest first. ${v.approvals.totals.map((t) => money(t.amount, t.currency)).join(', ')} in all.` : 'Oldest first.'} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/expenses`}>Expense claims</Link>} />
          {v.approvals.claims.length ? (
            <Table aria-label="Claims to decide">
              <thead><Tr><Th>Claim</Th><Th>Who</Th><Th>Submitted</Th><Th numeric>Total</Th></Tr></thead>
              <tbody>{v.approvals.claims.map((x) => <Tr key={x.id}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/${x.id}`}>{x.title}</Link></Td><Td>{x.claimant}</Td><Td className="whitespace-nowrap">{x.submittedOn ? date(x.submittedOn) : '—'}</Td><Td numeric><Money value={x.total} currency={x.currency} /></Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No claims are waiting.</p>}
        </Card>
        <Card role="region" aria-label="Riskiest claims">
          <CardHeader title="Riskiest claims" description={`${v.risk.summary.flagged} of ${v.risk.summary.claims} claims of the last 90 days show signs of risk.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/expenses/risk`}>Expense risk</Link>} />
          {v.risk.items.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Claims by risk">
              {v.risk.items.map((x) => (
                <li key={x.claimId} className="flex items-start gap-3 px-5 py-2.5">
                  <Badge tone={TONE[x.level]}>{x.level.toLowerCase()}</Badge>
                  <div><p>{x.title} · {x.claimant} · <Money value={x.total} currency={x.currency} /></p><p className="text-xs text-fg-muted">{x.indicators.join(' ')}</p></div>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No claim shows signs of risk.</p>}
        </Card>
      </div>
      <Card role="region" aria-label="Budgets by department">
        <CardHeader title="Budgets by department" description={`Approved expense claims against each department's budget for the ${v.budgets.fiscalYear} financial year, with claims still waiting counted as committed.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/expenses/department-budgets`}>Department budgets</Link>} />
        {v.budgets.rows.length ? (
          <div className="overflow-x-auto">
            <Table aria-label="Department budget use">
              <thead><Tr><Th>Department</Th><Th numeric>Budget</Th><Th numeric>Spent</Th><Th numeric>Waiting</Th><Th numeric>Used</Th><Th>Status</Th></Tr></thead>
              <tbody>
                {v.budgets.rows.map((r) => {
                  const st = BUDGET[r.status as keyof typeof BUDGET] ?? BUDGET.NO_BUDGET;
                  return <Tr key={r.departmentId}><Td>{r.name}</Td><Td numeric>{r.budget === null ? '—' : <Money value={r.budget} currency={c} />}</Td><Td numeric><Money value={r.actual} currency={c} /></Td><Td numeric><Money value={r.committed} currency={c} /></Td><Td numeric>{r.usedPercent === null ? '—' : `${r.usedPercent}%`}</Td><Td><Badge tone={st.tone}>{st.label}</Badge></Td></Tr>;
                })}
              </tbody>
            </Table>
          </div>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">No departments yet. Add them under Dimensions and set budgets on Department budgets.</p>}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Accountant and controller: the books and the close

const CLOSE = { CLOSED: { label: 'Closed', tone: 'positive' }, IN_PROGRESS: { label: 'In progress', tone: 'warning' }, NOT_STARTED: { label: 'Not started', tone: 'neutral' } } as const;
const KIND: Record<string, string> = { INVOICE: 'Invoices', BILL: 'Bills', CREDIT_NOTE: 'Credit notes', VENDOR_CREDIT: 'Vendor credits' };

function CloseTable({ rows, label, orgId }: { rows: CloseRow[]; label: string; orgId: string }) {
  return (
    <Table aria-label={label}>
      <thead><Tr><Th>Month</Th><Th>Close</Th><Th>Closed by</Th></Tr></thead>
      <tbody>
        {rows.map((p) => {
          const st = CLOSE[p.closeStatus as keyof typeof CLOSE] ?? { label: p.closeStatus.toLowerCase(), tone: 'neutral' as const };
          return <Tr key={p.id}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/close/${p.id}`}>{p.name}</Link>{p.current ? <span className="ml-2 text-xs text-fg-muted">this month</span> : null}</Td><Td><Badge tone={st.tone}>{st.label}</Badge></Td><Td>{p.closedBy ? `${p.closedBy}${p.closedAt ? `, ${date(p.closedAt.slice(0, 10))}` : ''}` : '—'}</Td></Tr>;
        })}
      </tbody>
    </Table>
  );
}

function ApprovalsList({ a, c, orgId }: { a: PendingApprovals; c: string; orgId: string }) {
  if (!a.items.length) return <p className="px-5 py-4 text-sm text-fg-muted">No journals are waiting for approval.</p>;
  return (
    <Table aria-label="Journals waiting for approval">
      <thead><Tr><Th>Journal</Th><Th>Asked by</Th><Th numeric>Total</Th><Th>You can decide</Th></Tr></thead>
      <tbody>{a.items.map((x) => <Tr key={x.id}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${x.entryId}`}>{x.memo ?? 'Journal'}</Link>{x.date ? <span className="block text-xs text-fg-muted">{date(x.date)}</span> : null}</Td><Td>{x.requestedBy ?? '—'}</Td><Td numeric><Money value={x.total} currency={c} /></Td><Td>{x.canDecide ? 'Yes' : 'No'}</Td></Tr>)}</tbody>
    </Table>
  );
}

function Counter({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="rounded-[var(--t2t-radius-md)] border border-line p-4" role="group" aria-label={label}>
      <p className="text-xs uppercase tracking-wide text-fg-muted">{label}</p>
      <p className={cn('num text-3xl font-semibold', warn && 'text-warning')}>{value}</p>
    </div>
  );
}

function Accountant({ v, c, orgId }: { v: AccountantView; c: string; orgId: string }) {
  return (
    <>
      <Card role="region" aria-label="Work waiting">
        <CardHeader title="Work waiting" description="What is waiting to be posted, approved or reconciled before the books are up to date." />
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
          <Counter label="Draft journals" value={v.queue.draftJournals} warn={v.queue.draftJournals > 0} />
          <Counter label="Draft invoices and bills" value={v.queue.draftDocuments} warn={v.queue.draftDocuments > 0} />
          <Counter label="Journals awaiting approval" value={v.queue.approvals} warn={v.queue.approvals > 0} />
          <Counter label="Bank lines to sort out" value={v.queue.reconciliation} warn={v.queue.reconciliation > 0} />
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Unposted journals">
          <CardHeader title="Unposted journals" description={`Draft journals, oldest first.${v.draftDocuments.length ? ` Also in draft: ${v.draftDocuments.map((d) => `${d.count} ${(KIND[d.kind] ?? d.kind).toLowerCase()}`).join(', ')}.` : ''}`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/journals`}>Journals</Link>} />
          {v.draftJournals.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Draft journals">
              {v.draftJournals.map((j) => <li key={j.id} className="flex justify-between gap-2 px-5 py-2.5"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${j.id}`}>{j.memo ?? 'Journal without a memo'}</Link><span className="text-fg-muted">{date(j.date)}</span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No draft journals.</p>}
        </Card>
        <Card role="region" aria-label="Journal approvals waiting">
          <CardHeader title="Journal approvals waiting" description={`${v.approvals.count} waiting, ${v.approvals.mine} of them for you to decide.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/approvals`}>Approvals</Link>} />
          <ApprovalsList a={v.approvals} c={c} orgId={orgId} />
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Bank lines to reconcile">
          <CardHeader title="Bank lines to reconcile" description={`${v.reconciliation.summary.needsAction} exception${v.reconciliation.summary.needsAction === 1 ? '' : 's'} to act on across ${v.reconciliation.summary.accountsWithExceptions} of ${v.reconciliation.summary.accounts} bank account${v.reconciliation.summary.accounts === 1 ? '' : 's'}.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/banking/reconciliation-exceptions`}>Reconciliation exceptions</Link>} />
          {v.reconciliation.accounts.length ? (
            <Table aria-label="Bank accounts to reconcile">
              <thead><Tr><Th>Account</Th><Th numeric>Exceptions</Th><Th numeric>Statement lines</Th><Th numeric>Book entries</Th><Th>Last reconciled</Th></Tr></thead>
              <tbody>{v.reconciliation.accounts.map((a) => <Tr key={a.id}><Td>{a.code} · {a.name}</Td><Td numeric>{a.exceptions}</Td><Td numeric>{a.unmatchedStatement}</Td><Td numeric>{a.unmatchedBook}</Td><Td>{a.lastReconciled ? date(a.lastReconciled) : 'Never'}</Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No bank accounts with statement lines yet.</p>}
        </Card>
        <Card role="region" aria-label="Recent closes">
          <CardHeader title="Recent closes" description="This month and the two before it, and where each close stands." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/close`}>Month-end close</Link>} />
          <CloseTable rows={v.close} label="Closes for the accountant" orgId={orgId} />
        </Card>
      </div>
    </>
  );
}

function Controller({ v, c, orgId }: { v: ControllerView; c: string; orgId: string }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" role="list" aria-label="Control figures">
        <div role="listitem"><Counter label="Past months not closed" value={v.lateCloses} warn={v.lateCloses > 0} /></div>
        <div role="listitem"><Counter label="Duty conflicts to review" value={v.separation.open} warn={v.separation.open > 0} /></div>
        <div role="listitem"><Counter label="Controls failed or overdue" value={v.controls.summary.failed + v.controls.summary.overdue} warn={v.controls.summary.failed + v.controls.summary.overdue > 0} /></div>
        <div role="listitem"><Counter label="Open audit findings" value={v.findings.open} warn={v.findings.high > 0} /></div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Months closed">
          <CardHeader title="Months closed" description="The last six months and whether each was closed and certified." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/close`}>Month-end close</Link>} />
          <CloseTable rows={v.closes} label="Closes for the controller" orgId={orgId} />
        </Card>
        <Card role="region" aria-label="Duties held apart">
          <CardHeader title="Duties held apart" description={`Where one person did two steps that should be done by different people, ${date(v.separation.from)} to ${date(v.separation.to)}. ${v.separation.membersWithConflicts} member${v.separation.membersWithConflicts === 1 ? ' has' : 's have'} a role that allows conflicting steps.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/segregation-of-duties`}>Segregation of duties</Link>} />
          <Table aria-label="Duty conflicts by rule">
            <thead><Tr><Th>Rule</Th><Th numeric>To review</Th><Th numeric>Reviewed</Th></Tr></thead>
            <tbody>{v.separation.rules.map((r) => <Tr key={r.id}><Td>{r.title}</Td><Td numeric className={r.open ? 'text-warning' : undefined}>{r.open}</Td><Td numeric>{r.reviewed}</Td></Tr>)}</tbody>
          </Table>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Controls to look at">
          <CardHeader title="Controls to look at" description={`${v.controls.total} control${v.controls.total === 1 ? '' : 's'} on record: ${v.controls.summary.passed} passed, ${v.controls.summary.due} due, ${v.controls.summary.overdue} overdue, ${v.controls.summary.failed} failed. Audit findings: ${v.findings.open} open, ${v.findings.overdue} overdue, ${v.findings.readyForReview} ready to review.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/controls`}>Internal controls</Link>} />
          {v.controls.attention.length ? (
            <Table aria-label="Controls failed or overdue">
              <thead><Tr><Th>Control</Th><Th>Owner</Th><Th>Period</Th><Th>Status</Th></Tr></thead>
              <tbody>{v.controls.attention.map((x) => <Tr key={x.id}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/controls/${x.id}`}>{x.title}</Link></Td><Td>{x.owner}</Td><Td>{x.period}</Td><Td><Badge tone={x.status === 'FAILED' ? 'negative' : 'warning'}>{x.status.toLowerCase()}</Badge></Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No control has failed or is overdue.</p>}
        </Card>
        <Card role="region" aria-label="Approvals for the controller">
          <CardHeader title="Approvals for the controller" description={`Journals waiting for a second person: ${v.approvals.count}, ${v.approvals.mine} of them yours to decide.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/approvals`}>Approvals</Link>} />
          <ApprovalsList a={v.approvals} c={c} orgId={orgId} />
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Internal auditor

function InternalAuditor({ v, orgId }: { v: InternalAuditorView; orgId: string }) {
  return (
    <>
      <Card role="region" aria-label="Findings at a glance">
        <CardHeader title="Findings at a glance" description="Audit findings, evidence requests and control tests across the organisation." />
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
          <Counter label="Open findings" value={v.findings.summary.open} warn={v.findings.summary.open > 0} />
          <Counter label="High findings" value={v.findings.summary.high} warn={v.findings.summary.high > 0} />
          <Counter label="Evidence overdue" value={v.evidence.summary.overdue} warn={v.evidence.summary.overdue > 0} />
          <Counter label="Controls failed" value={v.controls.summary.failed} warn={v.controls.summary.failed > 0} />
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Findings to follow up">
          <CardHeader title="Findings to follow up" description={`Ready for review first. ${v.findings.summary.overdue} overdue, ${v.findings.summary.readyForReview} ready for review.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/audit-findings`}>Audit findings</Link>} />
          {v.findings.open.length ? (
            <Table aria-label="Open audit findings">
              <thead><Tr><Th>Finding</Th><Th>Severity</Th><Th>Status</Th><Th>Due</Th></Tr></thead>
              <tbody>{v.findings.open.map((f) => <Tr key={f.id}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/audit-findings/${f.id}`}>{f.reference} · {f.title}</Link></Td><Td><Badge tone={TONE[f.severity]}>{f.severity.toLowerCase()}</Badge></Td><Td>{f.status.replace(/_/g, ' ').toLowerCase()}</Td><Td className={cn('whitespace-nowrap', f.overdue && 'text-negative')}>{date(f.dueDate)}</Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No open findings.</p>}
        </Card>
        <Card role="region" aria-label="Audits in progress">
          <CardHeader title="Audits in progress" description={`${v.engagementCount} audit${v.engagementCount === 1 ? '' : 's'} on record; those not closed are below.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/audit-engagements`}>Internal audit</Link>} />
          {v.engagements.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Audits by progress">
              {v.engagements.map((e) => (
                <li key={e.id} className="px-5 py-2.5">
                  <div className="flex justify-between gap-2"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/audit-engagements/${e.id}`}>{e.reference} · {e.name}</Link><span className="text-xs text-fg-muted">{e.status.toLowerCase()}</span></div>
                  <p className="text-xs text-fg-muted">Led by {e.lead}; {e.progress.done} of {e.progress.steps} steps done, {e.progress.signedOff} signed off</p>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No audit is in progress.</p>}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Evidence outstanding">
          <CardHeader title="Evidence outstanding" description={`${v.evidence.summary.requested} requested, ${v.evidence.summary.submitted} submitted for review, ${v.evidence.summary.accepted} accepted.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/audit-evidence`}>Audit evidence</Link>} />
          {v.evidence.outstanding.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Evidence requests not accepted">
              {v.evidence.outstanding.map((r) => <li key={r.id} className="flex justify-between gap-2 px-5 py-2.5"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/audit-evidence/${r.id}`}>{r.reference} · {r.title}</Link><span className="text-fg-muted">{r.status.toLowerCase()}, due {date(r.dueDate)}</span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No evidence is outstanding.</p>}
        </Card>
        <Card role="region" aria-label="Failed controls">
          <CardHeader title="Failed controls" description={`Controls whose test for the current period failed, out of ${v.controls.total} on record.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/controls`}>Internal controls</Link>} />
          {v.controls.failed.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Controls that failed">
              {v.controls.failed.map((x) => <li key={x.id} className="px-5 py-2.5"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/controls/${x.id}`}>{x.title}</Link><span className="block text-xs text-fg-muted">Owner {x.owner}{x.lastTest ? `; tested ${date(x.lastTest.testedAt.slice(0, 10))}` : ''}</span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No control has failed.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Procurement manager

function Procurement({ v, c, orgId }: { v: ProcurementView; c: string; orgId: string }) {
  const t = v.orders.totals;
  return (
    <>
      <Card role="region" aria-label="Open purchase orders">
        <CardHeader title="Open purchase orders" description={`${t.open} issued and open, ${t.drafts} in draft, ${t.late} late. Still to receive ${money(t.toReceive, c)}; still to bill ${money(t.toBill, c)}.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders`}>Purchase orders</Link>} />
        {v.orders.open.length ? (
          <div className="overflow-x-auto">
            <Table aria-label="Open orders">
              <thead><Tr><Th>Order</Th><Th>Vendor</Th><Th>Ordered</Th><Th>Expected</Th><Th numeric>To receive</Th><Th numeric>To bill</Th><Th numeric>Total</Th></Tr></thead>
              <tbody>{v.orders.open.map((o) => <Tr key={o.id}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders/${o.id}`}>{o.reference}</Link></Td><Td>{o.vendor}</Td><Td className="whitespace-nowrap">{date(o.orderDate)}</Td><Td className={cn('whitespace-nowrap', o.late && 'text-negative')}>{o.expectedDate ? date(o.expectedDate) : '—'}{o.late ? ' (late)' : ''}</Td><Td numeric><Money value={o.toReceive} currency={c} /></Td><Td numeric><Money value={o.toBill} currency={c} /></Td><Td numeric><Money value={o.total} currency={c} /></Td></Tr>)}</tbody>
            </Table>
          </div>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">No open purchase orders.</p>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card role="region" aria-label="Late deliveries">
          <CardHeader title="Late deliveries" description="Issued orders past their expected date with goods still to receive." />
          {v.orders.late.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Orders delivered late">
              {v.orders.late.map((o) => <li key={o.id} className="px-5 py-2.5"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders/${o.id}`}>{o.reference}</Link> · {o.vendor}<span className="block text-xs text-fg-muted">Expected {o.expectedDate ? date(o.expectedDate) : '—'}; <Money value={o.toReceive} currency={c} /> to receive</span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No deliveries are late.</p>}
        </Card>
        <Card role="region" aria-label="Contracts ending or breached">
          <CardHeader title="Contracts ending or breached" description={`${v.contracts.summary.inForce} of ${v.contracts.summary.contracts} contracts in force; ${v.contracts.summary.issues} issue${v.contracts.summary.issues === 1 ? '' : 's'} on bills, ${money(v.contracts.summary.overcharge, c)} overcharged. ${v.heldBills.bills} bill${v.heldBills.bills === 1 ? '' : 's'} held against orders.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendor-contracts`}>Vendor contracts</Link>} />
          <ul className="flex flex-col gap-1.5 px-5 py-3 text-sm" aria-label="Contracts to act on">
            {v.contracts.ending.map((x) => <li key={x.id}>{x.reference} · {x.vendor}: ends {date(x.endDate)}</li>)}
            {v.contracts.issues.map((x, i) => <li key={`i${i}`} className="flex items-start gap-2"><Badge tone={TONE[x.severity]}>{x.severity.toLowerCase()}</Badge><span>{x.contract} · {x.vendor}: {x.detail}</span></li>)}
            {!v.contracts.ending.length && !v.contracts.issues.length ? <li className="text-fg-muted">No contract ends in the next 60 days and no bill breaks one.</li> : null}
          </ul>
        </Card>
        <Card role="region" aria-label="Vendors at risk">
          <CardHeader title="Vendors at risk" description={`${v.vendors.totals.high} high and ${v.vendors.totals.medium} medium risk out of ${v.vendors.totals.vendors} vendors.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendor-risk`}>Vendor risk</Link>} />
          {v.vendors.risky.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Vendors by risk">
              {v.vendors.risky.map((x) => <li key={x.id} className="flex items-start gap-2 px-5 py-2.5"><Badge tone={TONE[x.level]}>{x.level.toLowerCase()}</Badge><span>{x.name}<span className="block text-xs text-fg-muted">{x.factors.join(', ')}</span></span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No vendor carries high or medium risk.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Payroll manager

const RUN_TONE: Record<string, 'positive' | 'warning' | 'neutral'> = { POSTED: 'positive', DRAFT: 'warning' };

function PayrollManager({ v, c, orgId }: { v: PayrollManagerView; c: string; orgId: string }) {
  const t = v.thisMonth;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label={`Pay run for ${monthLabel(v.month)}`} value={t ? (t.status === 'POSTED' ? 'Posted' : 'Draft') : 'Not started'} warn={!t || t.status !== 'POSTED'} />
        <Counter label="People on payroll" value={v.team.active} />
        <Counter label="Dues not yet paid" value={v.unpaid.items.length} warn={v.unpaid.overdue > 0} />
        <Counter label="Payroll cost, last 12 months" value={money(v.cost.totals.employerCost, c)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Latest pay runs">
          <CardHeader title="Latest pay runs" description={t ? `${t.number} for ${monthLabel(v.month)} is ${t.status === 'POSTED' ? 'posted' : 'a draft'}: ${t.employees} people, ${money(t.net, c)} net pay on ${date(t.payDate)}.` : `No pay run for ${monthLabel(v.month)} yet.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs`}>All pay runs</Link>} />
          {v.runs.length ? (
            <Table aria-label="Pay runs, newest first">
              <thead><Tr><Th>Run</Th><Th>Month</Th><Th>Status</Th><Th numeric>People</Th><Th numeric>Gross</Th><Th numeric>Net</Th></Tr></thead>
              <tbody>{v.runs.map((r) => <Tr key={r.id}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs/${r.id}`}>{r.number}</Link></Td><Td>{monthLabel(r.period)}</Td><Td><Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge></Td><Td numeric>{r.employees}</Td><Td numeric><Money value={r.gross} currency={c} /></Td><Td numeric><Money value={r.net} currency={c} /></Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No pay runs yet.</p>}
          {v.drafts.some((d) => d.missing > 0) ? <p className="px-5 py-3 text-sm text-warning">{v.drafts.filter((d) => d.missing > 0).map((d) => `${d.number}: ${d.missing} ${d.missing === 1 ? 'person has' : 'people have'} no salary set up`).join('; ')}.</p> : null}
        </Card>
        <Card role="region" aria-label="Salaries and dues to pay">
          <CardHeader title="Salaries and dues to pay" description={v.unpaid.items.length ? `${money(v.unpaid.total, c)} from posted runs is not yet paid${v.unpaid.overdue ? `; ${v.unpaid.overdue} past the due date` : ''}.` : 'Net pay and statutory dues of the latest posted runs.'} />
          {v.unpaid.items.length ? (
            <Table aria-label="Unpaid salaries and dues">
              <thead><Tr><Th>Run</Th><Th>What</Th><Th>Due</Th><Th numeric>Amount</Th></Tr></thead>
              <tbody>{v.unpaid.items.map((u) => <Tr key={`${u.runId}-${u.liability}`}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs/${u.runId}`}>{u.number}</Link> <span className="text-xs text-fg-muted">{monthLabel(u.period)}</span></Td><Td>{u.label}</Td><Td className={cn('whitespace-nowrap', u.overdue && 'text-negative')}>{u.dueDate ? date(u.dueDate) : '—'}{u.overdue ? ' (late)' : ''}</Td><Td numeric><Money value={u.amount} currency={c} /></Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">Every salary and due of the posted runs is paid.</p>}
        </Card>
      </div>
      <Card role="region" aria-label="Payroll cost by month">
        <CardHeader title="Payroll cost by month" description={`Posted pay runs from ${monthLabel(v.cost.from)} to ${monthLabel(v.cost.to)}: ${money(v.cost.totals.gross, c)} gross and ${money(v.cost.totals.employerContributions, c)} employer contributions. A change in gross of a fifth or more from the month before is flagged.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/reports/payroll`}>Payroll report</Link>} />
        {v.cost.byMonth.length ? (
          <>
            <PayrollCostBars months={v.cost.byMonth} currency={c} />
            <Table aria-label="Payroll by month">
              <thead><Tr><Th>Month</Th><Th numeric>People</Th><Th numeric>Gross</Th><Th numeric>Net</Th><Th numeric>Employer cost</Th><Th numeric>Change in gross</Th></Tr></thead>
              <tbody>{v.cost.byMonth.map((m) => <Tr key={m.period}><Td>{monthLabel(m.period)}</Td><Td numeric>{m.employees}</Td><Td numeric><Money value={m.gross} currency={c} /></Td><Td numeric><Money value={m.net} currency={c} /></Td><Td numeric><Money value={m.employerCost} currency={c} /></Td><Td numeric className={cn(m.flagged && 'text-warning')}>{m.grossChange === null ? '—' : `${m.grossChange}%`}{m.flagged ? ' (check)' : ''}</Td></Tr>)}</tbody>
            </Table>
          </>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">No posted pay runs in these months.</p>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Statutory contributions">
          <CardHeader title="Statutory contributions" description={`Provident fund, ESI, professional tax and TDS withheld from salaries and paid by the employer, ${monthLabel(v.cost.from)} to ${monthLabel(v.cost.to)}.`} />
          <Table aria-label="Contributions by kind">
            <thead><Tr><Th>Contribution</Th><Th numeric>From employees</Th><Th numeric>From employer</Th><Th numeric>Total</Th></Tr></thead>
            <tbody>{v.cost.statutory.map((x) => <Tr key={x.key}><Td>{x.label}</Td><Td numeric><Money value={x.employee} currency={c} /></Td><Td numeric><Money value={x.employer} currency={c} /></Td><Td numeric><Money value={x.total} currency={c} /></Td></Tr>)}</tbody>
          </Table>
        </Card>
        <Card role="region" aria-label="Joiners and leavers">
          <CardHeader title="Joiners and leavers" description={`Who joined or leaves in ${monthLabel(v.month)}, and who is yet to join.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/payroll/employees`}>Employees</Link>} />
          <ul className="flex flex-col gap-1.5 px-5 py-3 text-sm" aria-label="People joining and leaving">
            {v.team.joinedThisMonth.map((p) => <li key={`j${p.id}`}>{p.name}: joined {date(p.date)}</li>)}
            {v.team.joining.map((p) => <li key={`f${p.id}`}>{p.name}: joins {date(p.date)}</li>)}
            {v.team.leavingThisMonth.map((p) => <li key={`l${p.id}`}>{p.name}: leaves {date(p.date)}</li>)}
            {!v.team.joinedThisMonth.length && !v.team.joining.length && !v.team.leavingThisMonth.length ? <li className="text-fg-muted">Nobody joins or leaves this month.</li> : null}
          </ul>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- AI agent administrator

const tokens = (x: number) => x.toLocaleString('en-IN');

function AiAdmin({ v, orgId }: { v: AiAdminView; orgId: string }) {
  const state = v.platformStopped ? 'Stopped for everyone' : v.stopped ? 'Stopped' : !v.configured ? 'No AI key' : v.enabled ? 'On' : 'Off';
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="AI for this organisation" value={state} warn={state !== 'On'} />
        <Counter label="AI calls this month" value={v.totals.calls} />
        <Counter label="Failed calls this month" value={v.totals.failed} warn={v.totals.failed > 0} />
        <Counter label="Suggestions waiting" value={v.totals.waiting} />
      </div>
      <Card role="region" aria-label="Agents and budgets">
        <CardHeader title="Agents and budgets" description={`Each agent's calls and tokens in ${monthLabel(v.month)} against its monthly budget, and what it cost at the prices you set (${v.totals.cost} ${v.currency}${v.totals.unpricedTokens ? `; ${tokens(v.totals.unpricedTokens)} tokens have no price` : ''}). Model: ${v.model ?? 'none'} from ${v.provider}.${v.offReason ? ` Stopped: ${v.offReason}.` : ''}`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/ai-control`}>AI control</Link>} />
        <div className="overflow-x-auto">
          <Table aria-label="AI agents">
            <thead><Tr><Th>Agent</Th><Th>State</Th><Th numeric>Calls</Th><Th numeric>Failed</Th><Th numeric>Tokens</Th><Th numeric>Budget used</Th><Th numeric>Cost ({v.currency})</Th><Th>Last used</Th></Tr></thead>
            <tbody>
              {v.agents.map((a) => (
                <Tr key={a.key}>
                  <Td>{a.name}<span className="block text-xs text-fg-muted">{a.levelLabel}</span></Td>
                  <Td><Badge tone={a.enabled ? (a.budgetReached ? 'negative' : 'positive') : 'neutral'}>{a.enabled ? (a.budgetReached ? 'budget reached' : 'on') : 'off'}</Badge></Td>
                  <Td numeric>{a.calls}</Td>
                  <Td numeric className={cn(a.failed > 0 && 'text-negative')}>{a.failed}</Td>
                  <Td numeric>{tokens(a.tokens)}</Td>
                  <Td numeric className={cn(a.nearBudget && 'text-warning')}>{a.percentOfBudget === null ? 'No limit' : `${a.percentOfBudget}% of ${tokens(a.monthlyTokenLimit ?? 0)}`}</Td>
                  <Td numeric>{a.cost}</Td>
                  <Td className="whitespace-nowrap">{a.lastUsedAt ? date(a.lastUsedAt.slice(0, 10)) : 'Never'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="How often suggestions are accepted">
          <CardHeader title="How often suggestions are accepted" description={`Suggestions people accepted or rejected in the last ${v.accuracyDays} days, for agents whose work a person decides on.`} />
          <Table aria-label="Acceptance by agent">
            <thead><Tr><Th>Agent</Th><Th numeric>Accepted</Th><Th numeric>Edited first</Th><Th numeric>Rejected</Th><Th numeric>Waiting</Th><Th numeric>Accepted share</Th></Tr></thead>
            <tbody>{v.agents.filter((a) => a.accuracy).map((a) => <Tr key={a.key}><Td>{a.name}</Td><Td numeric>{a.accuracy!.accepted}</Td><Td numeric>{a.accuracy!.acceptedWithEdits}</Td><Td numeric>{a.accuracy!.rejected}</Td><Td numeric>{a.accuracy!.waiting}</Td><Td numeric>{a.accuracy!.rate === null ? '—' : `${a.accuracy!.rate}%`}</Td></Tr>)}</tbody>
          </Table>
        </Card>
        <Card role="region" aria-label="Recent failed AI calls">
          <CardHeader title="Recent failed AI calls" description="The latest calls to the AI model that did not return an answer, from the AI decision records." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/ai-activity`}>AI activity</Link>} />
          {v.failures.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Failed calls">
              {v.failures.map((f) => <li key={f.id} className="px-5 py-2.5">{f.agent}: {f.errorName ?? f.stopReason ?? 'failed'}<span className="block text-xs text-fg-muted">{date(f.startedAt.slice(0, 10))} · {f.model}</span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No AI call has failed.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Financial analyst

const GROUPS: { key: string; label: string }[] = [
  { key: 'GROWTH', label: 'Growth' },
  { key: 'PROFITABILITY', label: 'Profitability' },
  { key: 'LIQUIDITY', label: 'Liquidity' },
  { key: 'EFFICIENCY', label: 'Efficiency' },
  { key: 'CASH', label: 'Cash' },
];

function MovementList({ items, label, empty }: { items: Movement[]; label: string; empty: string }) {
  return items.length ? (
    <ul className="flex flex-col divide-y divide-line text-sm" aria-label={label}>
      {items.map((m) => <li key={m.key} className="flex justify-between gap-2 px-5 py-2.5"><span>{m.label}</span><span className={cn('num', m.improved === true ? 'text-positive' : m.improved === false ? 'text-negative' : 'text-fg-muted')}>{Number(m.changePercent) > 0 ? '+' : ''}{m.changePercent}%</span></li>)}
    </ul>
  ) : <p className="px-5 py-4 text-sm text-fg-muted">{empty}</p>;
}

function Analyst({ v, c }: { v: AnalystView; c: string }) {
  const t = v.twelveMonths;
  return (
    <>
      <Card role="region" aria-label="Key figures and trends">
        <CardHeader title="Key figures and trends" description={`${monthLabel(v.month)}${v.inProgress ? ' so far' : ''} against ${monthLabel(v.previousMonth)} and ${monthLabel(v.sameMonthLastYear)}, with the last 13 months as a line. Hover a figure for how it is worked out.`} />
        <div className="overflow-x-auto">
          <Table aria-label="Key figures">
            <thead><Tr><Th>Figure</Th><Th numeric>This month</Th><Th numeric>Month before</Th><Th numeric>A year ago</Th><Th>Trend</Th></Tr></thead>
            {GROUPS.map((g) => (
              <tbody key={g.key}>
                <Tr><Td colSpan={5} className="pt-4 text-xs uppercase tracking-wide text-fg-muted">{g.label}</Td></Tr>
                {v.metrics.filter((m) => m.group === g.key).map((m) => (
                  <Tr key={m.key}>
                    <Td title={m.formula}>{m.label}</Td>
                    <Td numeric className={cn(m.improved === true && 'text-positive', m.improved === false && 'text-negative')}>{formatKpi(m.value, m.unit, c)}</Td>
                    <Td numeric>{formatKpi(m.previous, m.unit, c)}</Td>
                    <Td numeric>{formatKpi(m.lastYear, m.unit, c)}</Td>
                    <Td className="w-32"><Sparkline values={m.series.map((s) => s.value)} tone="var(--t2t-accent)" /></Td>
                  </Tr>
                ))}
              </tbody>
            ))}
          </Table>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Biggest moves this month">
          <CardHeader title="Biggest moves this month" description={`Figures that changed most from ${monthLabel(v.previousMonth)}, as a share of where they were; green is better, red worse.`} />
          <MovementList items={v.movers} label="Moves from the month before" empty="Nothing to compare with the month before." />
        </Card>
        <Card role="region" aria-label="Biggest moves on last year">
          <CardHeader title="Biggest moves on last year" description={`Figures that changed most from ${monthLabel(v.sameMonthLastYear)}.`} />
          <MovementList items={v.versusLastYear} label="Moves from a year ago" empty="No figures from a year ago to compare with." />
        </Card>
      </div>
      <Card role="region" aria-label="Profit and margins by month">
        <CardHeader title="Profit and margins by month" description={`The last 12 months: ${money(t.revenue, c)} revenue, cost of sales ${t.costOfSalesShare ?? '—'}% and operating expenses ${t.operatingExpensesShare ?? '—'}% of it, net margin ${t.netMargin ?? '—'}%.`} />
        <MarginChart months={v.monthly} currency={c} />
        <div className="overflow-x-auto">
          <Table aria-label="Profit by month">
            <thead><Tr><Th>Month</Th><Th numeric>Revenue</Th><Th numeric>Gross profit</Th><Th numeric>Gross margin</Th><Th numeric>Operating profit</Th><Th numeric>Operating margin</Th><Th numeric>Net income</Th></Tr></thead>
            <tbody>
              {v.monthly.map((m) => <Tr key={m.month}><Td>{monthLabel(m.month)}</Td><Td numeric><Money value={m.revenue} currency={c} /></Td><Td numeric><Money value={m.grossProfit} currency={c} /></Td><Td numeric>{m.grossMargin === null ? '—' : `${m.grossMargin}%`}</Td><Td numeric><Money value={m.operatingProfit} currency={c} /></Td><Td numeric>{m.operatingMargin === null ? '—' : `${m.operatingMargin}%`}</Td><Td numeric><Money value={m.netIncome} currency={c} /></Td></Tr>)}
              <Tr><Td className="font-medium">12 months</Td><Td numeric className="font-medium"><Money value={t.revenue} currency={c} /></Td><Td numeric className="font-medium"><Money value={t.grossProfit} currency={c} /></Td><Td /><Td numeric className="font-medium"><Money value={t.operatingProfit} currency={c} /></Td><Td /><Td numeric className="font-medium"><Money value={t.netIncome} currency={c} /></Td></Tr>
            </tbody>
          </Table>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Growth by quarter">
          <CardHeader title="Growth by quarter" description="Revenue and net income of each calendar quarter, and revenue growth on the quarter before. A quarter with fewer than three months is still in progress or began before the books." />
          <Table aria-label="Quarters">
            <thead><Tr><Th>Quarter</Th><Th numeric>Revenue</Th><Th numeric>Growth</Th><Th numeric>Net income</Th></Tr></thead>
            <tbody>{v.quarters.map((q) => <Tr key={q.quarter}><Td>{q.quarter}{q.months < 3 ? <span className="text-xs text-fg-muted"> ({q.months} mo)</span> : null}</Td><Td numeric>{q.revenue === null ? '—' : <Money value={q.revenue} currency={c} />}</Td><Td numeric>{q.revenueGrowth === null ? '—' : `${q.revenueGrowth}%`}</Td><Td numeric>{q.netIncome === null ? '—' : <Money value={q.netIncome} currency={c} />}</Td></Tr>)}</tbody>
          </Table>
        </Card>
        <Card role="region" aria-label="Where revenue comes from">
          <CardHeader title="Where revenue comes from" description={`${BAND[v.customers.band]}: the largest customer brings ${v.customers.largestShare ?? '—'}% of the last 12 months' revenue, the top five ${v.customers.topFiveShare ?? '—'}%.`} />
          {v.customers.top.length ? (
            <Table aria-label="Largest customers">
              <thead><Tr><Th>Customer</Th><Th numeric>Revenue</Th><Th numeric>Share</Th></Tr></thead>
              <tbody>{v.customers.top.map((x) => <Tr key={x.name}><Td>{x.name}</Td><Td numeric><Money value={x.revenue} currency={c} /></Td><Td numeric>{x.share === null ? '—' : `${x.share}%`}</Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No revenue in the last 12 months.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Finance director

function PlanCell({ f, c }: { f: PlanFigure; c: string }) {
  return f.actual === null ? <span className="text-fg-muted">Not started</span> : <span className={cn(f.favourable === true && 'text-positive', f.favourable === false && 'text-negative')}><Money value={f.variance!} currency={c} />{f.percent !== null ? ` (${f.percent}%)` : ''}</span>;
}

function FinanceDirector({ v, c, orgId }: { v: FinanceDirectorView; c: string; orgId: string }) {
  const p = v.plan;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="Net income against plan" value={p && p.yearToDate.netIncome.variance !== null ? money(p.yearToDate.netIncome.variance, c) : '—'} warn={p?.yearToDate.netIncome.favourable === false} />
        <Counter label="Accounts off plan the wrong way" value={p ? p.offPlan.filter((x) => x.yearToDate.favourable === false).length : '—'} warn={!!p?.offPlan.some((x) => x.yearToDate.favourable === false)} />
        <Counter label="Departments over or at risk" value={v.departments.over + v.departments.atRisk} warn={v.departments.over > 0} />
        <Counter label="Past months not closed" value={v.lateCloses} warn={v.lateCloses > 0} />
      </div>
      <Card role="region" aria-label="Plan against actual">
        <CardHeader title="Plan against actual" description={p ? `${p.budget.name} (version ${p.budget.version}) for FY${v.fiscalYear}, with actuals to ${p.actualsThrough ? date(p.actualsThrough) : 'the start of the year'}. The full-year plan is ${money(p.fullYear.revenue, c)} revenue and ${money(p.fullYear.netIncome, c)} net income. Green is better than plan, red worse.` : `No approved budget for FY${v.fiscalYear} yet.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/budget-vs-actual`}>Budget vs actual</Link>} />
        {p ? (
          <>
            <PlanQuarterBars quarters={p.quarters} currency={c} />
            <div className="overflow-x-auto">
              <Table aria-label="Plan by quarter">
                <thead><Tr><Th>Quarter</Th><Th numeric>Planned revenue</Th><Th numeric>Revenue against plan</Th><Th numeric>Planned net income</Th><Th numeric>Actual net income</Th><Th numeric>Net income against plan</Th></Tr></thead>
                <tbody>
                  {p.quarters.map((q) => <Tr key={q.key}><Td>{q.label}{q.inProgress ? <span className="text-xs text-fg-muted"> (in progress)</span> : null}</Td><Td numeric><Money value={q.revenue.budget} currency={c} /></Td><Td numeric><PlanCell f={q.revenue} c={c} /></Td><Td numeric><Money value={q.netIncome.budget} currency={c} /></Td><Td numeric>{q.netIncome.actual === null ? '—' : <Money value={q.netIncome.actual} currency={c} />}</Td><Td numeric><PlanCell f={q.netIncome} c={c} /></Td></Tr>)}
                  <Tr><Td className="font-medium">Year to date</Td><Td numeric className="font-medium"><Money value={p.yearToDate.revenue.budget} currency={c} /></Td><Td numeric><PlanCell f={p.yearToDate.revenue} c={c} /></Td><Td numeric className="font-medium"><Money value={p.yearToDate.netIncome.budget} currency={c} /></Td><Td numeric className="font-medium">{p.yearToDate.netIncome.actual === null ? '—' : <Money value={p.yearToDate.netIncome.actual} currency={c} />}</Td><Td numeric><PlanCell f={p.yearToDate.netIncome} c={c} /></Td></Tr>
                </tbody>
              </Table>
            </div>
          </>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">Approve a budget on Budgets to compare the year with its plan.</p>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Accounts furthest off plan">
          <CardHeader title="Accounts furthest off plan" description="Year to date, the accounts worse than plan first (spending above it, revenue below it), then the largest differences." />
          {p?.offPlan.length ? (
            <Table aria-label="Accounts off plan">
              <thead><Tr><Th>Account</Th><Th numeric>Plan</Th><Th numeric>Actual</Th><Th numeric>Difference</Th></Tr></thead>
              <tbody>{p.offPlan.map((x) => <Tr key={x.accountId}><Td>{x.code} · {x.name}{x.budgeted ? null : <span className="block text-xs text-fg-muted">Not in the plan</span>}</Td><Td numeric><Money value={x.yearToDate.budget} currency={c} /></Td><Td numeric>{x.yearToDate.actual === null ? '—' : <Money value={x.yearToDate.actual} currency={c} />}</Td><Td numeric><PlanCell f={x.yearToDate} c={c} /></Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">{p ? 'Every account is on plan so far.' : 'No plan to compare with.'}</p>}
        </Card>
        <Card role="region" aria-label="Departments to watch">
          <CardHeader title="Departments to watch" description={`${v.departments.over} over budget, ${v.departments.atRisk} at risk, ${v.departments.onTrack} on track and ${v.departments.noBudget} without a budget. In all ${money(v.departments.totals.actual, c)} spent of ${money(v.departments.totals.budget, c)} budgeted.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/expenses/department-budgets`}>Department budgets</Link>} />
          {v.departments.watch.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Departments over or at risk">
              {v.departments.watch.map((d) => { const st = BUDGET[d.status as keyof typeof BUDGET] ?? BUDGET.NO_BUDGET; return <li key={d.departmentId} className="flex items-start gap-2 px-5 py-2.5"><Badge tone={st.tone}>{st.label}</Badge><span>{d.name}<span className="block text-xs text-fg-muted">{d.reason}</span></span></li>; })}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No department is over budget or at risk.</p>}
        </Card>
      </div>
      <Card role="region" aria-label="Closes for the director">
        <CardHeader title="Closes for the director" description="The last six months and whether each was closed." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/close`}>Month-end close</Link>} />
        <CloseTable rows={v.closes} label="Months and their close" orgId={orgId} />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Department manager

function DepartmentManager({ v, c, orgId, onChoose }: { v: DepartmentManagerView; c: string; orgId: string; onChoose: (id: string) => void }) {
  const d = v.department;
  if (!d) return <p className="text-sm text-fg-muted">No departments yet. Add them under Dimensions to see a department's spending.</p>;
  const b = d.budget;
  const st = BUDGET[(b?.status ?? 'NO_BUDGET') as keyof typeof BUDGET] ?? BUDGET.NO_BUDGET;
  return (
    <>
      <label className="flex max-w-sm flex-col gap-1 text-sm">
        <span className="text-fg-muted">Department</span>
        <select aria-label="Department to show" className="rounded-[var(--t2t-radius-sm)] border border-line bg-surface px-3 py-2" value={d.id} onChange={(e) => onChoose(e.target.value)}>
          {v.departments.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="Spent this year" value={money(d.spent, c)} />
        <Counter label="Budget left" value={b?.remaining ? money(b.remaining, c) : '—'} warn={!!b?.remaining && Number(b.remaining) < 0} />
        <Counter label="Waiting for approval" value={money(b?.committed ?? '0', c)} />
        <Counter label="Budget status" value={st.label} warn={b?.status === 'OVER' || b?.status === 'AT_RISK'} />
      </div>
      <Card role="region" aria-label="Department spending by month">
        <CardHeader title="Department spending by month" description={`Posted spending of ${d.name} from ${date(d.from)} to ${date(d.to)}${b?.amount ? ` against a budget of ${money(b.amount, c)} for FY${v.fiscalYear}` : ''}. ${b?.reason ?? ''}`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/reports/department-performance`}>Department performance</Link>} />
        <DepartmentSpendChart months={d.months} currency={c} />
        <Table aria-label="Spending in each month">
          <thead><Tr><Th>Month</Th><Th numeric>Spent</Th><Th numeric>Monthly share of budget</Th></Tr></thead>
          <tbody>{d.months.map((m) => <Tr key={m.month}><Td>{monthLabel(m.month)}</Td><Td numeric><Money value={m.spent} currency={c} /></Td><Td numeric>{m.budget === null ? '—' : <Money value={m.budget} currency={c} />}</Td></Tr>)}</tbody>
        </Table>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="What the money went on">
          <CardHeader title="What the money went on" description="This year's posted spending by expense account, largest first." />
          {d.accounts.length ? (
            <Table aria-label="Spending by account">
              <thead><Tr><Th>Account</Th><Th numeric>Spent</Th><Th numeric>Share</Th></Tr></thead>
              <tbody>{d.accounts.map((a) => <Tr key={a.id}><Td>{a.code} · {a.name}</Td><Td numeric><Money value={a.spent} currency={c} /></Td><Td numeric>{a.share === null ? '—' : `${a.share}%`}</Td></Tr>)}</tbody>
            </Table>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">Nothing posted to this department this year.</p>}
        </Card>
        <Card role="region" aria-label="Claims for this department">
          <CardHeader title="Claims for this department" description="Expense claims waiting for approval with lines charged to this department, oldest first, and how much of each is for it." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/expenses`}>Expense claims</Link>} />
          {d.claims.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Claims waiting">
              {d.claims.map((x) => <li key={x.id} className="flex justify-between gap-2 px-5 py-2.5"><span><Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/${x.id}`}>{x.number} · {x.title}</Link><span className="block text-xs text-fg-muted">{x.claimant}{x.submittedOn ? `, sent ${date(x.submittedOn)}` : ''}</span></span><Money value={x.forDepartment} currency={x.currency} /></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No claim for this department is waiting.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- External auditor

const YEAR_STATUS: Record<string, { label: string; tone: 'positive' | 'warning' | 'neutral' }> = { CLOSED: { label: 'closed', tone: 'positive' }, OUT_OF_DATE: { label: 'needs closing again', tone: 'warning' }, NOT_CLOSED: { label: 'not closed', tone: 'neutral' }, NOTHING_TO_CLOSE: { label: 'nothing to close', tone: 'neutral' } };

function ExternalAuditor({ v, c, orgId }: { v: ExternalAuditorView; c: string; orgId: string }) {
  const tb = v.trialBalance;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="Trial balance" value={tb ? (tb.balanced ? 'Balanced' : 'Out of balance') : '—'} warn={!!tb && !tb.balanced} />
        <Counter label="Open periods in ended years" value={v.openPeriodsInEndedYears} warn={v.openPeriodsInEndedYears > 0} />
        <Counter label="Auditor links in use" value={v.portal.active} />
        <Counter label="Evidence outstanding" value={v.evidence.outstanding.length} warn={v.evidence.outstanding.length > 0} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Years and their close">
          <CardHeader title="Years and their close" description={tb ? `Trial balance at ${date(tb.asOf)} (${tb.label}): ${tb.accounts} accounts, debits ${money(tb.debit, c)} and credits ${money(tb.credit, c)}.` : 'No fiscal year has ended yet.'} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/year-end`}>Year-end close</Link>} />
          <Table aria-label="Fiscal years">
            <thead><Tr><Th>Year</Th><Th>Status</Th><Th numeric>Periods open / locked / closed</Th><Th numeric>Profit</Th></Tr></thead>
            <tbody>{v.years.map((y) => { const st = YEAR_STATUS[y.status] ?? { label: y.status.toLowerCase(), tone: 'neutral' as const }; return <Tr key={y.fiscalYear}><Td>{y.label}<span className="block text-xs text-fg-muted">{date(y.startDate)} to {date(y.endDate)}{y.ended ? '' : ', running'}</span></Td><Td><Badge tone={st.tone}>{st.label}</Badge></Td><Td numeric>{y.periods.open} / {y.periods.locked} / {y.periods.closed}</Td><Td numeric><Money value={y.profit} currency={c} /></Td></Tr>; })}</tbody>
          </Table>
        </Card>
        <Card role="region" aria-label="Auditor portal links">
          <CardHeader title="Auditor portal links" description="Links in use that give external auditors read-only access to an audit, and how much they have used them." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/audit-engagements`}>Internal audit</Link>} />
          {v.portal.links.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Links for auditors">
              {v.portal.links.map((l) => <li key={l.id} className="px-5 py-2.5"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/audit-engagements/${l.engagementId}`}>{l.engagement}</Link><span className="block">{l.auditorName}{l.firm ? `, ${l.firm}` : ''}</span><span className="block text-xs text-fg-muted">Ends {date(l.expiresAt.slice(0, 10))}; {l.lastSeenAt ? `last opened ${date(l.lastSeenAt.slice(0, 10))}, ${l.viewCount} visits, ${l.filesOpened} files opened` : 'not opened yet'}</span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No auditor link is in use.</p>}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Evidence asked for">
          <CardHeader title="Evidence asked for" description={`${v.evidence.summary.requested} requested, ${v.evidence.summary.submitted} submitted for review, ${v.evidence.summary.accepted} accepted.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/audit-evidence`}>Audit evidence</Link>} />
          {v.evidence.outstanding.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Evidence not yet accepted">
              {v.evidence.outstanding.map((r) => <li key={r.id} className="flex justify-between gap-2 px-5 py-2.5"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/audit-evidence/${r.id}`}>{r.reference} · {r.title}</Link><span className="text-fg-muted">{r.status.toLowerCase()}, due {date(r.dueDate)}</span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">Every piece of evidence asked for is accepted.</p>}
        </Card>
        <Card role="region" aria-label="Findings still open">
          <CardHeader title="Findings still open" description={`${v.findings.summary.open} open${v.findings.summary.overdue ? `, ${v.findings.summary.overdue} past their date` : ''}.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/audit-findings`}>Audit findings</Link>} />
          {v.findings.open.length ? (
            <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Open findings">
              {v.findings.open.map((f) => <li key={f.id} className="flex items-start gap-2 px-5 py-2.5"><Badge tone={f.severity === 'HIGH' ? 'negative' : f.severity === 'MEDIUM' ? 'warning' : 'neutral'}>{f.severity.toLowerCase()}</Badge><span><Link className="text-accent hover:underline" href={`/orgs/${orgId}/audit-findings/${f.id}`}>{f.reference} · {f.title}</Link><span className={cn('block text-xs', f.overdue ? 'text-negative' : 'text-fg-muted')}>{f.dueDate ? `Due ${date(f.dueDate)}` : 'No date'}</span></span></li>)}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-fg-muted">No finding is open.</p>}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Project finance

const HEALTH: Record<string, { label: string; tone: 'positive' | 'warning' | 'negative' | 'neutral' }> = { LOSS: { label: 'losing money', tone: 'negative' }, THIN: { label: 'thin margin', tone: 'warning' }, HEALTHY: { label: 'healthy', tone: 'positive' }, NO_REVENUE: { label: 'cost, no revenue', tone: 'warning' }, NO_ACTIVITY: { label: 'nothing posted', tone: 'neutral' } };

function ProjectFinance({ v, c, orgId }: { v: ProjectFinanceView; c: string; orgId: string }) {
  if (!v.projects.length) return <p className="text-sm text-fg-muted">No projects yet. Add them under Dimensions and tag journal lines, invoices and bills with them to see each project&apos;s profit.</p>;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="Profit on projects" value={money(v.totals.profit, c)} warn={Number(v.totals.profit) < 0} />
        <Counter label="Projects losing money" value={v.counts.loss} warn={v.counts.loss > 0} />
        <Counter label="Thin margins" value={v.counts.thin} warn={v.counts.thin > 0} />
        <Counter label="Ending within 30 days" value={v.counts.endingSoon} />
      </div>
      <Card role="region" aria-label="Project margins">
        <CardHeader title="Project margins" description={`Revenue, cost and profit of each project from everything posted up to ${date(v.asOf)}, losses first. A margin under 10% is thin.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/reports/profit-by-dimension`}>Profit by department or project</Link>} />
        <ProjectBars projects={v.projects} currency={c} />
        <Table aria-label="Projects">
          <thead><Tr><Th>Project</Th><Th numeric>Revenue</Th><Th numeric>Cost</Th><Th numeric>Profit</Th><Th numeric>Margin</Th><Th>Health</Th><Th>Progress</Th><Th>Largest cost</Th></Tr></thead>
          <tbody>
            {v.projects.map((p) => {
              const h = HEALTH[p.health] ?? { label: p.health.toLowerCase(), tone: 'neutral' as const };
              return (
                <Tr key={p.id}>
                  <Td>{p.code} · {p.name}<span className="block text-xs text-fg-muted">{p.customer ?? 'No customer'}{p.isActive ? '' : ', inactive'}</span></Td>
                  <Td numeric><Money value={p.revenue} currency={c} /></Td>
                  <Td numeric><Money value={p.cost} currency={c} /></Td>
                  <Td numeric><Money value={p.profit} currency={c} /></Td>
                  <Td numeric>{p.margin === null ? '—' : `${p.margin}%`}</Td>
                  <Td><Badge tone={h.tone}>{h.label}</Badge></Td>
                  <Td>{p.elapsedPercent === null ? 'No dates' : p.ended ? `Ended ${date(p.endDate!)}` : `${p.elapsedPercent}% through, ${p.daysLeft} days left`}</Td>
                  <Td>{p.topCost ? `${p.topCost.code} · ${p.topCost.name} (${p.topCost.share ?? '—'}%)` : '—'}</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Project revenue and cost">
          <CardHeader title="Project revenue and cost" description="The last six months: what was posted to a project and what was not." />
          <Table aria-label="Project months">
            <thead><Tr><Th>Month</Th><Th numeric>Project revenue</Th><Th numeric>Project cost</Th><Th numeric>Other revenue</Th><Th numeric>Other cost</Th></Tr></thead>
            <tbody>{v.months.map((m) => <Tr key={m.month}><Td>{monthLabel(m.month)}</Td><Td numeric><Money value={m.projectRevenue} currency={c} /></Td><Td numeric><Money value={m.projectCost} currency={c} /></Td><Td numeric><Money value={m.otherRevenue} currency={c} /></Td><Td numeric><Money value={m.otherCost} currency={c} /></Td></Tr>)}</tbody>
          </Table>
        </Card>
        <Card role="region" aria-label="Not tied to a project">
          <CardHeader title="Not tied to a project" description="Revenue and cost posted without a project. A large share means project margins leave out part of the business." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/dimensions`}>Dimensions</Link>} />
          <div className="grid gap-3 px-5 pb-4 sm:grid-cols-2">
            <Counter label="Revenue without a project" value={`${money(v.unassigned.revenue, c)}${v.unassigned.revenueShare === null ? '' : ` (${v.unassigned.revenueShare}%)`}`} />
            <Counter label="Cost without a project" value={`${money(v.unassigned.cost, c)}${v.unassigned.costShare === null ? '' : ` (${v.unassigned.costShare}%)`}`} />
          </div>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Organisation admin

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owners', ADMIN: 'Admins', ACCOUNTANT: 'Accountants', APPROVER: 'Approvers', VIEWER: 'Viewers', EMPLOYEE: 'Employees' };
const TEST_STATUS: Record<string, { label: string; tone: 'positive' | 'negative' | 'neutral' }> = { OK: { label: 'test passed', tone: 'positive' }, FAILED: { label: 'test failed', tone: 'negative' }, NOT_TESTED: { label: 'not tested', tone: 'neutral' } };

function OrgAdmin({ v, orgId }: { v: OrgAdminView; orgId: string }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="Members" value={v.members.total} />
        <Counter label="Without two-step sign-in" value={v.members.withoutTwoStep} warn={v.members.withoutTwoStep > 0} />
        <Counter label="Invitations open" value={v.invitations.pending} />
        <Counter label="Single sign-on" value={v.sso.configured ? (v.sso.enabled ? (v.sso.enforced ? 'On, required' : 'On') : 'Set up, off') : 'Not set up'} />
      </div>
      <Card role="region" aria-label="Admin to-do">
        <CardHeader title="Admin to-do" description="Settings that weaken sign-in, broken connections and limits nearly reached, most urgent first." />
        {v.attention.length ? (
          <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Admin items">
            {v.attention.map((a) => <li key={a.title} className="flex items-start gap-2 px-5 py-2.5"><Badge tone={TONE[a.level]}>{a.level.toLowerCase()}</Badge><span><Link className="text-accent hover:underline" href={`/orgs/${orgId}${a.href}`}>{a.title}</Link><span className="block text-xs text-fg-muted">{a.detail}</span></span></li>)}
          </ul>
        ) : <p className="px-5 py-4 text-sm text-fg-muted">Nothing needs an admin right now.</p>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card role="region" aria-label="Who has access">
          <CardHeader title="Who has access" description={`Members by role and how many of them sign in without two-step sign-in. ${v.security.requireTwoStep ? 'Two-step sign-in is required for everyone.' : 'Two-step sign-in is not required.'}`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/members`}>Members</Link>} />
          <Table aria-label="Members by role">
            <thead><Tr><Th>Role</Th><Th numeric>Members</Th><Th numeric>Without two-step</Th></Tr></thead>
            <tbody>{v.members.roles.map((r) => <Tr key={r.role}><Td>{ROLE_LABEL[r.role] ?? r.role}</Td><Td numeric>{r.members}</Td><Td numeric>{r.withoutTwoStep}</Td></Tr>)}</tbody>
          </Table>
          {v.members.adminsWithoutTwoStep.length ? <p className="px-5 py-3 text-sm text-negative">Can change settings but has no two-step sign-in: {v.members.adminsWithoutTwoStep.map((m) => m.name).join(', ')}.</p> : null}
        </Card>
        <Card role="region" aria-label="Sign-in and invitations">
          <CardHeader title="Sign-in and invitations" description={`${v.invitations.pending} open, ${v.invitations.expired} expired, ${v.invitations.accepted} accepted and ${v.invitations.revoked} revoked invitations. Single sign-on: ${v.sso.configured ? `${v.sso.protocol ?? ''} ${v.sso.enabled ? 'on' : 'off'}, ${v.sso.verifiedDomains} of ${v.sso.domains} domains verified` : 'not set up'}.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/settings/sso`}>Single sign-on</Link>} />
          <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Newest members">
            {v.members.newest.map((m) => <li key={m.userId} className="flex justify-between gap-2 px-5 py-2.5"><span>{m.name}</span><span className="text-fg-muted">{(ROLE_LABEL[m.role] ?? m.role).replace(/s$/, '').toLowerCase()}, since {date(m.since.slice(0, 10))}</span></li>)}
          </ul>
        </Card>
      </div>
      <Card role="region" aria-label="Connections and plan use">
        <CardHeader title="Connections and plan use" description={`Integrations and what this month's plan${v.usage.plan ? ` (${v.usage.plan})` : ''} allows.`} actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/settings/usage`}>Usage</Link>} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Table aria-label="Integrations">
            <thead><Tr><Th>Integration</Th><Th>Set up</Th><Th>Last test</Th></Tr></thead>
            <tbody>{v.integrations.map((i) => { const t = TEST_STATUS[i.testStatus] ?? { label: i.testStatus.toLowerCase(), tone: 'neutral' as const }; return <Tr key={i.name}><Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/integrations`}>{i.name}</Link></Td><Td>{i.configured ? (i.enabled ? 'On' : 'Off') : 'Not set up'}</Td><Td><Badge tone={t.tone}>{t.label}</Badge></Td></Tr>; })}</tbody>
          </Table>
          <Table aria-label="Plan use this month">
            <thead><Tr><Th>Use</Th><Th numeric>Used</Th><Th numeric>Limit</Th><Th numeric>Share</Th></Tr></thead>
            <tbody>{v.usage.items.map((u) => <Tr key={u.name}><Td>{u.name}</Td><Td numeric>{u.used}</Td><Td numeric>{u.limit === null ? 'No limit' : u.limit}</Td><Td numeric className={cn(u.state === 'REACHED' ? 'text-negative' : u.state === 'NEAR' ? 'text-warning' : undefined)}>{u.percent === null ? '—' : `${u.percent}%`}</Td></Tr>)}</tbody>
          </Table>
        </div>
      </Card>
    </>
  );
}
