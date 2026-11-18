'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, SectionHelpSlot, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { monthLabel } from '@/lib/payroll';
import { can, type PayRunSummary } from '@/lib/types';

interface Row {
  employeeId: string;
  code: string;
  name: string;
  eligible: boolean;
  reason: string | null;
  daysWorked: string;
  bonusWages: string;
  atRate: string;
  bonus: string;
  paid: { amount: string; runs: string[] };
  due: string;
  months: { period: string; wages: string; bonusWages: string; eligible: boolean }[];
}
interface Report {
  year: string;
  months: string[];
  ratePct: string;
  eligibilityCeiling: string;
  calculationCeiling: string;
  source: string;
  employees: Row[];
  totals: { eligible: number; bonus: string; paid: string; due: string };
}
interface Added {
  added: { employeeId: string; name: string; amount: string }[];
  skipped: { employeeId: string; name: string; reason: string }[];
  run: { id: string; number: string };
}

const yearOf = (start: number) => `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
/** Bonus is paid within eight months of the year's end, so until November the year to settle is the one just ended. */
function defaultYear() {
  const [y, m] = today().split('-').map(Number);
  const current = m >= 4 ? y : y - 1;
  return yearOf(m >= 4 && m <= 11 ? current - 1 : current);
}

/** Statutory bonus (PAY-007): worked out from posted payslips, paid as a one-off earning on a draft pay run. */
export default function BonusPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [form, setForm] = useState({ year: defaultYear(), ratePct: '8.33', eligibilityCeiling: '21000', calculationCeiling: '7000' });
  const [runId, setRunId] = useState('');
  const q = new URLSearchParams(form).toString();
  const valid = /^\d{4}-\d{2}$/.test(form.year) && form.ratePct !== '' && form.eligibilityCeiling !== '' && form.calculationCeiling !== '';
  const report = useQuery({ queryKey: ['payroll-bonus', orgId, q], queryFn: () => api<Report>(`/v1/orgs/${orgId}/payroll/bonus?${q}`), enabled: valid, retry: false });
  const runs = useQuery({ queryKey: ['pay-runs', orgId], queryFn: () => api<PayRunSummary[]>(`/v1/orgs/${orgId}/payroll/runs`) });
  const add = useMutation({
    mutationFn: () => api<Added>(`/v1/orgs/${orgId}/payroll/runs/${runId}/bonus`, { method: 'POST', body: form }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['payroll-bonus', orgId] }), qc.invalidateQueries({ queryKey: ['pay-runs', orgId] })]),
  });
  if (!org) return null;
  const manage = can(org.role, 'payroll.manage');
  const d = report.data;
  const drafts = (runs.data ?? []).filter((r) => r.status === 'DRAFT' && (!d || r.period >= d.months[0]));
  const start = Number(today().slice(0, 4));
  const years = [start - 2, start - 1, start].map(yearOf);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => { add.reset(); setForm({ ...form, [k]: e.target.value }); };
  return (
    <>
      <PageHeader
        title="Statutory bonus"
        description="The bonus each employee is owed for an accounting year under the Code on Wages, worked out from posted payslips. Add it to a draft pay run, where it is paid and taxed with the month's salary."
      />
      <Card className="mb-4">
        <form className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
          <Field label="Accounting year">{(p) => <Select {...p} value={form.year} onChange={set('year')}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</Select>}</Field>
          <Field label="Bonus rate (%)" hint="From 8.33% to 20%, by your allocable surplus.">{(p) => <Input {...p} inputMode="decimal" value={form.ratePct} onChange={set('ratePct')} />}</Field>
          <Field label="Eligible up to (a month)" hint="Wages above this in a month earn no bonus.">{(p) => <Input {...p} inputMode="decimal" value={form.eligibilityCeiling} onChange={set('eligibilityCeiling')} />}</Field>
          <Field label="Calculation ceiling (a month)" hint="7,000 or the state minimum wage, if higher.">{(p) => <Input {...p} inputMode="decimal" value={form.calculationCeiling} onChange={set('calculationCeiling')} />}</Field>
        </form>
        <p className="px-5 pb-4 text-xs text-fg-muted">The two amounts are the Payment of Bonus Act figures until the government notifies its own under the Code on Wages. Check them before paying.</p>
      </Card>
      <ErrorAlert title="Could not work out the bonus" error={report.error as Error | null} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Employees eligible" value={String(d.totals.eligible)} sub={`Of ${d.employees.length} paid in ${d.year}`} />
            <Stat label="Bonus for the year" value={<Money value={d.totals.bonus} currency="INR" />} sub={`At ${d.ratePct}%`} />
            <Stat label="Already paid" value={<Money value={d.totals.paid} currency="INR" />} sub="In posted pay runs" />
            <Stat label="Still to pay" value={<Money value={d.totals.due} currency="INR" />} sub="Bonus less what was paid" tone={Number(d.totals.due) > 0 ? 'warning' : undefined} />
          </div>
          <Card className="mb-4">
            <CardHeader
              title="Bonus by employee"
              help={<SectionHelpSlot title="Bonus by employee" />}
              description={`Wages from posted payslips, April to March. Each month counts up to ${Number(d.calculationCeiling).toLocaleString('en-IN')}; months with wages above ${Number(d.eligibilityCeiling).toLocaleString('en-IN')} count as nothing. The minimum bonus is 100.`}
            />
            <div className="overflow-x-auto">
              <Table aria-label="Bonus by employee" className="min-w-[860px]">
                <thead><tr><Th>Employee</Th><Th numeric>Days worked</Th><Th numeric>Bonus wages</Th><Th numeric>Bonus</Th><Th numeric>Paid</Th><Th numeric>Still to pay</Th><Th>Status</Th></tr></thead>
                <tbody>
                  {d.employees.map((r) => (
                    <Tr key={r.employeeId}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/employees/${r.employeeId}`}>{r.name}</Link> <span className="text-xs text-fg-muted">{r.code}</span></Td>
                      <Td numeric>{r.daysWorked}</Td>
                      <Td numeric><Money value={r.bonusWages} currency="INR" /></Td>
                      <Td numeric><Money value={r.bonus} currency="INR" /></Td>
                      <Td numeric>{Number(r.paid.amount) ? <span title={r.paid.runs.join(', ')}><Money value={r.paid.amount} currency="INR" /></span> : '—'}</Td>
                      <Td numeric className="font-medium"><Money value={r.due} currency="INR" /></Td>
                      <Td>{r.eligible ? (Number(r.due) > 0 ? <Badge tone="warning">To pay</Badge> : <Badge tone="positive">Paid</Badge>) : <span className="text-sm text-fg-muted">{r.reason}</span>}</Td>
                    </Tr>
                  ))}
                  {d.employees.length === 0 ? <tr><Td colSpan={7} className="py-8 text-center text-fg-muted">No posted payslips in {d.year}.</Td></tr> : null}
                </tbody>
              </Table>
            </div>
          </Card>
          {manage ? (
            <Card>
              <CardHeader title="Pay the bonus" help={<SectionHelpSlot title="Pay the bonus" />} description="Adds what is still to pay to each eligible employee's payslip in a draft run, as a one-off earning outside wages. Paid during the year, it is an advance; later runs add only the balance." />
              <div className="flex flex-wrap items-end gap-3 px-5 pb-5">
                <Field label="Draft pay run">
                  {(p) => (
                    <Select {...p} value={runId} onChange={(e) => { add.reset(); setRunId(e.target.value); }}>
                      <option value="">Choose a draft</option>
                      {drafts.map((r) => <option key={r.id} value={r.id}>{r.number} · {monthLabel(r.period)}</option>)}
                    </Select>
                  )}
                </Field>
                <Button disabled={!runId || Number(d.totals.due) <= 0} loading={add.isPending} onClick={() => add.mutate()}>Add bonus to the run</Button>
                {!drafts.length ? <p className="text-sm text-fg-muted">No draft pay run. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs`}>Create one</Link> first.</p> : null}
              </div>
              {add.error ? <div className="px-5 pb-5"><Alert title="Bonus not added">{add.error.message}</Alert></div> : null}
              {add.data ? (
                <div className="px-5 pb-5">
                  <Alert tone="positive" title={`Added to ${add.data.run.number} for ${add.data.added.length} employee${add.data.added.length === 1 ? '' : 's'}`}>
                    <ul className="list-inside list-disc">
                      {add.data.added.map((a) => <li key={a.employeeId}>{a.name}: <Money value={a.amount} currency="INR" /></li>)}
                      {add.data.skipped.map((s) => <li key={s.employeeId} className="text-fg-muted">{s.name}: {s.reason}</li>)}
                    </ul>
                    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/runs/${add.data.run.id}`}>Open {add.data.run.number}</Link>
                  </Alert>
                </div>
              ) : null}
            </Card>
          ) : null}
          <p className="mt-3 text-xs text-fg-muted">Source: {d.source}. Not covered: allocable surplus and set-on or set-off, disqualification (leave the employee out), and the 60 minimum for employees under 15.</p>
        </>
      ) : null}
    </>
  );
}
