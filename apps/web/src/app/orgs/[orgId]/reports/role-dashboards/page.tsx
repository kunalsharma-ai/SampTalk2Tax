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
  AGING_LABEL,
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
  const q = useQuery({ queryKey: ['role-dashboard', orgId, role], queryFn: () => api<RoleDashboard>(`/v1/orgs/${orgId}/reports/role-dashboards/${role}`) });
  if (!org) return null;
  const r = q.data && q.data.role === role ? q.data : null;
  const c = r?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Role dashboards"
        description="One dashboard for each role that reads the books, each laid out around the questions that role asks: the CEO, the CFO, treasury, the risk officer, compliance, the board or investors, and the receivables, payables, tax and expense managers. Every figure comes from your posted books and Talk2Tax's own checks."
      />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Dashboard for">
        {ROLES.map((x) => (
          <Button key={x.role} role="tab" aria-selected={x.role === role} size="sm" variant={x.role === role ? 'primary' : 'ghost'} onClick={() => router.replace(`?role=${x.role}`)}>
            {x.label}
          </Button>
        ))}
      </div>
      <ErrorAlert title="Could not read this dashboard" error={q.error} />
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
        </div>
      ) : !q.error ? <p className="text-sm text-fg-muted">Reading the dashboard…</p> : null}
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
