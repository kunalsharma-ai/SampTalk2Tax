'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPARTMENT_BUDGET_STATUS_LABEL, type DepartmentBudgetStatus } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Row {
  departmentId: string;
  code: string;
  name: string;
  budget: string | null;
  actual: string;
  committed: string;
  status: DepartmentBudgetStatus;
  expectedByNow: string | null;
  usedPercent: string | null;
  remaining: string | null;
  projected: string;
  reason: string;
  note: string | null;
}
interface Report {
  fiscalYear: number;
  start: string;
  end: string;
  asOf: string;
  currency: string;
  rows: Row[];
  totals: { budget: string; actual: string; committed: string };
  elapsedDays: number;
  totalDays: number;
  canManage: boolean;
}
const TONE: Record<DepartmentBudgetStatus, 'negative' | 'warning' | 'positive' | 'neutral'> = { OVER: 'negative', AT_RISK: 'warning', ON_TRACK: 'positive', NO_BUDGET: 'neutral' };
const AMOUNT = /^\d{0,15}(\.\d{0,2})?$/;

/** Expenses → Department budgets (EXP-014): each department's yearly budget against what its expense claims spent. */
export default function DepartmentBudgetsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [fy, setFy] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['department-budgets', orgId, fy], queryFn: () => api<Report>(`/v1/orgs/${orgId}/department-budgets${fy ? `?fiscalYear=${fy}` : ''}`) });
  const [form, setForm] = useState({ departmentId: '', amount: '', note: '' });
  const save = useMutation({
    mutationFn: (year: number) => api<Report>(`/v1/orgs/${orgId}/department-budgets`, { method: 'PUT', body: { departmentId: form.departmentId, fiscalYear: year, amount: form.amount, note: form.note || null } }),
    onSuccess: async (r) => {
      setForm({ departmentId: '', amount: '', note: '' });
      qc.setQueryData(['department-budgets', orgId, fy], r);
      await qc.invalidateQueries({ queryKey: ['department-budgets', orgId] });
    },
  });
  if (!org) return null;
  const r = q.data;
  const c = r?.currency ?? org.functionalCurrency;
  const year = r?.fiscalYear ?? null;
  // The years around the current one; the first report is always for the current fiscal year.
  const anchor = qc.getQueryData<Report>(['department-budgets', orgId, null])?.fiscalYear ?? year;
  const years = anchor ? [anchor - 2, anchor - 1, anchor, anchor + 1] : [];
  const pick = (id: string) => {
    const row = r?.rows.find((x) => x.departmentId === id);
    setForm({ departmentId: id, amount: row?.budget ?? '', note: row?.note ?? '' });
  };
  const over = r?.rows.filter((x) => x.status === 'OVER').length ?? 0;
  const risk = r?.rows.filter((x) => x.status === 'AT_RISK').length ?? 0;
  return (
    <>
      <PageHeader
        title="Department budgets"
        description="Each department's budget for the year against what its approved expense claims spent, and what claims waiting for approval would add. A department is at risk when waiting claims would take it over, or when at this pace it would pass its budget by the year end."
        actions={
          years.length ? (
            <div className="w-40">
              <Select aria-label="Fiscal year" value={String(fy ?? year)} onChange={(e) => setFy(Number(e.target.value))}>
                {years.map((y) => <option key={y} value={y}>FY {y}</option>)}
              </Select>
            </div>
          ) : null
        }
      />
      <ErrorAlert title="Could not load department budgets" error={q.error} />
      {r ? (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card className="p-4"><p className="text-sm text-fg-muted">Budget for the year</p><p className="mt-1 text-2xl font-semibold"><Money value={r.totals.budget} currency={c} /></p><p className="text-xs text-fg-muted">{date(r.start)} to {date(r.end)}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Spent</p><p className="mt-1 text-2xl font-semibold"><Money value={r.totals.actual} currency={c} /></p><p className="text-xs text-fg-muted">{r.elapsedDays} of {r.totalDays} days of the year gone</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Waiting for approval</p><p className="mt-1 text-2xl font-semibold"><Money value={r.totals.committed} currency={c} /></p><p className="text-xs text-fg-muted">Submitted claims with a department</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Needs a look</p><p className={`mt-1 text-2xl font-semibold ${over ? 'text-negative' : risk ? 'text-warning' : ''}`}>{over + risk}</p><p className="text-xs text-fg-muted">{over} over, {risk} at risk</p></Card>
        </div>
      ) : null}
      {r ? (
        <Card className="mt-6" role="region" aria-label="Budget by department">
          <CardHeader title="Budget by department" description={`Worst first. Spent counts approved claims, and anything else posted to an expense account with the department, up to ${date(r.asOf < r.end ? r.asOf : r.end)}.`} />
          {r.rows.length ? (
            <Table aria-label="Budget by department">
              <thead>
                <Tr><Th>Department</Th><Th>Status</Th><Th numeric>Budget</Th><Th numeric>Spent</Th><Th numeric>Waiting</Th><Th numeric>Left</Th><Th numeric>Year-end pace</Th>{r.canManage ? <Th /> : null}</Tr>
              </thead>
              <tbody>
                {r.rows.map((x) => (
                  <Tr key={x.departmentId}>
                    <Td className="align-top">
                      <span className="font-medium"><span className="num text-fg-muted">{x.code}</span> {x.name}</span>
                      {x.note ? <span className="block max-w-xs text-xs text-fg-muted">{x.note}</span> : null}
                    </Td>
                    <Td className="align-top"><Badge tone={TONE[x.status]}>{DEPARTMENT_BUDGET_STATUS_LABEL[x.status]}</Badge><span className="mt-1 block max-w-xs text-xs text-fg-muted">{x.reason}</span></Td>
                    <Td numeric className="align-top">{x.budget ? <Money value={x.budget} currency={c} /> : '—'}{x.expectedByNow ? <span className="block text-xs text-fg-muted">By now <Money value={x.expectedByNow} currency={c} /></span> : null}</Td>
                    <Td numeric className="align-top"><Money value={x.actual} currency={c} />{x.usedPercent ? <span className="block text-xs text-fg-muted">{x.usedPercent}% used</span> : null}</Td>
                    <Td numeric className="align-top"><Money value={x.committed} currency={c} /></Td>
                    <Td numeric className={`align-top ${x.remaining?.startsWith('-') ? 'text-negative' : ''}`}>{x.remaining ? <Money value={x.remaining} currency={c} /> : '—'}</Td>
                    <Td numeric className="align-top"><Money value={x.projected} currency={c} /></Td>
                    {r.canManage ? <Td className="align-top"><Button size="sm" variant="secondary" aria-label={`Set budget for ${x.name}`} onClick={() => pick(x.departmentId)}>{x.budget ? 'Change' : 'Set'}</Button></Td> : null}
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No departments yet">
              Add departments under <Link className="underline" href={`/orgs/${orgId}/dimensions`}>Departments and projects</Link>, then choose one on each expense claim line.
            </EmptyState>
          )}
        </Card>
      ) : null}
      {r?.canManage && r.rows.length ? (
        <Card className="mt-6" role="region" aria-label="Set a department budget">
          <CardHeader title="Set a department budget" description={`The budget for FY ${r.fiscalYear}. Setting it again replaces it; every change is in the audit log.`} />
          <form
            className="grid gap-4 px-5 pb-5 sm:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(r.fiscalYear);
            }}
          >
            <Field label="Department">{(p) => <Select {...p} value={form.departmentId} onChange={(e) => pick(e.target.value)}><option value="">Choose…</option>{r.rows.map((x) => <option key={x.departmentId} value={x.departmentId}>{x.code} · {x.name}</option>)}</Select>}</Field>
            <Field label="Budget for the year">{(p) => <Input {...p} className="num text-right" inputMode="decimal" placeholder="0.00" value={form.amount} onChange={(e) => AMOUNT.test(e.target.value) && setForm({ ...form, amount: e.target.value })} />}</Field>
            <Field label="Note">{(p) => <Input {...p} maxLength={500} placeholder="Optional" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex items-end"><Button type="submit" disabled={!form.departmentId || !form.amount || save.isPending}>{save.isPending ? 'Saving…' : 'Save budget'}</Button></div>
            {save.error ? <div className="sm:col-span-4"><Alert tone="negative" title="Could not save the budget">{(save.error as Error).message}</Alert></div> : null}
          </form>
        </Card>
      ) : null}
    </>
  );
}
