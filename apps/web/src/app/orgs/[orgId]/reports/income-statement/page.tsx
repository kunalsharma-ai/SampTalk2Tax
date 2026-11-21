'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CardHeader, Select, Table, Td, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { ExportButtons } from '@/components/reports/export-buttons';
import { SavedViews } from '@/components/reports/saved-views';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useDimensions } from '@/lib/dimensions';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Line = { accountId: string; code: string; name: string; amount: string };
interface IS { basis: 'ACCRUAL' | 'CASH'; revenue: Line[]; expenses: Line[]; totalRevenue: string; totalExpenses: string; netIncome: string; accrualNetIncome: string | null; notInCash: string | null }

export default function IncomeStatementPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const [departmentId, setDepartment] = useState('');
  const [projectId, setProject] = useState('');
  const [basis, setBasis] = useState<'ACCRUAL' | 'CASH'>('ACCRUAL');
  const dims = useDimensions();
  const departments = (dims.data?.values ?? []).filter((v) => v.type === 'DEPARTMENT');
  const projects = (dims.data?.values ?? []).filter((v) => v.type === 'PROJECT');
  const filter = `${departmentId ? `&departmentId=${departmentId}` : ''}${projectId ? `&projectId=${projectId}` : ''}`;
  const cash = basis === 'CASH';
  const q = useQuery({ queryKey: ['is', orgId, from, to, departmentId, projectId, basis], queryFn: () => api<IS>(`/v1/orgs/${orgId}/reports/income-statement?from=${from}&to=${to}${filter}${cash ? '&basis=CASH' : ''}`) });
  if (!org) return null;
  const c = org.functionalCurrency;
  const section = (title: string, lines: Line[], total: string) => (
    <>
      <tr><Td colSpan={2} className="bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</Td></tr>
      {lines.map((l) => (
        <Tr key={l.accountId}><Td><span className="num text-fg-muted">{l.code}</span> {filter || cash ? l.name : <Link className="hover:text-accent" href={`/orgs/${orgId}/reports/general-ledger?accountId=${l.accountId}&from=${from}&to=${to}`}>{l.name}</Link>}</Td><Td numeric><Money value={l.amount} currency={c} signed /></Td></Tr>
      ))}
      <tr><Td className="font-semibold">Total {title.toLowerCase()}</Td><Td numeric className="font-semibold"><Money value={total} currency={c} /></Td></tr>
    </>
  );
  return (
    <>
      <PageHeader
        title="Profit and loss"
        description={cash ? 'Revenue and expenses as money was received or paid in the period: invoices, bills, credit notes, expense claims and pay runs count in the share settled in the period; bank and cash entries count in full; accruals with no cash are left out.' : 'Revenue and expenses from posted journals in the period.'}
        actions={<><DateInput label="From" value={from} onChange={setFrom} /><DateInput label="To" value={to} onChange={setTo} /><ExportButtons orgId={orgId} report="income-statement" params={{ from, to, departmentId, projectId, basis: cash ? 'CASH' : null }} /></>}
      />
      <SavedViews
        orgId={orgId}
        report="income-statement"
        current={{ from, to, basis, departmentId: departmentId || null, projectId: projectId || null }}
        onApply={(v) => {
          setFrom(v.from ?? from);
          setTo(v.to);
          setBasis(v.basis ?? 'ACCRUAL');
          setDepartment(v.departmentId ?? '');
          setProject(v.projectId ?? '');
        }}
      />
      <div className="mb-4 flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Basis
            <Select className="w-44" value={basis} onChange={(e) => setBasis(e.target.value as 'ACCRUAL' | 'CASH')}>
              <option value="ACCRUAL">Accrual</option>
              <option value="CASH">Cash</option>
            </Select>
          </label>
          {departments.length ? (
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Department
              <Select className="w-56" value={departmentId} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">All departments</option>
                {departments.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}
              </Select>
            </label>
          ) : null}
          {projects.length ? (
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Project
              <Select className="w-56" value={projectId} onChange={(e) => setProject(e.target.value)}>
                <option value="">All projects</option>
                {projects.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}
              </Select>
            </label>
          ) : null}
      </div>
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {q.data ? (
        <Card>
          <CardHeader title={cash ? 'Income statement (cash basis)' : 'Income statement'} description={[org.name, c, departments.find((v) => v.id === departmentId)?.name, projects.find((v) => v.id === projectId)?.name].filter(Boolean).join(' · ')} />
          <Table>
            <tbody>
              {section('Revenue', q.data.revenue, q.data.totalRevenue)}
              {section('Expenses', q.data.expenses, q.data.totalExpenses)}
            </tbody>
            <tfoot>
              <tr><Td className="text-base font-semibold">Net income</Td><Td numeric className="text-base font-semibold"><Money value={q.data.netIncome} currency={c} signed /></Td></tr>
            </tfoot>
          </Table>
          {q.data.basis === 'CASH' && q.data.accrualNetIncome !== null ? (
            <div className="border-t border-line px-5 py-4 text-sm text-fg-muted" role="note" aria-label="Accrual comparison">
              On an accrual basis the net income for the period is <Money value={q.data.accrualNetIncome} currency={c} signed />. The difference of <Money value={q.data.notInCash!} currency={c} signed /> is income and expenses not yet received or paid, settled in another period, or with no cash at all (such as depreciation).
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
