'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, CardHeader, Table, Td, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { SavedViews } from '@/components/reports/saved-views';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Group = 'NON_CASH' | 'WORKING_CAPITAL' | 'INVESTING' | 'FINANCING' | 'UNCLASSIFIED';
type Line = { accountId: string; code: string; name: string; subtype: string | null; group: Group; amount: string };
interface Section { lines: Line[]; total: string }
interface CashFlow {
  currency: string;
  profit: string;
  operating: Section;
  investing: Section;
  financing: Section;
  netChange: string;
  openingCash: string;
  closingCash: string;
  reconciles: boolean;
  unexplained: string;
  unclassified: string[];
}

const GROUP_LABEL: Record<Group, string> = {
  NON_CASH: 'Add back: no cash moved',
  WORKING_CAPITAL: 'Changes in working capital',
  UNCLASSIFIED: 'Other balances (no account subtype)',
  INVESTING: '',
  FINANCING: '',
};

export default function CashFlowStatementPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const bad = from > to;
  const q = useQuery({ queryKey: ['cash-flow-statement', orgId, from, to], enabled: !bad, queryFn: () => api<CashFlow>(`/v1/orgs/${orgId}/reports/cash-flow-statement?from=${from}&to=${to}`) });
  if (!org) return null;
  const c = q.data?.currency ?? org.functionalCurrency;
  const ledger = (l: Line) => <Link className="hover:text-accent" href={`/orgs/${orgId}/reports/general-ledger?accountId=${l.accountId}&from=${from}&to=${to}`}>{l.name}</Link>;
  const rows = (lines: Line[]) => {
    let last: Group | null = null;
    return lines.flatMap((l) => {
      const head = l.group !== last && GROUP_LABEL[l.group] ? [<tr key={`h-${l.group}`}><Td colSpan={2} className="pl-8 text-xs text-fg-muted">{GROUP_LABEL[l.group]}</Td></tr>] : [];
      last = l.group;
      return [...head, <Tr key={l.accountId}><Td className="pl-8"><span className="num text-fg-muted">{l.code}</span> {ledger(l)}</Td><Td numeric><Money value={l.amount} currency={c} signed /></Td></Tr>];
    });
  };
  const heading = (title: string) => <tr><Td colSpan={2} className="bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</Td></tr>;
  const total = (label: string, value: string) => <tr><Td className="font-semibold">{label}</Td><Td numeric className="font-semibold"><Money value={value} currency={c} signed /></Td></tr>;
  const none = (s: Section) => (s.lines.length ? null : <tr><Td colSpan={2} className="pl-8 text-sm text-fg-muted">Nothing in this period.</Td></tr>);
  return (
    <>
      <PageHeader
        title="Cash flow statement"
        description="Where the period's cash came from and went, by the indirect method: profit, adjusted for items with no cash and for working capital, then investing and financing. It explains the change in your cash and bank accounts."
        actions={<><DateInput label="From" value={from} onChange={setFrom} /><DateInput label="To" value={to} onChange={setTo} /></>}
      />
      <SavedViews orgId={orgId} report="cash-flow-statement" current={{ from, to }} onApply={(v) => { setFrom(v.from ?? from); setTo(v.to); }} />
      {bad ? <Alert tone="warning" title="Check the dates">The start date is after the end date.</Alert> : null}
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {q.data && !q.data.reconciles ? (
        <Alert tone="negative" title="The statement does not add up">The sections differ from the change in cash and bank by <Money value={q.data.unexplained} currency={c} signed />. Posted journals should always balance, so check the trial balance for this period.</Alert>
      ) : null}
      {q.data && q.data.unclassified.length ? (
        <Alert tone="warning" title="Some accounts have no subtype">{q.data.unclassified.join(', ')} {q.data.unclassified.length === 1 ? 'is' : 'are'} shown under operating activities. Give each a subtype in the chart of accounts to place it correctly.</Alert>
      ) : null}
      {q.data ? (
        <Card>
          <CardHeader title="Statement of cash flows" description={`${org.name} · ${c} · indirect method`} />
          <Table>
            <tbody>
              {heading('Operating activities')}
              <Tr><Td className="pl-8"><Link className="hover:text-accent" href={`/orgs/${orgId}/reports/income-statement`}>Profit for the period</Link></Td><Td numeric><Money value={q.data.profit} currency={c} signed /></Td></Tr>
              {rows(q.data.operating.lines)}
              {total('Net cash from operating activities', q.data.operating.total)}
              {heading('Investing activities')}
              {rows(q.data.investing.lines)}
              {none(q.data.investing)}
              {total('Net cash from investing activities', q.data.investing.total)}
              {heading('Financing activities')}
              {rows(q.data.financing.lines)}
              {none(q.data.financing)}
              {total('Net cash from financing activities', q.data.financing.total)}
            </tbody>
            <tfoot>
              {total('Net change in cash and bank', q.data.netChange)}
              <tr><Td className="text-fg-muted">Cash and bank at the start</Td><Td numeric className="text-fg-muted"><Money value={q.data.openingCash} currency={c} /></Td></tr>
              <tr><Td className="text-base font-semibold">Cash and bank at the end</Td><Td numeric className="text-base font-semibold"><Money value={q.data.closingCash} currency={c} /></Td></tr>
            </tfoot>
          </Table>
          <p className="border-t border-line px-5 py-4 text-sm text-fg-muted" role="note">
            Positive amounts brought cash in; negative amounts used it. A rise in receivables, stock or prepayments uses cash; a rise in payables, accruals or taxes owed keeps it. Year-end closing entries are left out.
          </p>
        </Card>
      ) : null}
    </>
  );
}
