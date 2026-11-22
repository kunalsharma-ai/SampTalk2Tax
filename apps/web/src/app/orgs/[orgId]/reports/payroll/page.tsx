'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { money as fmt } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface PayrollReport {
  from: string;
  to: string;
  currency: string;
  runs: number;
  draftRuns: { id: string; number: string; period: string }[];
  totals: { employees: number; payslips: number; months: number; gross: string; deductions: string; net: string; employerCost: string; employerContributions: string };
  statutory: { key: string; label: string; employee: string; employer: string; total: string }[];
  byMonth: { period: string; employees: number; gross: string; pf: string; esi: string; pt: string; tds: string; net: string; employerCost: string; grossChange: string | null; flagged: boolean }[];
  byEmployee: { id: string; code: string; name: string; months: number; gross: string; pfEmployee: string; esiEmployee: string; pt: string; tds: string; deductions: string; net: string; employerCost: string }[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const label = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Payroll reports (RPT-010): posted pay runs over a range of months. */
export default function PayrollReportPage() {
  const { orgId } = useOrg();
  const [form, setForm] = useState({ from: '', to: '' });
  const [asked, setAsked] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const qs = [asked.from ? `from=${asked.from}` : '', asked.to ? `to=${asked.to}` : ''].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['payroll-report', orgId, qs], queryFn: () => api<PayrollReport>(`/v1/orgs/${orgId}/reports/payroll?${qs}`) });
  const d = q.data;
  const money = (x: string) => <Money value={x} currency={d?.currency ?? 'INR'} />;
  const download = async () => {
    setBusy(true);
    try {
      const x = await api<{ fileName: string; csv: string }>(`/v1/orgs/${orgId}/reports/payroll/export?${qs}`);
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
        title="Payroll report"
        description="Posted pay runs over a range of months: what was paid, withheld and contributed, month by month and employee by employee, with the statutory amounts (PF, ESI, professional tax and TDS on salary). Bank details are never shown here."
        actions={<Button variant="secondary" size="sm" loading={busy} disabled={!d} onClick={() => void download()}>Download payroll report (CSV)</Button>}
      />
      <Card className="mb-4">
        <CardHeader title="Payroll period" description="Pay months to include; the financial year to date when left blank. Up to 24 months." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(form);
          }}
        >
          <Field label="From month">{(p) => <Input {...p} type="month" className="w-44" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
          <Field label="To month">{(p) => <Input {...p} type="month" className="w-44" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
          <Button type="submit" size="sm" disabled={(!!form.from && !MONTH.test(form.from)) || (!!form.to && !MONTH.test(form.to))} loading={q.isFetching}>Show report</Button>
        </form>
      </Card>
      <ErrorAlert title="Could not load the payroll report" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Gross pay" value={money(d.totals.gross)} sub={`${label(d.from)} to ${label(d.to)}, ${d.runs} ${d.runs === 1 ? 'pay run' : 'pay runs'}`} />
            <Stat label="Net pay" value={money(d.totals.net)} sub={`Deductions ${fmt(d.totals.deductions, d.currency)}`} />
            <Stat label="Cost to the employer" value={money(d.totals.employerCost)} sub={`Contributions ${fmt(d.totals.employerContributions, d.currency)}`} />
            <Stat label="Employees paid" value={d.totals.employees} sub={`${d.totals.payslips} payslips`} />
          </div>

          {d.draftRuns.length ? (
            <Card className="mb-4">
              <CardHeader title="Pay runs not posted" description="Drafts in the period are left out of the report until they are posted." />
              <ul className="flex flex-wrap gap-3 p-4 text-sm">
                {d.draftRuns.map((r) => (
                  <li key={r.id}><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs/${r.id}`}>{r.number}</Link> · {label(r.period)}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="mb-4">
            <CardHeader title="Statutory amounts" description="What was withheld from employees and what the employer adds, to deposit with each authority." />
            <Table aria-label="Statutory amounts">
              <thead><Tr><Th>Item</Th><Th numeric>Withheld from employees</Th><Th numeric>Paid by the employer</Th><Th numeric>Total</Th></Tr></thead>
              <tbody>
                {d.statutory.map((s) => (
                  <Tr key={s.key}><Td>{s.label}</Td><Td numeric>{money(s.employee)}</Td><Td numeric>{money(s.employer)}</Td><Td numeric>{money(s.total)}</Td></Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card className="mb-4">
            <CardHeader title="Payroll by month" description="Each posted pay month. A change in gross pay of 10% or more on the month before is flagged." />
            {d.byMonth.length ? (
              <Table aria-label="Payroll by month">
                <thead><Tr><Th>Month</Th><Th numeric>Employees</Th><Th numeric>Gross</Th><Th numeric>Change</Th><Th numeric>PF</Th><Th numeric>ESI</Th><Th numeric>Prof. tax</Th><Th numeric>TDS</Th><Th numeric>Net</Th><Th numeric>Employer cost</Th></Tr></thead>
                <tbody>
                  {d.byMonth.map((m) => (
                    <Tr key={m.period}>
                      <Td>{label(m.period)}</Td>
                      <Td numeric>{m.employees}</Td>
                      <Td numeric>{money(m.gross)}</Td>
                      <Td numeric>{m.grossChange === null ? '—' : m.flagged ? <Badge tone="warning">{m.grossChange}%</Badge> : `${m.grossChange}%`}</Td>
                      <Td numeric>{money(m.pf)}</Td>
                      <Td numeric>{money(m.esi)}</Td>
                      <Td numeric>{money(m.pt)}</Td>
                      <Td numeric>{money(m.tds)}</Td>
                      <Td numeric>{money(m.net)}</Td>
                      <Td numeric>{money(m.employerCost)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No posted pay runs">Post a pay run in the period to see it here.</EmptyState>
            )}
          </Card>

          <Card>
            <CardHeader title="Payroll by employee" description="Everyone paid in the period, with what was withheld from them." />
            {d.byEmployee.length ? (
              <Table aria-label="Payroll by employee">
                <thead><Tr><Th>Employee</Th><Th numeric>Months</Th><Th numeric>Gross</Th><Th numeric>PF</Th><Th numeric>ESI</Th><Th numeric>Prof. tax</Th><Th numeric>TDS</Th><Th numeric>Net</Th><Th numeric>Employer cost</Th></Tr></thead>
                <tbody>
                  {d.byEmployee.map((e) => (
                    <Tr key={e.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/employees/${e.id}`}>{e.name}</Link><div className="text-xs text-fg-muted">{e.code}</div></Td>
                      <Td numeric>{e.months}</Td>
                      <Td numeric>{money(e.gross)}</Td>
                      <Td numeric>{money(e.pfEmployee)}</Td>
                      <Td numeric>{money(e.esiEmployee)}</Td>
                      <Td numeric>{money(e.pt)}</Td>
                      <Td numeric>{money(e.tds)}</Td>
                      <Td numeric>{money(e.net)}</Td>
                      <Td numeric>{money(e.employerCost)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nobody paid">No employee was paid in a posted pay run in the period.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
