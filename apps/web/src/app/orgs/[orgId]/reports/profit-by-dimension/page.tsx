'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { DimensionType, ProfitByDimension } from '@/lib/dimensions';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function ProfitByDimensionPage() {
  const { org, orgId } = useOrg();
  const [type, setType] = useState<DimensionType>('DEPARTMENT');
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const [inactive, setInactive] = useState(false);
  const q = useQuery({
    queryKey: ['profit-by-dimension', orgId, type, from, to, inactive],
    queryFn: () => api<ProfitByDimension>(`/v1/orgs/${orgId}/dimensions/profit?type=${type}&from=${from}&to=${to}${inactive ? '&includeInactive=true' : ''}`),
  });
  if (!org) return null;
  const c = org.functionalCurrency;
  const r = q.data;
  const cols = r ? r.columns.length + 1 : 2;
  const noValues = r && r.columns.length === 1;
  return (
    <>
      <PageHeader
        title="Profit by department or project"
        description="Revenue and expenses from posted journals, split by the department or project on each line. Lines without one are under Not assigned, so every column adds up to the profit and loss."
        actions={<><DateInput label="From" value={from} onChange={setFrom} /><DateInput label="To" value={to} onChange={setTo} /></>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Split by">
          {(['DEPARTMENT', 'PROJECT'] as const).map((t) => (
            <Button key={t} role="tab" aria-selected={type === t} size="sm" variant={type === t ? 'primary' : 'ghost'} onClick={() => setType(t)}>
              By {t === 'DEPARTMENT' ? 'department' : 'project'}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />
          Show inactive ones with nothing posted
        </label>
      </div>
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {noValues ? (
        <Card className="mb-4">
          <EmptyState title={`No ${type === 'DEPARTMENT' ? 'departments' : 'projects'} yet`}>
            <Link className="text-accent underline" href={`/orgs/${orgId}/dimensions`}>Add them</Link> and tag journal, invoice and bill lines to split the profit.
          </EmptyState>
        </Card>
      ) : null}
      {r ? (
        <Card className="overflow-x-auto">
          <CardHeader title={type === 'DEPARTMENT' ? 'By department' : 'By project'} description={`${org.name} · ${c}`} />
          <Table aria-label="Profit by department or project">
            <thead>
              <tr>
                <Th>Account</Th>
                {r.columns.map((col) => <Th key={col.id ?? 'none'} numeric>{col.name}</Th>)}
                <Th numeric>Total</Th>
              </tr>
            </thead>
            <tbody>
              {r.sections.map((s) => (
                <Fragment key={s.type}>
                  <tr><Td colSpan={cols + 1} className="bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">{s.type === 'REVENUE' ? 'Revenue' : 'Expenses'}</Td></tr>
                  {s.rows.map((row) => (
                    <Tr key={row.accountId}>
                      <Td className="whitespace-nowrap"><span className="num text-fg-muted">{row.code}</span> {row.name}</Td>
                      {row.amounts.map((a, i) => <Td key={i} numeric>{a === '0.00' ? <span className="text-fg-faint">—</span> : <Money value={a} currency={c} signed />}</Td>)}
                      <Td numeric className="font-medium"><Money value={row.total} currency={c} signed /></Td>
                    </Tr>
                  ))}
                  <tr>
                    <Td className="font-semibold">Total {s.type === 'REVENUE' ? 'revenue' : 'expenses'}</Td>
                    {s.totals.map((t, i) => <Td key={i} numeric className="font-semibold"><Money value={t} currency={c} /></Td>)}
                    <Td numeric className="font-semibold"><Money value={s.total} currency={c} /></Td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <Td className="text-base font-semibold">Net profit</Td>
                {r.netProfit.map((n, i) => <Td key={i} numeric className="text-base font-semibold"><Money value={n} currency={c} signed /></Td>)}
                <Td numeric className="text-base font-semibold"><Money value={r.netProfitTotal} currency={c} signed /></Td>
              </tr>
              <tr>
                <Td className="text-xs text-fg-muted">Margin</Td>
                {r.margin.map((m, i) => <Td key={i} numeric className="text-xs text-fg-muted">{m === null ? '—' : `${m}%`}</Td>)}
                <Td />
              </tr>
            </tfoot>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
