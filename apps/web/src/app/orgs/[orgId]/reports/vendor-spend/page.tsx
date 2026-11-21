'use client';
import { useQuery } from '@tanstack/react-query';
import { monthLabel } from '@talk2tax/accounting-engine';
import { Alert, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import { DateInput, fyStartFor } from '@/components/report-bits';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Row { id: string; name: string; amount: string; share: string | null }
interface Spend {
  currency: string;
  previous: { from: string; to: string };
  total: string;
  previousTotal: string;
  change: string;
  vendorsFor80Percent: number;
  vendors: (Row & { bills: number; previous: string; change: string })[];
  accounts: (Row & { code: string })[];
  months: { month: string; amount: string }[];
}

const pct = (share: string | null) => (share === null ? '—' : `${(Number(share) * 100).toFixed(1)}%`); // not money: a share
const bar = (share: string | null) => ({ width: `${Math.max(0, Math.min(100, Number(share ?? 0) * 100))}%` }); // not money: a bar width

/** Vendor spending (RPT-016): who the organisation buys from and on what. */
export default function VendorSpendPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const bad = from > to;
  const q = useQuery({ queryKey: ['vendor-spend', orgId, from, to], enabled: !bad, queryFn: () => api<Spend>(`/v1/orgs/${orgId}/reports/vendor-spend?from=${from}&to=${to}`) });
  if (!org) return null;
  const c = q.data?.currency ?? org.functionalCurrency;
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Vendor spend"
        description="Posted bills before tax, less vendor credits, by vendor, account and month, in your currency at each bill's own rate. Compared with the same number of days just before."
        actions={<><DateInput label="From" value={from} onChange={setFrom} /><DateInput label="To" value={to} onChange={setTo} /></>}
      />
      {bad ? <Alert tone="warning" title="Check the dates">The start date is after the end date.</Alert> : null}
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Stat label="Spend" value={<Money value={d.total} currency={c} />} sub={`${d.vendors.filter((v) => v.amount !== '0.00').length} vendors`} />
            <Stat label="Period before" value={<Money value={d.previousTotal} currency={c} />} sub={`${date(d.previous.from)} to ${date(d.previous.to)}`} />
            <Stat label="Change" value={<Money value={d.change} currency={c} signed />} sub={d.vendorsFor80Percent ? `${d.vendorsFor80Percent} vendor${d.vendorsFor80Percent === 1 ? ' makes' : 's make'} up 80% of spend` : 'No spend in the period'} tone={d.change.startsWith('-') ? 'positive' : 'neutral'} />
          </div>
          {!d.vendors.length ? (
            <Card><EmptyState title="No bills in these dates">Posted bills and vendor credits show here.</EmptyState></Card>
          ) : (
            <>
              <Card className="mb-4">
                <CardHeader title="Spend by vendor" description="Largest first, with the period before" />
                <Table>
                  <thead><Tr><Th>Vendor</Th><Th numeric>Bills</Th><Th numeric>Spend</Th><Th>Share</Th><Th numeric>Period before</Th><Th numeric>Change</Th></Tr></thead>
                  <tbody>
                    {d.vendors.map((v) => (
                      <Tr key={v.id}>
                        <Td><Link className="hover:text-accent" href={`/orgs/${orgId}/purchases/vendors/${v.id}`}>{v.name}</Link></Td>
                        <Td numeric>{v.bills}</Td>
                        <Td numeric><Money value={v.amount} currency={c} signed /></Td>
                        <Td className="w-1/5"><div className="flex items-center gap-2"><div className="h-2 flex-1 rounded bg-surface-raised"><div className="h-2 rounded bg-[var(--t2t-accent)]" style={bar(v.share)} /></div><span className="num w-14 text-right text-xs text-fg-muted">{pct(v.share)}</span></div></Td>
                        <Td numeric className="text-fg-muted"><Money value={v.previous} currency={c} /></Td>
                        <Td numeric><Money value={v.change} currency={c} signed /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Spend by account" description="What the money went on" />
                  <Table>
                    <tbody>
                      {d.accounts.map((a) => (
                        <Tr key={a.id}>
                          <Td><span className="num text-fg-muted">{a.code}</span> <Link className="hover:text-accent" href={`/orgs/${orgId}/reports/general-ledger?accountId=${a.id}&from=${from}&to=${to}`}>{a.name}</Link></Td>
                          <Td numeric><Money value={a.amount} currency={c} signed /></Td>
                          <Td numeric className="text-xs text-fg-muted">{pct(a.share)}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
                <Card>
                  <CardHeader title="Spend by month" description="By bill date" />
                  <Table>
                    <tbody>
                      {d.months.map((m) => <Tr key={m.month}><Td>{monthLabel(m.month)}</Td><Td numeric><Money value={m.amount} currency={c} signed /></Td></Tr>)}
                    </tbody>
                  </Table>
                </Card>
              </div>
            </>
          )}
        </>
      ) : null}
    </>
  );
}
