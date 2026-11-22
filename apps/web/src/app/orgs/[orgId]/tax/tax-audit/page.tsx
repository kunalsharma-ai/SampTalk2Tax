'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface CashDay { date: string; contactId: string; contactName: string; amount: string; count: number; numbers: string[] }
interface TdsRow { number: string; section: string; contactName: string; date: string; dueDate: string; amount: string; depositDate: string | null; months: number; interest: string; deposited: boolean }
interface Report {
  year: string;
  from: string;
  to: string;
  asOf: string;
  yearEnded: boolean;
  applicability: { required: boolean; limit: string; turnover: string; totalReceipts: string; cashReceipts: string; totalPayments: string; cashPayments: string; cashReceiptsShare: string | null; cashPaymentsShare: string | null; reasons: string[] };
  cashPayments: { limit: string; days: CashDay[]; disallowed: string };
  cashReceipts: { limit: string; days: CashDay[]; total: string };
  tds: { configured: false } | { configured: true; rows: TdsRow[]; deducted: string; deposited: string; late: number; notDeposited: string; interest: string };
  expenditure: { total: string; registered: string; unregistered: string };
  hasCashAccount: boolean;
}

const yearsBack = (n: number) => {
  const t = new Date(Date.now() + 5.5 * 3_600_000); // not money
  const start = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
  return Array.from({ length: n }, (_, i) => `${start - i}-${String((start - i + 1) % 100).padStart(2, '0')}`); // not money
};

function CashTable({ label, days }: { label: string; days: CashDay[] }) {
  return (
    <Table aria-label={label}>
      <thead><Tr><Th>Date</Th><Th>Person</Th><Th>Entries</Th><Th numeric>Cash that day</Th></Tr></thead>
      <tbody>
        {days.map((d) => (
          <Tr key={`${d.date}-${d.contactId}`}>
            <Td>{date(d.date)}</Td>
            <Td>{d.contactName}</Td>
            <Td className="text-sm text-fg-muted">{d.numbers.join(', ')}</Td>
            <Td numeric><Money value={d.amount} currency="INR" /></Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Tax → Tax audit (TAX-026): working papers for the tax audit report (Form 3CD) of a financial year. */
export default function TaxAuditPage() {
  const { org, orgId } = useOrg();
  const years = yearsBack(4);
  const [year, setYear] = useState(years[1]!);
  const q = useQuery({ queryKey: ['tax-audit', orgId, year], queryFn: () => api<Report>(`/v1/orgs/${orgId}/tax-audit?year=${year}`) });
  if (!org) return null;
  const r = q.data;
  const a = r?.applicability;
  return (
    <>
      <PageHeader
        title="Tax audit"
        description="Working papers for the tax audit report (Form 3CD) of a financial year, from your books: whether a tax audit is needed on turnover, cash spending and cash receipts over the limits, TDS deposited late with interest, and spending by the supplier's GST registration. Give them to your auditor to check; nothing is filed here. Section and clause numbers are those of the Income-tax Act, 1961 and Form 3CD."
        actions={<div className="w-40"><Select aria-label="Financial year" value={year} onChange={(e) => setYear(e.target.value)}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</Select></div>}
      />
      <ErrorAlert title="Could not prepare the tax audit papers" error={q.error} />
      {r && a ? (
        <>
          {!r.yearEnded ? <div className="mb-4"><Alert tone="accent" title={`${r.year} is not over yet`}>Figures run from {date(r.from)} to today and will change until the year ends on {date(r.to)}.</Alert></div> : null}
          <Card role="region" aria-label="Is a tax audit needed">
            <CardHeader title="Is a tax audit needed" description="Section 44AB(a): turnover over 1 crore, or over 10 crore when cash is at most 5% of receipts and of payments." actions={<Badge tone={a.required ? 'warning' : 'positive'}>{a.required ? 'Tax audit needed' : 'Not needed on turnover'}</Badge>} />
            <div className="grid gap-4 p-4 sm:grid-cols-3">
              <div><p className="text-sm text-fg-muted">Turnover</p><p className="text-xl font-semibold"><Money value={a.turnover} currency="INR" /></p><p className="text-xs text-fg-muted">Invoices less credit notes, before GST</p></div>
              <div><p className="text-sm text-fg-muted">Cash received</p><p className="text-xl font-semibold">{a.cashReceiptsShare ?? '0.00'}%</p><p className="text-xs text-fg-muted"><Money value={a.cashReceipts} currency="INR" /> of <Money value={a.totalReceipts} currency="INR" /></p></div>
              <div><p className="text-sm text-fg-muted">Cash paid</p><p className="text-xl font-semibold">{a.cashPaymentsShare ?? '0.00'}%</p><p className="text-xs text-fg-muted"><Money value={a.cashPayments} currency="INR" /> of <Money value={a.totalPayments} currency="INR" /></p></div>
            </div>
            <ul className="list-disc px-8 pb-4 text-sm">{a.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
            {!r.hasCashAccount ? <p className="px-4 pb-4 text-xs text-fg-muted">No account has the Cash subtype, so nothing counts as cash.</p> : null}
          </Card>
          <Card className="mt-6" role="region" aria-label="Cash spending over 10,000 a day">
            <CardHeader title="Cash spending over 10,000 a day" description={<>Clause 21(d), section 40A(3): cash paid to one person on one day over 10,000 is disallowed in full. Disallowed: <Money value={r.cashPayments.disallowed} currency="INR" />. The 35,000 limit for transporters is not applied; check those with your auditor.</>} />
            {r.cashPayments.days.length ? <CashTable label="Cash spending over 10,000 a day" days={r.cashPayments.days} /> : <EmptyState title="None found">No cash payments over 10,000 to one person on one day.</EmptyState>}
          </Card>
          <Card className="mt-6" role="region" aria-label="Cash received of 2 lakh or more">
            <CardHeader title="Cash received of 2 lakh or more" description="Clause 31, section 269ST: 2 lakh or more in cash from one person on one day. The penalty under section 271DA equals the amount received." />
            {r.cashReceipts.days.length ? <CashTable label="Cash received of 2 lakh or more" days={r.cashReceipts.days} /> : <EmptyState title="None found">No cash receipts of 2 lakh or more from one person on one day.</EmptyState>}
          </Card>
          <Card className="mt-6" role="region" aria-label="TDS deposited late">
            <CardHeader title="TDS deposited late" description="Clause 34: TDS deposited after its due date, or not yet, with interest under section 201(1A) at 1.5% for every month or part from deduction to deposit." />
            {!r.tds.configured ? (
              <div className="p-4"><Alert tone="accent" title="TDS is not set up">Set up <Link className="underline" href={`/orgs/${orgId}/tax/tds-tcs`}>TDS and TCS</Link> to check deposits.</Alert></div>
            ) : (
              <>
                <div className="grid gap-4 p-4 sm:grid-cols-4">
                  <div><p className="text-sm text-fg-muted">Deducted</p><p className="font-semibold"><Money value={r.tds.deducted} currency="INR" /></p></div>
                  <div><p className="text-sm text-fg-muted">Deposited</p><p className="font-semibold"><Money value={r.tds.deposited} currency="INR" /></p></div>
                  <div><p className="text-sm text-fg-muted">Not deposited</p><p className="font-semibold"><Money value={r.tds.notDeposited} currency="INR" /></p></div>
                  <div><p className="text-sm text-fg-muted">Interest</p><p className="font-semibold text-negative"><Money value={r.tds.interest} currency="INR" /></p></div>
                </div>
                {r.tds.rows.length ? (
                  <Table aria-label="TDS deposited late">
                    <thead><Tr><Th>Bill</Th><Th>Section</Th><Th>Deducted</Th><Th>Due</Th><Th>Deposited</Th><Th numeric>TDS</Th><Th numeric>Months</Th><Th numeric>Interest</Th></Tr></thead>
                    <tbody>
                      {r.tds.rows.map((t) => (
                        <Tr key={t.number}>
                          <Td>{t.number}<span className="block text-xs text-fg-muted">{t.contactName}</span></Td>
                          <Td>{t.section}</Td>
                          <Td>{date(t.date)}</Td>
                          <Td>{date(t.dueDate)}</Td>
                          <Td className={t.deposited ? '' : 'text-negative'}>{t.depositDate ? date(t.depositDate) : 'Not yet'}</Td>
                          <Td numeric><Money value={t.amount} currency="INR" /></Td>
                          <Td numeric>{t.months}</Td>
                          <Td numeric><Money value={t.interest} currency="INR" /></Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                ) : <EmptyState title="All on time">All TDS was deposited by its due date.</EmptyState>}
              </>
            )}
          </Card>
          <Card className="mt-6" role="region" aria-label="Spending by GST registration">
            <CardHeader title="Spending by GST registration" description="Clause 44: spending on bills less vendor credits, before GST, by whether the supplier is registered for GST. Composition and exempt suppliers are not told apart; expense claims are left out." />
            <Table aria-label="Spending by GST registration">
              <thead><Tr><Th>Supplier</Th><Th numeric>Spending</Th></Tr></thead>
              <tbody>
                <Tr><Td>Registered for GST</Td><Td numeric><Money value={r.expenditure.registered} currency="INR" /></Td></Tr>
                <Tr><Td>Not registered</Td><Td numeric><Money value={r.expenditure.unregistered} currency="INR" /></Td></Tr>
                <Tr><Td className="font-semibold">Total</Td><Td numeric className="font-semibold"><Money value={r.expenditure.total} currency="INR" /></Td></Tr>
              </tbody>
            </Table>
          </Card>
        </>
      ) : null}
    </>
  );
}
