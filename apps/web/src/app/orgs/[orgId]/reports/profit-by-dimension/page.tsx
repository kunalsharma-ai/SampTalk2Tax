'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, EmptyState, SectionHelpSlot, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { ExportButtons } from '@/components/reports/export-buttons';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { DimensionType, ProfitByDimension } from '@/lib/dimensions';
import { useFinancialTags, type ProfitByTag } from '@/lib/financial-tags';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function ProfitByDimensionPage() {
  const { org, orgId } = useOrg();
  const [type, setType] = useState<DimensionType>('DEPARTMENT');
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const [inactive, setInactive] = useState(false);
  const [tagKey, setTagKey] = useState<string | null>(null);
  const tags = useFinancialTags();
  const q = useQuery({
    enabled: !tagKey,
    queryKey: ['profit-by-dimension', orgId, type, from, to, inactive],
    queryFn: () => api<ProfitByDimension>(`/v1/orgs/${orgId}/dimensions/profit?type=${type}&from=${from}&to=${to}${inactive ? '&includeInactive=true' : ''}`),
  });
  if (!org) return null;
  const c = org.functionalCurrency;
  const r = tagKey ? undefined : q.data;
  const tag = tags.data?.items.find((t) => t.key === tagKey);
  const cols = r ? r.columns.length + 1 : 2;
  const noValues = r && r.columns.length === 1;
  return (
    <>
      <PageHeader
        title="Profit by department, project or tag"
        description="Revenue and expenses from posted journals, split by the department, project or tag (such as a location) on each line. Lines without one are in their own column, so every column adds up to the profit and loss."
        actions={<><DateInput label="From" value={from} onChange={setFrom} /><DateInput label="To" value={to} onChange={setTo} />{tagKey ? null : <ExportButtons orgId={orgId} report="profit-by-dimension" params={{ type, from, to, includeInactive: inactive }} />}</>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Split by">
          {(['DEPARTMENT', 'PROJECT'] as const).map((t) => (
            <Button key={t} role="tab" aria-selected={!tagKey && type === t} size="sm" variant={!tagKey && type === t ? 'primary' : 'ghost'} onClick={() => { setType(t); setTagKey(null); }}>
              By {t === 'DEPARTMENT' ? 'department' : 'project'}
            </Button>
          ))}
          {(tags.data?.items ?? []).map((t) => (
            <Button key={t.key} role="tab" aria-selected={tagKey === t.key} size="sm" variant={tagKey === t.key ? 'primary' : 'ghost'} onClick={() => setTagKey(t.key)}>
              By {t.label.toLowerCase()}
            </Button>
          ))}
          <Link className="self-center text-xs text-accent underline" href={`/orgs/${orgId}/financial-tags`}>Locations and tags</Link>
        </div>
        {tagKey ? null : <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />
          Show inactive ones with nothing posted
        </label>}
      </div>
      {tag ? <TagProfit orgId={orgId} tagKey={tag.key} label={tag.label} from={from} to={to} currency={c} orgName={org.name} /> : null}
      {!tagKey && q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
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

/** Profit and loss with a column per value of one financial tag, untagged lines last. */
function TagProfit({ orgId, tagKey, label, from, to, currency: c, orgName }: { orgId: string; tagKey: string; label: string; from: string; to: string; currency: string; orgName: string }) {
  const q = useQuery({
    queryKey: ['profit-by-tag', orgId, tagKey, from, to],
    queryFn: () => api<ProfitByTag>(`/v1/orgs/${orgId}/reports/profit-by-tag?key=${tagKey}&from=${from}&to=${to}`),
  });
  const r = q.data;
  if (q.error) return <Alert title="Could not load">{(q.error as Error).message}</Alert>;
  if (!r) return null;
  if (!r.columns.length) {
    return (
      <Card>
        <EmptyState title="Nothing posted in this period">Tag journal lines with a {label.toLowerCase()} to split the profit.</EmptyState>
      </Card>
    );
  }
  const section = (type: 'REVENUE' | 'EXPENSE') => {
    const rows = r.rows.filter((x) => x.type === type);
    const totals = r.columns.map((col) => (type === 'REVENUE' ? col.revenue : col.expenses));
    return (
      <Fragment key={type}>
        <tr><Td colSpan={r.columns.length + 2} className="bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">{type === 'REVENUE' ? 'Revenue' : 'Expenses'}</Td></tr>
        {rows.map((row) => (
          <Tr key={row.accountId}>
            <Td className="whitespace-nowrap"><span className="num text-fg-muted">{row.code}</span> {row.name}</Td>
            {row.amounts.map((a, i) => <Td key={i} numeric>{/^-?0(\.0+)?$/.test(a) ? <span className="text-fg-faint">—</span> : <Money value={a} currency={c} signed />}</Td>)}
            <Td numeric className="font-medium"><Money value={row.total} currency={c} signed /></Td>
          </Tr>
        ))}
        <tr>
          <Td className="font-semibold">Total {type === 'REVENUE' ? 'revenue' : 'expenses'}</Td>
          {totals.map((t, i) => <Td key={i} numeric className="font-semibold"><Money value={t} currency={c} /></Td>)}
          <Td numeric className="font-semibold"><Money value={type === 'REVENUE' ? r.total.revenue : r.total.expenses} currency={c} /></Td>
        </tr>
      </Fragment>
    );
  };
  return (
    <Card className="overflow-x-auto">
      <CardHeader title={`By ${label.toLowerCase()}`} help={<SectionHelpSlot title="Profit by tag" />} description={`${orgName} · ${c}`} />
      <Table aria-label={`Profit by ${label.toLowerCase()}`}>
        <thead>
          <tr>
            <Th>Account</Th>
            {r.columns.map((col) => <Th key={col.code ?? 'none'} numeric>{col.name}</Th>)}
            <Th numeric>Total</Th>
          </tr>
        </thead>
        <tbody>{section('REVENUE')}{section('EXPENSE')}</tbody>
        <tfoot>
          <tr>
            <Td className="text-base font-semibold">Net profit</Td>
            {r.columns.map((col) => <Td key={col.code ?? 'none'} numeric className="text-base font-semibold"><Money value={col.netIncome} currency={c} signed /></Td>)}
            <Td numeric className="text-base font-semibold"><Money value={r.total.netIncome} currency={c} signed /></Td>
          </tr>
        </tfoot>
      </Table>
    </Card>
  );
}
