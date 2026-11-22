'use client';
import { useQuery } from '@tanstack/react-query';
import { TAX_FORECAST_METHOD_LABEL, type TaxForecastItem } from '@talk2tax/tax-engine';
import { Alert, Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Forecast {
  asOf: string;
  to: string;
  horizon: number;
  currency: string;
  configured: boolean;
  areas: { gst: boolean; withholding: boolean; payroll: boolean; advanceTax: boolean };
  overdue: number;
  items: TaxForecastItem[];
  months: { month: string; amount: string; low: string; high: string; known: string; payments: number }[];
  totals: { amount: string; low: string; high: string; known: string };
}
const METHOD_TONE = { KNOWN: 'accent', PLAN: 'violet', AVERAGE: 'neutral', NO_HISTORY: 'neutral' } as const;
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Tax → Tax forecast (TAX-048): the tax payments due in the coming months and what they are likely to be. */
export default function TaxForecastPage() {
  const { org, orgId } = useOrg();
  const [months, setMonths] = useState('3');
  const q = useQuery({ queryKey: ['tax-forecast', orgId, months], queryFn: () => api<Forecast>(`/v1/orgs/${orgId}/tax-forecast?months=${months}`) });
  if (!org) return null;
  const f = q.data;
  const c = f?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Tax forecast"
        description="The tax payments due in the coming months: GST, TDS and TCS, PF, ESI and professional tax, and advance income tax. Where the period is over the amount comes from the books; advance tax comes from your plan; otherwise it is the recent average, with a likely range. Plan cash with it; it is not a return."
        actions={<div className="w-40"><Select aria-label="Months ahead" value={months} onChange={(e) => setMonths(e.target.value)}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} month{n === 1 ? '' : 's'}</option>)}</Select></div>}
      />
      <ErrorAlert title="Could not work out the tax forecast" error={q.error} />
      {f && !f.configured ? (
        <Alert tone="accent" title="Nothing to forecast yet">Set up GST, TDS/TCS, payroll or advance tax tracking first; the forecast follows the <Link className="underline" href={`/orgs/${orgId}/tax/compliance`}>compliance calendar</Link>.</Alert>
      ) : null}
      {f && f.configured ? (
        <>
          {f.overdue ? <div className="mb-4"><Alert tone="negative" title={`${f.overdue} payment${f.overdue === 1 ? ' is' : 's are'} overdue`}>Pay {f.overdue === 1 ? 'it' : 'them'} first: interest runs from the due date.</Alert></div> : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4"><p className="text-sm text-fg-muted">Expected to pay</p><p className="mt-1 text-2xl font-semibold"><Money value={f.totals.amount} currency={c} /></p><p className="text-xs text-fg-muted">Likely <Money value={f.totals.low} currency={c} /> to <Money value={f.totals.high} currency={c} />, by {date(f.to)}</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Known from the books and plan</p><p className="mt-1 text-2xl font-semibold"><Money value={f.totals.known} currency={c} /></p><p className="text-xs text-fg-muted">Periods already over, and advance tax</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Payments</p><p className="mt-1 text-2xl font-semibold">{f.items.length}</p><p className="text-xs text-fg-muted">{f.months.length} month{f.months.length === 1 ? '' : 's'} with something due</p></Card>
          </div>
          <Card className="mt-6" role="region" aria-label="Tax due by month">
            <CardHeader title="Tax due by month" description="What falls due each month, by due date, with the part already known." />
            {f.months.length ? (
              <Table aria-label="Tax due by month">
                <thead><Tr><Th>Month</Th><Th numeric>Payments</Th><Th numeric>Known</Th><Th numeric>Expected</Th><Th numeric>Likely range</Th></Tr></thead>
                <tbody>
                  {f.months.map((m) => (
                    <Tr key={m.month}>
                      <Td>{monthName(m.month)}</Td>
                      <Td numeric>{m.payments}</Td>
                      <Td numeric><Money value={m.known} currency={c} /></Td>
                      <Td numeric className="font-semibold"><Money value={m.amount} currency={c} /></Td>
                      <Td numeric className="text-sm text-fg-muted"><Money value={m.low} currency={c} /> to <Money value={m.high} currency={c} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nothing due">No tax payments fall due in this window.</EmptyState>
            )}
          </Card>
          {f.items.length ? (
            <Card className="mt-6" role="region" aria-label="Each payment">
              <CardHeader title="Each payment" description="Every payment due, with where its amount comes from." />
              <Table aria-label="Each payment">
                <thead><Tr><Th>Due</Th><Th>Payment</Th><Th>Period</Th><Th>Based on</Th><Th numeric>Amount</Th></Tr></thead>
                <tbody>
                  {f.items.map((i) => (
                    <Tr key={i.key}>
                      <Td className={`align-top ${i.dueDate < f.asOf ? 'text-negative' : ''}`}>{date(i.dueDate)}{i.dueDate < f.asOf ? <span className="block text-xs">Overdue</span> : null}</Td>
                      <Td className="align-top">{i.name}</Td>
                      <Td className="align-top">{i.periodLabel}</Td>
                      <Td className="align-top"><Badge tone={METHOD_TONE[i.method]}>{TAX_FORECAST_METHOD_LABEL[i.method]}</Badge><span className="mt-1 block max-w-md text-xs text-fg-muted">{i.basis}</span></Td>
                      <Td numeric className="align-top"><Money value={i.amount} currency={c} />{i.low !== i.high ? <span className="block text-xs text-fg-muted"><Money value={i.low} currency={c} /> to <Money value={i.high} currency={c} /></span> : null}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
