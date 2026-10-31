'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CardHeader, Table, Td, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Line = { accountId: string; code: string; name: string; amount: string };
interface IS { revenue: Line[]; expenses: Line[]; totalRevenue: string; totalExpenses: string; netIncome: string }

export default function IncomeStatementPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const q = useQuery({ queryKey: ['is', orgId, from, to], queryFn: () => api<IS>(`/v1/orgs/${orgId}/reports/income-statement?from=${from}&to=${to}`) });
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
      <PageHeader title="Profit and loss" description="Revenue and expenses from posted journals in the period." actions={<><DateInput label="From" value={from} onChange={setFrom} /><DateInput label="To" value={to} onChange={setTo} /></>} />
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {q.data ? (
        <Card>
          <CardHeader title="Income statement" description={`${org.name} · ${c}`} />
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
