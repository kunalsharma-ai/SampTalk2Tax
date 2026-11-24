'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Card, Table, Td, Th, Tr } from '@talk2tax/ui';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Money } from '@/components/money';
import { date, money } from '@/lib/format';
import { monthLabel } from '@/lib/kpis';

export type PortalAgingBucket = 'CURRENT' | 'DAYS_1_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'OVER_90';
export interface PortalDashboardData {
  currency: string;
  aging: { total: string; overdue: string; buckets: { bucket: PortalAgingBucket; amount: string; count: number; share: string | null }[] };
  nextDue: { date: string; amount: string; items: number } | null;
  dueIn30Days: string;
  months: { month: string; invoiced: string; paid: string }[];
  lastTwelveMonths: { invoiced: string; paid: string };
}

const BUCKET: Record<PortalAgingBucket, string> = { CURRENT: 'Not yet due', DAYS_1_30: '1–30 days late', DAYS_31_60: '31–60 days late', DAYS_61_90: '61–90 days late', OVER_90: 'Over 90 days late' };
const n = (v: string) => Number(v); // not money: only to draw
const tick = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });

/**
 * The dashboard at the top of a customer's or vendor's portal (DASH-060/061): open amounts by
 * how late they are, what is due next, and a year of invoices and payments, as charts with tables.
 */
export function PortalDashboard({ d, side }: { d: PortalDashboardData; side: 'CUSTOMER' | 'VENDOR' }) {
  const c = d.currency;
  const s = chartSeries;
  const words =
    side === 'CUSTOMER'
      ? { open: 'What you owe, by how late it is', next: 'Next payment due', invoiced: 'Invoiced to you', paid: 'You paid', year: 'Your year with us' }
      : { open: 'What you are owed, by how late it is', next: 'Next payment to you', invoiced: 'You billed', paid: 'Paid to you', year: 'Your year with us' };
  return (
    <section aria-label="Dashboard" className="mt-6 grid gap-4 lg:grid-cols-2">
      <Card role="region" aria-label={words.open}>
        <div className="px-5 pt-5">
          <h2 className="text-base font-semibold">{words.open}</h2>
          <p className="text-sm text-fg-muted">
            {money(d.aging.total, c)} open, of which {money(d.aging.overdue, c)} is past its due date.{' '}
            {d.nextDue
              ? `${words.next}: ${money(d.nextDue.amount, c)} on ${date(d.nextDue.date)}${d.nextDue.items > 1 ? ` (${d.nextDue.items} invoices)` : ''}; ${money(d.dueIn30Days, c)} falls due within 30 days.`
              : 'Nothing more falls due.'}
          </p>
        </div>
        <div className="h-48 w-full px-2 pt-2" role="img" aria-label="Open amounts by how late they are as bars; the same figures are in the table below">
          <ResponsiveContainer>
            <BarChart data={d.aging.buckets.map((b) => ({ bucket: BUCKET[b.bucket], amount: n(b.amount) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
              <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={72} />
              <Tooltip formatter={(v) => money(String(v), c)} />
              <Bar dataKey="amount" name="Open" fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Table aria-label="Open by how late">
          <thead>
            <Tr>
              <Th>How late</Th>
              <Th numeric>Invoices</Th>
              <Th numeric>Open</Th>
            </Tr>
          </thead>
          <tbody>
            {d.aging.buckets.map((b) => (
              <Tr key={b.bucket}>
                <Td>{BUCKET[b.bucket]}</Td>
                <Td numeric>{b.count}</Td>
                <Td numeric>
                  <Money value={b.amount} currency={c} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card role="region" aria-label={words.year}>
        <div className="px-5 pt-5">
          <h2 className="text-base font-semibold">{words.year}</h2>
          <p className="text-sm text-fg-muted">
            The last twelve months in {c}: {words.invoiced.toLowerCase()} {money(d.lastTwelveMonths.invoiced, c)} (less credit notes) and {words.paid.toLowerCase()} {money(d.lastTwelveMonths.paid, c)}
            .
          </p>
        </div>
        <div className="h-48 w-full px-2 pt-2" role="img" aria-label="Invoices and payments each month as bars; the same figures are in the table below">
          <ResponsiveContainer>
            <BarChart data={d.months.map((m) => ({ month: m.month, invoiced: n(m.invoiced), paid: n(m.paid) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
              <XAxis dataKey="month" tickFormatter={tick} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={72} />
              <Tooltip formatter={(v) => money(String(v), c)} labelFormatter={(l) => monthLabel(String(l))} />
              <Legend />
              <Bar dataKey="invoiced" name={words.invoiced} fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="paid" name={words.paid} fill={s[2]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Table aria-label="Each month">
          <thead>
            <Tr>
              <Th>Month</Th>
              <Th numeric>{words.invoiced}</Th>
              <Th numeric>{words.paid}</Th>
            </Tr>
          </thead>
          <tbody>
            {d.months
              .filter((m) => m.invoiced !== '0.00' || m.paid !== '0.00')
              .map((m) => (
                <Tr key={m.month}>
                  <Td>{monthLabel(m.month)}</Td>
                  <Td numeric>
                    <Money value={m.invoiced} currency={c} />
                  </Td>
                  <Td numeric>
                    <Money value={m.paid} currency={c} />
                  </Td>
                </Tr>
              ))}
          </tbody>
        </Table>
      </Card>
    </section>
  );
}
