'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { EmployeeDialog } from '@/components/payroll/employee-dialog';
import { componentsBody, SalaryEditor, type ComponentDraft } from '@/components/payroll/salary-editor';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useGstStates, useOrg } from '@/lib/org';
import { can, type Employee } from '@/lib/types';

const PT_LABEL = { GENERAL: 'Standard slab', WOMAN: 'Woman (Maharashtra exemption up to ₹25,000)', EXEMPT: 'Exempt' } as const;

function nextMonth(iso: string) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

export default function EmployeePage() {
  const { org, orgId } = useOrg();
  const { employeeId } = useParams<{ employeeId: string }>();
  const states = useGstStates();
  const qc = useQueryClient();
  const e = useQuery({ queryKey: ['employee', orgId, employeeId], queryFn: () => api<Employee>(`/v1/orgs/${orgId}/payroll/employees/${employeeId}`) });
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState<{ effectiveFrom: string; components: ComponentDraft[] } | null>(null);
  const revise = useMutation({
    mutationFn: () => api<Employee>(`/v1/orgs/${orgId}/payroll/employees/${employeeId}/salaries`, { method: 'POST', body: { effectiveFrom: revision!.effectiveFrom, components: componentsBody(revision!.components) } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['employee', orgId, employeeId] });
      await qc.invalidateQueries({ queryKey: ['employees', orgId] });
      setRevision(null);
    },
  });
  if (!org || !e.data) return e.error ? <Alert title="Could not load the employee">{e.error.message}</Alert> : null;
  const x = e.data;
  const canManage = can(org.role, 'payroll.manage');
  const stateName = states.data?.find((s) => s.code === x.workStateCode)?.name;
  return (
    <>
      <PageHeader
        title={x.name}
        description={<>Employee <span className="num">{x.code}</span> · joined {date(x.dateOfJoining)}{x.dateOfLeaving ? ` · leaves ${date(x.dateOfLeaving)}` : ''}</>}
        actions={
          canManage ? (
            <>
              <Button variant="secondary" onClick={() => setEditing(true)}>Edit details</Button>
              <Button onClick={() => { revise.reset(); setRevision({ effectiveFrom: nextMonth(today()), components: (x.currentSalary?.components ?? []).map((c) => ({ ...c, monthlyAmount: c.monthlyAmount.replace(/\.00$/, '') })) }); }}>Revise salary</Button>
            </>
          ) : null
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader title="Details" actions={x.status === 'LEFT' ? <Badge>Left</Badge> : x.status === 'JOINING' ? <Badge tone="accent">Joining</Badge> : <Badge tone="positive">Active</Badge>} />
          <dl className="grid grid-cols-[11rem_1fr] gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">PAN</dt><dd className="num">{x.pan ?? <span className="text-warning">None: TDS at least 20% once tax is due</span>}</dd>
            <dt className="text-fg-muted">Email</dt><dd>{x.email ?? '—'}</dd>
            <dt className="text-fg-muted">Work state</dt><dd>{x.workStateCode ? `${x.workStateCode} · ${stateName ?? ''}` : '—'}</dd>
            <dt className="text-fg-muted">Professional tax</dt><dd>{PT_LABEL[x.ptCategory]}</dd>
            <dt className="text-fg-muted">Provident fund</dt><dd>{x.pfMember ? `Member${x.epsMember ? ', with EPS' : ', no EPS'}${x.pfOnFullWages ? ', on full wages' : ''}` : 'Not a member'}</dd>
            <dt className="text-fg-muted">UAN</dt><dd className="num">{x.uan ?? '—'}</dd>
            <dt className="text-fg-muted">ESI number</dt><dd className="num">{x.esiNumber ?? '—'}</dd>
            {x.priorTaxYear ? (<><dt className="text-fg-muted">Previous employer</dt><dd><Money value={x.priorIncome} currency="INR" /> salary, <Money value={x.priorTds} currency="INR" /> TDS in {x.priorTaxYear}</dd></>) : null}
          </dl>
        </Card>
        <Card>
          <CardHeader title="Salary" description="Each revision applies from the first of a month until the next one. A revision that payslips already use cannot change." />
          {[...x.salaries].reverse().map((s) => (
            <div key={s.id} className="border-t border-line px-5 py-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">From {date(s.effectiveFrom)} {x.currentSalary?.id === s.id ? <Badge tone="positive" className="ml-1">Current</Badge> : null}</p>
                <p className="text-sm"><Money value={s.monthlyGross} currency="INR" className="font-semibold" /> a month</p>
              </div>
              <div className="overflow-x-auto">
                <Table className="min-w-[420px]">
                  <thead><tr><Th>Component</Th><Th>PF/ESI</Th><Th numeric>Monthly</Th></tr></thead>
                  <tbody>
                    {s.components.map((c) => (
                      <tr key={c.code}><Td><span className="num text-xs text-fg-muted">{c.code}</span> {c.name}</Td><Td className="text-sm">{c.kind === 'WAGES' ? 'Wages' : 'Excluded'}</Td><Td numeric><Money value={c.monthlyAmount} currency="INR" /></Td></tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>
          ))}
        </Card>
      </div>
      <p className="mt-6 text-sm text-fg-muted"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/employees`}>← All employees</Link></p>

      {editing ? <EmployeeDialog open employee={x} defaultState={x.workStateCode ?? ''} onClose={() => setEditing(false)} /> : null}
      <Dialog open={!!revision} onOpenChange={(o) => !o && setRevision(null)} title="Revise salary" description="The new salary applies from the first of the month you choose. Pay runs from that month use it; recalculate any draft.">
        {revision ? (
          <form className="flex flex-col gap-4" onSubmit={(ev) => { ev.preventDefault(); revise.mutate(); }}>
            <Field label="Applies from" hint="The first day of a month.">{(p) => <Input {...p} type="month" value={revision.effectiveFrom.slice(0, 7)} onChange={(ev) => setRevision({ ...revision, effectiveFrom: `${ev.target.value}-01` })} />}</Field>
            <SalaryEditor value={revision.components} onChange={(components) => setRevision({ ...revision, components })} />
            {revise.error ? <Alert title="Not saved">{revise.error.message}{revise.error instanceof ApiError && revise.error.issues.length ? <ul className="mt-1 list-inside list-disc">{revise.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert> : null}
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setRevision(null)}>Cancel</Button><Button type="submit" loading={revise.isPending}>Save revision</Button></div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
