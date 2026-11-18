'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { monthLabel, REPORT_STATUS_LABEL, type ExpenseGroupFigures, type ExpenseReportData, type ReportStatus } from '@/lib/expense-report';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

const STATUSES: ReportStatus[] = ['SUBMITTED', 'APPROVED', 'REIMBURSED'];

function threeMonthsAgo() {
  const d = new Date(`${today().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 10);
}

/** Expense reports (EXP-017): claimed spending by category, month, person, status and merchant. */
export default function ExpenseReportPage() {
  const { org, orgId } = useOrg();
  const [from, setFrom] = useState(threeMonthsAgo);
  const [to, setTo] = useState(today);
  const [statuses, setStatuses] = useState<ReportStatus[]>(STATUSES);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const [category, setCategory] = useState<{ id: string; name: string } | null>(null);
  const params = new URLSearchParams({ from, to, status: statuses.join(',') });
  if (person) params.set('claimantId', person.id);
  if (category) params.set('accountId', category.id);
  const q = useQuery({ queryKey: ['expense-report', orgId, params.toString()], queryFn: () => api<ExpenseReportData>(`/v1/orgs/${orgId}/reports/expenses?${params}`), enabled: !!from && !!to && statuses.length > 0 });
  if (!org) return null;
  const r = q.data;
  const mine = r?.scope === 'mine';
  return (
    <>
      <PageHeader
        title={mine ? 'My expense report' : 'Expense reports'}
        description="Claimed spending in a period by category, month, person, status and merchant, from the lines of submitted, approved and reimbursed claims. Drafts, rejected and void claims are left out. Lines count in the month the expense happened."
        actions={<Link href={`/orgs/${orgId}/expenses`}><Button variant="secondary">Expense claims</Button></Link>}
      />
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4 p-5">
          <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          <fieldset className="flex flex-wrap gap-3 text-sm">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Claims that are</legend>
            {STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-1.5">
                <input type="checkbox" checked={statuses.includes(s)} onChange={(e) => setStatuses((xs) => (e.target.checked ? STATUSES.filter((x) => xs.includes(x) || x === s) : xs.filter((x) => x !== s)))} />
                {REPORT_STATUS_LABEL[s]}
              </label>
            ))}
          </fieldset>
        </div>
        {person || category ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3 text-sm">
            <span className="text-fg-muted">Showing only</span>
            {person ? <Button size="sm" variant="secondary" onClick={() => setPerson(null)} aria-label={`Stop filtering to ${person.name}`}>{person.name} ×</Button> : null}
            {category ? <Button size="sm" variant="secondary" onClick={() => setCategory(null)} aria-label={`Stop filtering to ${category.name}`}>{category.name} ×</Button> : null}
          </div>
        ) : null}
      </Card>
      {!statuses.length ? <p className="mb-4 text-sm text-fg-muted">Tick at least one kind of claim.</p> : null}
      <ErrorAlert title="Could not load the report" error={q.error as Error | null} />
      {r ? (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-4">
            <Stat label="Total claimed" value={<Money value={r.totals.total} currency={r.currency} />} sub={`${r.totals.claims} claims, ${r.totals.lines} lines`} />
            <Stat label="Before tax" value={<Money value={r.totals.net} currency={r.currency} />} />
            <Stat label="Input tax" value={<Money value={r.totals.tax} currency={r.currency} />} />
            <Stat label="Largest category" value={r.byCategory[0]?.name ?? '–'} sub={r.byCategory[0] ? `${r.byCategory[0].share}% of the total` : undefined} />
          </div>
          {!r.totals.lines ? (
            <Card><EmptyState title="No spending in this period">No claim lines fall between these dates with the ticked statuses.</EmptyState></Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <Group title="Spending by category" label="Category" currency={r.currency} rows={r.byCategory.map((g) => ({ key: g.accountId, name: <>{g.code ? <span className="num text-fg-muted">{g.code} </span> : null}{g.name}</>, g, pick: category ? undefined : () => setCategory({ id: g.accountId, name: g.name }) }))} />
              <Group title="Spending by month" label="Month" currency={r.currency} rows={r.byMonth.map((g) => ({ key: g.month, name: monthLabel(g.month), g }))} />
              {mine ? null : <Group title="Spending by person" label="Person" currency={r.currency} rows={r.byPerson.map((g) => ({ key: g.claimantId, name: g.name, g, pick: person ? undefined : () => setPerson({ id: g.claimantId, name: g.name }) }))} />}
              <Group title="Spending by merchant" label="Merchant" currency={r.currency} rows={r.byMerchant.map((g) => ({ key: g.merchant, name: g.merchant, g }))} empty="No merchant names on these lines." />
              <Group title="Spending by status" label="Status" currency={r.currency} rows={r.byStatus.map((g) => ({ key: g.status, name: <Badge tone={g.status === 'REIMBURSED' ? 'positive' : g.status === 'APPROVED' ? 'accent' : 'warning'}>{REPORT_STATUS_LABEL[g.status]}</Badge>, g }))} />
            </div>
          )}
        </>
      ) : null}
    </>
  );
}

function Group({ title, label, currency, rows, empty }: { title: string; label: string; currency: string; rows: { key: string; name: ReactNode; g: ExpenseGroupFigures; pick?: () => void }[]; empty?: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length ? (
        <Table aria-label={title}>
          <thead>
            <tr>
              <Th>{label}</Th>
              <Th numeric>Claims</Th>
              <Th numeric>Total</Th>
              <Th numeric>Share</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.key}>
                <Td>{r.pick ? <button type="button" className="text-left text-accent underline" onClick={r.pick}>{r.name}</button> : r.name}</Td>
                <Td numeric>{r.g.claims}</Td>
                <Td numeric><Money value={r.g.total} currency={currency} /></Td>
                <Td numeric>
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden className="hidden h-1.5 w-16 overflow-hidden rounded bg-surface-hover sm:inline-block"><span className="block h-full bg-accent" style={{ width: `${Math.min(100, Number(r.g.share))}%` }} /></span>
                    {r.g.share}%
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : <p className="p-5 text-sm text-fg-muted">{empty ?? 'Nothing in this period.'}</p>}
    </Card>
  );
}
