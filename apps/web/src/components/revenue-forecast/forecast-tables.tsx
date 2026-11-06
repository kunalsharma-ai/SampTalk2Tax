'use client';
import { Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { Money } from '@/components/money';
import { monthLabel, STREAM_LABEL, type ForecastItem, type ForecastMonth } from '@/lib/revenue-forecast';

export function ForecastTable({ months, totals, currency, label = 'Revenue forecast by month' }: { months: ForecastMonth[]; totals: { committed: string; expected: string; best: string } & Partial<ForecastMonth>; currency: string; label?: string }) {
  const c = currency;
  return (
    <Table aria-label={label}>
      <thead>
        <tr><Th>Month</Th><Th numeric>Contracts</Th><Th numeric>Sales orders</Th><Th numeric>Pipeline (weighted)</Th><Th numeric>Other sales</Th><Th numeric>Committed</Th><Th numeric>Expected</Th><Th numeric>Best case</Th></tr>
      </thead>
      <tbody>
        {months.map((m) => (
          <Tr key={m.month}>
            <Td className="whitespace-nowrap">{monthLabel(m.month)}</Td>
            <Td numeric><Money value={m.contracts} currency={c} /></Td>
            <Td numeric><Money value={m.orders} currency={c} /></Td>
            <Td numeric><Money value={m.pipelineWeighted} currency={c} /></Td>
            <Td numeric><Money value={m.otherSales} currency={c} /></Td>
            <Td numeric><Money value={m.committed} currency={c} /></Td>
            <Td numeric className="font-semibold"><Money value={m.expected} currency={c} /></Td>
            <Td numeric><Money value={m.best} currency={c} /></Td>
          </Tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <Td className="font-semibold">Total</Td>
          <Td numeric className="font-semibold">{totals.contracts ? <Money value={totals.contracts} currency={c} /> : null}</Td>
          <Td numeric className="font-semibold">{totals.orders ? <Money value={totals.orders} currency={c} /> : null}</Td>
          <Td numeric className="font-semibold">{totals.pipelineWeighted ? <Money value={totals.pipelineWeighted} currency={c} /> : null}</Td>
          <Td numeric className="font-semibold">{totals.otherSales ? <Money value={totals.otherSales} currency={c} /> : null}</Td>
          <Td numeric className="font-semibold"><Money value={totals.committed} currency={c} /></Td>
          <Td numeric className="font-semibold"><Money value={totals.expected} currency={c} /></Td>
          <Td numeric className="font-semibold"><Money value={totals.best} currency={c} /></Td>
        </tr>
      </tfoot>
    </Table>
  );
}

const href = (orgId: string, i: ForecastItem) => `/orgs/${orgId}/sales/${i.stream === 'CONTRACT' ? 'contracts' : i.stream === 'ORDER' ? 'orders' : 'pipeline'}/${i.id}`;

export function ForecastItems({ items, orgId, currency }: { items: ForecastItem[]; orgId: string; currency: string }) {
  if (!items.length) return <p className="px-5 py-4 text-sm text-fg-muted">No contracts, open orders or open deals in these months.</p>;
  return (
    <Table aria-label="What the forecast is made of">
      <thead><tr><Th>Month</Th><Th>From</Th><Th>Reference</Th><Th>Customer</Th><Th>What</Th><Th numeric>Amount</Th><Th numeric>Expected</Th></tr></thead>
      <tbody>
        {items.map((i, k) => (
          <Tr key={`${i.stream}-${i.id}-${i.month}-${k}`}>
            <Td className="whitespace-nowrap">{monthLabel(i.month)}</Td>
            <Td>{STREAM_LABEL[i.stream]}</Td>
            <Td className="num"><Link className="text-accent hover:underline" href={href(orgId, i)}>{i.reference}</Link></Td>
            <Td>{i.customer}</Td>
            <Td className="text-fg-muted">{i.label}</Td>
            <Td numeric><Money value={i.amount} currency={currency} /></Td>
            <Td numeric><Money value={i.expected} currency={currency} /></Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
