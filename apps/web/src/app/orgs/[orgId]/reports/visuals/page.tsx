'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { IncomeSankeyChart, monthLabel, SpendHeatmap, SpendTreemap, type SankeyNode, type Visuals, WaterfallChart, type WaterfallStep } from '@/components/reports/financial-visuals';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10); // not money

type Pick = { title: string; accountIds: string[] };

/**
 * Reports → Financial visuals (DASH-028 waterfall, DASH-029 Sankey, DASH-030 heatmap, DASH-031
 * treemap, DASH-034 drill-down): the profit and loss of a range of months drawn four ways, from
 * posted journals. Choosing a bar, a flow or a block shows the accounts behind it and opens their
 * general ledger for the same months.
 */
export default function FinancialVisualsPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const [to, setTo] = useState(() => today().slice(0, 7));
  const [from, setFrom] = useState(() => shift(today().slice(0, 7), -11));
  const [pick, setPick] = useState<Pick | null>(null);
  const q = useQuery({ queryKey: ['visuals', orgId, from, to], queryFn: () => api<Visuals>(`/v1/orgs/${orgId}/reports/visuals?from=${from}&to=${to}`), enabled: /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to) });
  if (!org) return null;
  const v = q.data;
  const c = v?.currency ?? org.functionalCurrency;
  const ledger = (accountId: string, month?: string) => `/orgs/${orgId}/reports/general-ledger?accountId=${accountId}&from=${month ? `${month}-01` : v?.fromDate}&to=${month ? lastDay(month) : v?.toDate}`;
  const pickStep = (s: WaterfallStep) => setPick(s.accountIds.length ? { title: s.label, accountIds: s.accountIds } : null);
  const pickNode = (n: SankeyNode) => {
    if (n.accountId) return router.push(ledger(n.accountId));
    if (n.kind === 'GROUP' && v) {
      const group = v.treemap.groups.find((g) => `G:${g.key}` === n.key);
      if (group) setPick({ title: group.label, accountIds: group.accounts.map((a) => a.accountId) });
    }
    if (n.kind === 'INCOME' && v) setPick({ title: 'Income', accountIds: v.accounts.filter((a) => a.type === 'REVENUE').map((a) => a.id) });
  };
  const picked = pick && v ? v.accounts.filter((a) => pick.accountIds.includes(a.id)) : [];
  return (
    <>
      <PageHeader
        title="Financial visuals"
        description="The profit and loss of the months you choose, drawn four ways from posted journals: how revenue becomes profit, where income goes, when spending happens and what it is made of. Choose any bar, flow or block to see the accounts behind it and open their ledger."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From month">{(p) => <Input {...p} type="month" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To month">{(p) => <Input {...p} type="month" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        {v ? <p className="pb-2 text-sm text-fg-muted">{monthLabel(v.from)} to {monthLabel(v.to)}: income <Money value={v.sankey.income} currency={c} />, {Number(v.sankey.profit) >= 0 ? 'profit' : 'loss'} <Money value={v.sankey.profit} currency={c} signed /></p> : null}
      </div>
      <ErrorAlert title="Could not draw the visuals" error={q.error} />
      {v?.empty ? <EmptyState title="Nothing posted in these months">Post invoices, bills, expenses or journals, or choose other months.</EmptyState> : null}
      {v && !v.empty ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card role="region" aria-label="From revenue to profit" className="xl:col-span-2">
            <CardHeader title="From revenue to profit" description="A waterfall: revenue, then each kind of cost taking it down, with gross, operating and net profit as subtotals. Choose a bar to see its accounts." />
            <div className="px-2"><WaterfallChart steps={v.waterfall} currency={c} onPick={pickStep} /></div>
            <Table aria-label="Waterfall steps">
              <thead><Tr><Th>Step</Th><Th numeric>Amount</Th><Th numeric>Running total</Th></Tr></thead>
              <tbody>
                {v.waterfall.map((s) => (
                  <Tr key={s.key}>
                    <Td className={s.kind === 'SUBTOTAL' ? 'font-semibold' : ''}>{s.accountIds.length ? <button type="button" className="text-left hover:text-accent" onClick={() => pickStep(s)}>{s.label}</button> : s.label}</Td>
                    <Td numeric className={s.kind === 'SUBTOTAL' ? 'font-semibold' : ''}><Money value={s.amount} currency={c} signed={s.kind === 'UP' || s.kind === 'DOWN'} /></Td>
                    <Td numeric><Money value={s.to} currency={c} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          {pick ? (
            <Card role="region" aria-label="Accounts behind the figure" className="xl:col-span-2">
              <CardHeader title="Accounts behind the figure" description={`${pick.title}, ${monthLabel(v.from)} to ${monthLabel(v.to)}. Open an account to see every entry.`} />
              <Table aria-label={`Accounts in ${pick.title}`}>
                <thead><Tr><Th>Account</Th><Th numeric>Amount</Th></Tr></thead>
                <tbody>
                  {picked.map((a) => (
                    <Tr key={a.id}><Td><span className="num text-fg-muted">{a.code}</span> <Link className="hover:text-accent" href={ledger(a.id)}>{a.name}</Link></Td><Td numeric><Money value={a.total} currency={c} /></Td></Tr>
                  ))}
                </tbody>
              </Table>
              <div className="px-4 pb-3"><button type="button" className="text-sm text-accent hover:underline" onClick={() => setPick(null)}>Close</button></div>
            </Card>
          ) : null}
          <Card role="region" aria-label="Where income goes" className="xl:col-span-2">
            <CardHeader title="Where income goes" description="A Sankey of the period: each revenue account flows into income, which flows to each kind of spending and its largest accounts, and to profit. A loss flows in as a source." />
            <IncomeSankeyChart sankey={v.sankey} currency={c} onPick={pickNode} />
            <details className="px-4 pb-3 text-sm">
              <summary className="cursor-pointer text-fg-muted">The flows as a table</summary>
              <Table aria-label="Income flows">
                <thead><Tr><Th>From</Th><Th>To</Th><Th numeric>Amount</Th></Tr></thead>
                <tbody>
                  {v.sankey.links.map((l) => (
                    <Tr key={`${l.source}-${l.target}`}><Td>{v.sankey.nodes[l.source]?.label}</Td><Td>{v.sankey.nodes[l.target]?.label}</Td><Td numeric><Money value={l.amount} currency={c} /></Td></Tr>
                  ))}
                </tbody>
              </Table>
            </details>
            {v.sankey.leftOut.length ? <p className="px-4 pb-4 text-xs text-fg-muted">{v.sankey.leftOut.length} account{v.sankey.leftOut.length === 1 ? '' : 's'} with a balance against its nature (such as a revenue account in debit) {v.sankey.leftOut.length === 1 ? 'is' : 'are'} left out of the flow.</p> : null}
          </Card>
          <Card role="region" aria-label="Spending heatmap" className="xl:col-span-2">
            <CardHeader title="Spending heatmap" description="A heatmap of the largest expense accounts month by month. Choose a cell to open that month's ledger." />
            <SpendHeatmap heatmap={v.heatmap} currency={c} ledger={ledger} />
          </Card>
          <Card role="region" aria-label="What spending is made of" className="xl:col-span-2">
            <CardHeader title="What spending is made of" description="A treemap of spending by group and account, sized by amount. Choose a block to open its ledger." />
            <SpendTreemap treemap={v.treemap} currency={c} onOpen={(id) => router.push(ledger(id))} />
            <Table aria-label="Spending groups">
              <thead><Tr><Th>Group</Th><Th numeric>Amount</Th><Th numeric>Share</Th></Tr></thead>
              <tbody>
                {v.treemap.groups.map((g) => (
                  <Tr key={g.key}>
                    <Td><button type="button" className="text-left hover:text-accent" onClick={() => setPick({ title: g.label, accountIds: g.accounts.map((a) => a.accountId) })}>{g.label}</button></Td>
                    <Td numeric><Money value={g.amount} currency={c} /></Td>
                    <Td numeric>{g.share}%</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : null}
    </>
  );
}
