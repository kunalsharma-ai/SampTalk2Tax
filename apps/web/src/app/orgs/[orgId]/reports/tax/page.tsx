'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money as fmt } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Side { taxable: string; tax: string; cgst: string; sgst: string; igst: string }
interface TaxReport {
  from: string;
  to: string;
  currency: string;
  documents: number;
  totals: { sales: Side; purchases: Side; outputTax: string; inputTax: string; net: string; reverseCharge: string; tds: string; tcs: string };
  byRate: { rate: string; sales: Side; purchases: Side; net: string }[];
  byMonth: { month: string; outputTax: string; inputTax: string; net: string }[];
  withholding: { kind: 'TDS' | 'TCS'; section: string; base: string; amount: string; documents: number }[];
  accounts: { code: string; name: string; subtype: string; opening: string; debit: string; credit: string; closing: string }[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SUBTYPE: Record<string, string> = { TAX_PAYABLE: 'Tax payable', TAX_RECEIVABLE: 'Tax receivable', TAX_EXPENSE: 'Tax expense' };
const MONTH = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const hasHeads = (r: TaxReport) => [r.totals.sales, r.totals.purchases].some((s) => [s.cgst, s.sgst, s.igst].some((x) => /[1-9]/.test(x)));

/** Tax reports (RPT-009): tax by rate and month, withholding and the tax accounts, for a period. */
export default function TaxReportPage() {
  const { orgId } = useOrg();
  const [form, setForm] = useState({ from: '', to: '' });
  const [asked, setAsked] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const qs = [asked.from ? `from=${asked.from}` : '', asked.to ? `to=${asked.to}` : ''].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['tax-report', orgId, qs], queryFn: () => api<TaxReport>(`/v1/orgs/${orgId}/reports/tax?${qs}`) });
  const d = q.data;
  const cur = d?.currency ?? 'INR';
  const money = (x: string) => <Money value={x} currency={cur} />;
  const m = (x: string) => fmt(x, cur);
  const download = async () => {
    setBusy(true);
    try {
      const x = await api<{ fileName: string; csv: string }>(`/v1/orgs/${orgId}/reports/tax/export?${qs}`);
      const url = URL.createObjectURL(new Blob([x.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = x.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Tax report"
        description="The tax in a period from posted invoices, credit notes, bills and vendor credits: output tax, input tax and the net by rate and by month, tax withheld by section, and every tax account in the ledger with its movement."
        actions={<Button variant="secondary" size="sm" loading={busy} disabled={!d} onClick={() => void download()}>Download tax report (CSV)</Button>}
      />
      <Card className="mb-4">
        <CardHeader title="Tax period" description="By document date; the financial year to date when left blank. Up to two years." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(form);
          }}
        >
          <Field label="From">{(p) => <Input {...p} type="date" className="w-44" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
          <Field label="To">{(p) => <Input {...p} type="date" className="w-44" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
          <Button type="submit" size="sm" disabled={(!!form.from && !ISO.test(form.from)) || (!!form.to && !ISO.test(form.to))} loading={q.isFetching}>Show report</Button>
        </form>
      </Card>
      <ErrorAlert title="Could not load the tax report" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Output tax" value={money(d.totals.outputTax)} sub={`${date(d.from)} to ${date(d.to)}, ${d.documents} ${d.documents === 1 ? 'document' : 'documents'}`} />
            <Stat label="Input tax" value={money(d.totals.inputTax)} sub={/[1-9]/.test(d.totals.reverseCharge) ? `Plus reverse charge ${m(d.totals.reverseCharge)}` : 'On bills less vendor credits'} />
            <Stat label="Net tax" value={money(d.totals.net)} tone={/^-/.test(d.totals.net) ? 'positive' : /[1-9]/.test(d.totals.net) ? 'warning' : 'neutral'} sub={/^-/.test(d.totals.net) ? 'More credit than tax' : 'Output less input'} />
            <Stat label="Tax withheld" value={money(d.totals.tds)} sub={`TDS on bills; TCS on invoices ${m(d.totals.tcs)}`} />
          </div>

          <Card className="mb-4">
            <CardHeader title="Tax by rate" description={`Taxable value and tax at each rate, credit notes and vendor credits taken off, in ${d.currency}.`} />
            {d.byRate.length ? (
              <Table aria-label="Tax by rate">
                <thead>
                  <Tr><Th>Rate</Th><Th numeric>Sales taxable</Th><Th numeric>Output tax</Th><Th numeric>Purchases taxable</Th><Th numeric>Input tax</Th><Th numeric>Net</Th></Tr>
                </thead>
                <tbody>
                  {d.byRate.map((r) => (
                    <Tr key={r.rate}>
                      <Td>{r.rate}%</Td>
                      <Td numeric>{money(r.sales.taxable)}</Td>
                      <Td numeric>{money(r.sales.tax)}</Td>
                      <Td numeric>{money(r.purchases.taxable)}</Td>
                      <Td numeric>{money(r.purchases.tax)}</Td>
                      <Td numeric>{money(r.net)}</Td>
                    </Tr>
                  ))}
                  <Tr className="font-semibold">
                    <Td>Total</Td>
                    <Td numeric>{money(d.totals.sales.taxable)}</Td>
                    <Td numeric>{money(d.totals.outputTax)}</Td>
                    <Td numeric>{money(d.totals.purchases.taxable)}</Td>
                    <Td numeric>{money(d.totals.inputTax)}</Td>
                    <Td numeric>{money(d.totals.net)}</Td>
                  </Tr>
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No taxed documents">No invoice, credit note, bill or vendor credit was posted in the period.</EmptyState>
            )}
            {hasHeads(d) ? (
              <p className="border-t border-border px-4 py-3 text-sm text-fg-muted">
                GST heads. Output: CGST {m(d.totals.sales.cgst)}, SGST {m(d.totals.sales.sgst)}, IGST {m(d.totals.sales.igst)}. Input: CGST {m(d.totals.purchases.cgst)}, SGST {m(d.totals.purchases.sgst)}, IGST {m(d.totals.purchases.igst)}.
              </p>
            ) : null}
          </Card>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Tax by month" description="By document date." />
              {d.byMonth.length ? (
                <Table aria-label="Tax by month">
                  <thead><Tr><Th>Month</Th><Th numeric>Output tax</Th><Th numeric>Input tax</Th><Th numeric>Net</Th></Tr></thead>
                  <tbody>
                    {d.byMonth.map((m) => (
                      <Tr key={m.month}><Td>{MONTH(m.month)}</Td><Td numeric>{money(m.outputTax)}</Td><Td numeric>{money(m.inputTax)}</Td><Td numeric>{money(m.net)}</Td></Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="No months">Nothing was posted in the period.</EmptyState>
              )}
            </Card>
            <Card>
              <CardHeader title="Tax withheld by section" description="TDS on bills and TCS on invoices, credits taken off." />
              {d.withholding.length ? (
                <Table aria-label="Tax withheld by section">
                  <thead><Tr><Th>Kind</Th><Th>Section</Th><Th numeric>Documents</Th><Th numeric>Base</Th><Th numeric>Withheld</Th></Tr></thead>
                  <tbody>
                    {d.withholding.map((w) => (
                      <Tr key={`${w.kind}-${w.section}`}><Td>{w.kind}</Td><Td>{w.section}</Td><Td numeric>{w.documents}</Td><Td numeric>{money(w.base)}</Td><Td numeric>{money(w.amount)}</Td></Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="Nothing withheld">No document in the period carries TDS or TCS.</EmptyState>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader title="Tax accounts in the ledger" description="Every tax payable, tax receivable and tax expense account: debits are positive, credits negative." />
            {d.accounts.length ? (
              <Table aria-label="Tax accounts in the ledger">
                <thead><Tr><Th>Account</Th><Th>Kind</Th><Th numeric>At the start</Th><Th numeric>Debits</Th><Th numeric>Credits</Th><Th numeric>At the end</Th></Tr></thead>
                <tbody>
                  {d.accounts.map((a) => (
                    <Tr key={a.code}>
                      <Td>{a.code} · {a.name}</Td>
                      <Td className="text-sm">{SUBTYPE[a.subtype] ?? a.subtype}</Td>
                      <Td numeric>{money(a.opening)}</Td>
                      <Td numeric>{money(a.debit)}</Td>
                      <Td numeric>{money(a.credit)}</Td>
                      <Td numeric>{money(a.closing)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No tax accounts">The chart of accounts has no tax payable, receivable or expense account.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
