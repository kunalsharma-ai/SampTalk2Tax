'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CardHeader, Select, Table, Td, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { ExportButtons } from '@/components/reports/export-buttons';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useDimensions } from '@/lib/dimensions';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Line = { accountId: string; code: string; name: string; amount: string };
interface IS { revenue: Line[]; expenses: Line[]; totalRevenue: string; totalExpenses: string; netIncome: string }

export default function IncomeStatementPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const [departmentId, setDepartment] = useState('');
  const [projectId, setProject] = useState('');
  const dims = useDimensions();
  const departments = (dims.data?.values ?? []).filter((v) => v.type === 'DEPARTMENT');
  const projects = (dims.data?.values ?? []).filter((v) => v.type === 'PROJECT');
  const filter = `${departmentId ? `&departmentId=${departmentId}` : ''}${projectId ? `&projectId=${projectId}` : ''}`;
  const q = useQuery({ queryKey: ['is', orgId, from, to, departmentId, projectId], queryFn: () => api<IS>(`/v1/orgs/${orgId}/reports/income-statement?from=${from}&to=${to}${filter}`) });
  if (!org) return null;
  const c = org.functionalCurrency;
  const section = (title: string, lines: Line[], total: string) => (
    <>
      <tr><Td colSpan={2} className="bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</Td></tr>
      {lines.map((l) => (
        <Tr key={l.accountId}><Td><span className="num text-fg-muted">{l.code}</span> {l.name}</Td><Td numeric><Money value={l.amount} currency={c} signed /></Td></Tr>
      ))}
      <tr><Td className="font-semibold">Total {title.toLowerCase()}</Td><Td numeric className="font-semibold"><Money value={total} currency={c} /></Td></tr>
    </>
  );
  return (
    <>
      <PageHeader title="Profit and loss" description="Revenue and expenses from posted journals in the period." actions={<><DateInput label="From" value={from} onChange={setFrom} /><DateInput label="To" value={to} onChange={setTo} /><ExportButtons orgId={orgId} report="income-statement" params={{ from, to, departmentId, projectId }} /></>} />
      {departments.length || projects.length ? (
        <div className="mb-4 flex flex-wrap gap-3">
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
      ) : null}
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {q.data ? (
        <Card>
          <CardHeader title="Income statement" description={[org.name, c, departments.find((v) => v.id === departmentId)?.name, projects.find((v) => v.id === projectId)?.name].filter(Boolean).join(' · ')} />
          <Table>
            <tbody>
              {section('Revenue', q.data.revenue, q.data.totalRevenue)}
              {section('Expenses', q.data.expenses, q.data.totalExpenses)}
            </tbody>
            <tfoot>
              <tr><Td className="text-base font-semibold">Net income</Td><Td numeric className="text-base font-semibold"><Money value={q.data.netIncome} currency={c} signed /></Td></tr>
            </tfoot>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
