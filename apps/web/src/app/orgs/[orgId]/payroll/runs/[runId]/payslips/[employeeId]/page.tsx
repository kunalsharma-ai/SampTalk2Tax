'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th } from '@talk2tax/ui';
import { D } from '@talk2tax/accounting-engine';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money as fmt } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { monthLabel } from '@/lib/payroll';
import type { Payslip } from '@/lib/types';

const money = (v: string) => fmt(v, 'INR');
const isZero = (v: string) => new D(v).isZero();

function Row({ label, value, hint, strong }: { label: ReactNode; value: string; hint?: ReactNode; strong?: boolean }) {
  return (
    <tr className={strong ? 'border-t border-line font-semibold' : undefined}>
      <Td>
        {label}
        {hint ? <span className="block text-xs font-normal text-fg-muted">{hint}</span> : null}
      </Td>
      <Td className="text-right num">{money(value)}</Td>
    </tr>
  );
}

export default function PayslipPage() {
  const { orgId } = useOrg();
  const { runId, employeeId } = useParams<{ runId: string; employeeId: string }>();
  const q = useQuery({ queryKey: ['payslip', orgId, runId, employeeId], queryFn: () => api<Payslip>(`/v1/orgs/${orgId}/payroll/runs/${runId}/payslips/${employeeId}`) });
  const back = `/orgs/${orgId}/payroll/runs/${runId}`;

  if (q.isLoading) return <p className="text-sm text-fg-muted">Loading…</p>;
  if (q.error || !q.data) return <Alert title="Could not load the payslip">{q.error?.message ?? 'Not found'}</Alert>;
  const p = q.data;
  const e = p.employee;
  const employerPf = new D(p.pf.eps).plus(p.pf.epfEmployer);
  const employerTotal = employerPf.plus(p.pf.edli).plus(p.pf.admin).plus(p.esi.employer);

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title={`Payslip · ${e.name}`}
          description={<>{monthLabel(p.payRun.period)} · <Link className="text-accent hover:underline" href={back}>{p.payRun.number}</Link></>}
          actions={<Button onClick={() => window.print()}>Print payslip</Button>}
        />
        {p.payRun.status !== 'POSTED' ? (
          <Alert tone="warning" title={p.payRun.status === 'DRAFT' ? 'Draft payslip' : 'Void pay run'}>
            {p.payRun.status === 'DRAFT' ? 'These figures can still change until the pay run is posted.' : 'This pay run was voided; the payslip is kept for the record only.'}
          </Alert>
        ) : null}
      </div>

      <article aria-label="Payslip" className="mt-4 flex flex-col gap-4 print:mt-0 print:text-black">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4 p-5">
            <div>
              <p className="text-lg font-semibold">{p.organisation.name}</p>
              <p className="text-sm text-fg-muted">
                Payslip for {monthLabel(p.payRun.period)} · paid {date(p.payRun.payDate)}
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                {p.organisation.pfEstablishmentCode ? <>PF establishment {p.organisation.pfEstablishmentCode}</> : null}
                {p.organisation.pfEstablishmentCode && p.organisation.esiEmployerCode ? ' · ' : null}
                {p.organisation.esiEmployerCode ? <>ESI employer {p.organisation.esiEmployerCode}</> : null}
              </p>
            </div>
            <Badge tone={p.payRun.status === 'POSTED' ? 'positive' : p.payRun.status === 'DRAFT' ? 'warning' : 'negative'}>{p.payRun.status}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line p-5 text-sm sm:grid-cols-4">
            {[
              ['Employee', `${e.name} (${e.code})`],
              ['PAN', e.pan ?? 'Not given'],
              ['UAN', e.uan ?? '—'],
              ['ESI number', e.esiNumber ?? '—'],
              ['Joined', date(e.dateOfJoining)],
              ['Days in month', String(p.daysInMonth)],
              ['Loss-of-pay days', p.lopDays],
              ['Paid days', p.paidDays],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-fg-muted">{k}</dt>
                <dd className="num">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Earnings" />
            <Table>
              <thead>
                <tr><Th>Component</Th><Th className="text-right">Amount</Th></tr>
              </thead>
              <tbody>
                {p.earnings.map((x) => (
                  <Row key={x.code} label={x.name} value={x.amount} hint={x.kind === 'EXCLUDED' ? 'Excluded from wages' : undefined} />
                ))}
                {p.oneOffs.map((x, i) => (
                  <Row key={`o${i}`} label={x.name} value={x.amount} hint={`One-off${x.kind === 'EXCLUDED' ? ', excluded from wages' : ''}`} />
                ))}
                <Row strong label="Gross earnings" value={p.gross} />
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader title="Deductions" />
            <Table>
              <thead>
                <tr><Th>Deduction</Th><Th className="text-right">Amount</Th></tr>
              </thead>
              <tbody>
                <Row label="Provident fund (employee 12%)" value={p.pf.employee} hint={isZero(p.pf.wages) ? 'Not a PF member' : `On PF wages of ${money(p.pf.wages)}`} />
                <Row label="ESI (employee 0.75%)" value={p.esi.employee} hint={p.esi.covered ? `On ESI wages of ${money(p.esi.wages)}` : 'Not covered this contribution period'} />
                <Row label="Professional tax" value={p.pt.amount} hint={p.pt.note || undefined} />
                <Row label="Income tax (TDS on salary)" value={p.tds.amount} hint={p.tds.note.startsWith('Projected') ? 'New regime; see the income-tax working' : p.tds.note || undefined} />
                <Row strong label="Total deductions" value={p.deductions} />
              </tbody>
            </Table>
          </Card>
        </div>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <p className="text-sm text-fg-muted">Net pay</p>
              <p className="num text-3xl font-semibold" aria-label="Net pay">{money(p.net)}</p>
            </div>
            <p className="max-w-md text-xs text-fg-muted">
              Gross {money(p.gross)} less deductions {money(p.deductions)}. Wages under the Code on Social Security are {money(p.wages)}
              {isZero(p.wagesAddedBack) ? '.' : `, including ${money(p.wagesAddedBack)} of allowances added back because they were more than half of pay.`}
            </p>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Income-tax working" description="New regime, projected for the tax year" />
            <Table>
              <tbody>
                <Row label="Salary before this month" value={p.tds.incomeBefore} hint="Earlier pay runs and any previous employer" />
                <Row label="Projected salary for the year" value={p.tds.projectedIncome} hint={`This month plus ${p.tds.futureMonths} more month${p.tds.futureMonths === 1 ? '' : 's'}`} />
                <Row label="Taxable income" value={p.tds.taxableIncome} hint="After the ₹75,000 standard deduction" />
                <Row label="Tax for the year" value={p.tds.annualTax} hint="After rebate, surcharge and 4% cess" />
                <Row label="TDS already deducted" value={p.tds.tdsBefore} />
                <Row strong label="TDS this month" value={p.tds.amount} />
              </tbody>
            </Table>
          </Card>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader title="Employer contributions" description="Paid by the employer, not deducted from pay" />
              <Table>
                <tbody>
                  <Row label="Pension (EPS 8.33%)" value={p.pf.eps} />
                  <Row label="Provident fund (EPF)" value={p.pf.epfEmployer} />
                  <Row label="EDLI and PF admin charges" value={new D(p.pf.edli).plus(p.pf.admin).toFixed(2)} />
                  <Row label="ESI (employer 3.25%)" value={p.esi.employer} />
                  <Row strong label="Total" value={employerTotal.toFixed(2)} hint={`Cost to employer ${money(p.employerCost)}`} />
                </tbody>
              </Table>
            </Card>
            <Card>
              <CardHeader title={`Year to date · ${p.yearToDate.taxYear}`} description={p.yearToDate.postedOnly ? 'Posted pay runs only' : 'Includes this payslip'} />
              <Table>
                <tbody>
                  <Row label="Gross earnings" value={p.yearToDate.gross} />
                  <Row label="Provident fund" value={p.yearToDate.pfEmployee} />
                  <Row label="Professional tax" value={p.yearToDate.pt} />
                  <Row label="Income tax" value={p.yearToDate.tds} />
                </tbody>
              </Table>
            </Card>
          </div>
        </div>
        <p className="text-xs text-fg-faint">Computer-generated payslip from the books of {p.organisation.name}. It does not need a signature.</p>
      </article>
    </>
  );
}
