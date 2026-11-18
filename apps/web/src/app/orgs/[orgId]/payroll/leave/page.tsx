'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, SectionHelpSlot, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type EmployeeSummary } from '@/lib/types';

interface LeaveType { id: string; code: string; name: string; paid: boolean; annualDays: string; active: boolean }
interface Entry {
  id: string;
  employee: { id: string; code: string; name: string };
  leaveType: { id: string; code: string; name: string };
  paid: boolean;
  period: string;
  from: string;
  to: string;
  days: string;
  reason: string | null;
  status: 'RECORDED' | 'CANCELLED';
  cancelReason: string | null;
}
interface Balance { employeeId: string; employeeCode: string; employeeName: string; leaveTypeId: string; code: string; name: string; paid: boolean; allowance: string | null; taken: string; left: string | null }

const yearOf = (start: number) => `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
const currentYear = () => {
  const [y, m] = today().split('-').map(Number);
  return yearOf(m >= 4 ? y : y - 1);
};
const spanDays = (from: string, to: string) => (from && to && to >= from ? String((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1) : '');

/** Leave (PAY-011): leave types, leave taken, balances; unpaid leave becomes loss of pay on the payslip. */
export default function LeavePage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [year, setYear] = useState(currentYear);
  const [newType, setNewType] = useState(false);
  const [cancelling, setCancelling] = useState<Entry | null>(null);
  const base = `/v1/orgs/${orgId}/payroll`;
  const types = useQuery({ queryKey: ['leave-types', orgId], queryFn: () => api<LeaveType[]>(`${base}/leave-types`) });
  const employees = useQuery({ queryKey: ['employees', orgId], queryFn: () => api<EmployeeSummary[]>(`${base}/employees`) });
  const entries = useQuery({ queryKey: ['leave', orgId, year], queryFn: () => api<Entry[]>(`${base}/leave?year=${year}`) });
  const balances = useQuery({ queryKey: ['leave-balances', orgId, year], queryFn: () => api<Balance[]>(`${base}/leave/balances?year=${year}`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['leave', orgId] }), qc.invalidateQueries({ queryKey: ['leave-balances', orgId] }), qc.invalidateQueries({ queryKey: ['pay-runs', orgId] })]);
  if (!org) return null;
  const manage = can(org.role, 'payroll.manage');
  const start = Number(currentYear().slice(0, 4));
  return (
    <>
      <PageHeader
        title="Leave"
        description="Leave types with a yearly allowance, leave taken by each employee and what is left. Unpaid leave is taken off the month's pay as loss-of-pay days on the payslip."
        actions={
          <Field label="Year">
            {(p) => (
              <Select {...p} value={year} onChange={(e) => setYear(e.target.value)}>
                {[start - 1, start, start + 1].map(yearOf).map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            )}
          </Field>
        }
      />
      <Card className="mb-4">
        <CardHeader
          title="Leave types"
          help={<SectionHelpSlot title="Leave types" />}
          description="Paid leave comes out of a yearly allowance (April to March). Unpaid leave has no allowance and reduces pay."
          actions={manage ? <Button size="sm" onClick={() => setNewType(true)}>New leave type</Button> : null}
        />
        <Table aria-label="Leave types">
          <thead><tr><Th>Code</Th><Th>Name</Th><Th>Pay</Th><Th numeric>Days a year</Th></tr></thead>
          <tbody>
            {(types.data ?? []).map((t) => (
              <Tr key={t.id} className={t.active ? '' : 'opacity-60'}>
                <Td className="font-medium">{t.code}</Td>
                <Td>{t.name}{t.active ? null : ' (not in use)'}</Td>
                <Td>{t.paid ? <Badge tone="positive">Paid</Badge> : <Badge tone="warning">Unpaid</Badge>}</Td>
                <Td numeric>{t.paid ? t.annualDays : '—'}</Td>
              </Tr>
            ))}
            {types.data && !types.data.length ? <tr><Td colSpan={4} className="py-6 text-center text-fg-muted">No leave types yet. Add earned leave, sick leave and leave without pay to start.</Td></tr> : null}
          </tbody>
        </Table>
      </Card>
      {manage && types.data?.some((t) => t.active) ? <RecordLeave base={base} types={types.data.filter((t) => t.active)} employees={employees.data ?? []} onDone={refresh} /> : null}
      <Card className="mb-4">
        <CardHeader title="Leave balances" help={<SectionHelpSlot title="Leave balances" />} description={`Allowance, leave taken and what is left in ${year}, for each employee and leave type.`} />
        <ErrorAlert title="Could not load balances" error={balances.error as Error | null} />
        <div className="overflow-x-auto">
          <Table aria-label="Leave balances">
            <thead><tr><Th>Employee</Th><Th>Leave type</Th><Th numeric>Allowance</Th><Th numeric>Taken</Th><Th numeric>Left</Th></tr></thead>
            <tbody>
              {(balances.data ?? []).map((b) => (
                <Tr key={`${b.employeeId}-${b.leaveTypeId}`}>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/employees/${b.employeeId}`}>{b.employeeName}</Link> <span className="text-xs text-fg-muted">{b.employeeCode}</span></Td>
                  <Td>{b.name}</Td>
                  <Td numeric>{b.allowance ?? '—'}</Td>
                  <Td numeric>{b.taken}</Td>
                  <Td numeric className="font-medium">{b.left ?? '—'}</Td>
                </Tr>
              ))}
              {balances.data && !balances.data.length ? <tr><Td colSpan={5} className="py-6 text-center text-fg-muted">No employees or leave types yet.</Td></tr> : null}
            </tbody>
          </Table>
        </div>
      </Card>
      <Card>
        <CardHeader title="Leave recorded" help={<SectionHelpSlot title="Leave recorded" />} description="Newest first. Leave in a month whose pay run is posted cannot change." />
        <div className="overflow-x-auto">
          <Table aria-label="Leave recorded" className="min-w-[760px]">
            <thead><tr><Th>Employee</Th><Th>Leave</Th><Th>Dates</Th><Th numeric>Days</Th><Th>Reason</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {(entries.data ?? []).map((e) => (
                <Tr key={e.id} className={e.status === 'CANCELLED' ? 'opacity-60' : ''}>
                  <Td>{e.employee.name}</Td>
                  <Td>{e.leaveType.name} {e.paid ? null : <Badge tone="warning">Unpaid</Badge>}</Td>
                  <Td className="whitespace-nowrap">{e.from === e.to ? date(e.from) : `${date(e.from)} to ${date(e.to)}`}</Td>
                  <Td numeric>{e.days}</Td>
                  <Td className="text-sm text-fg-muted">{e.status === 'CANCELLED' ? `Cancelled: ${e.cancelReason}` : e.reason ?? ''}</Td>
                  <Td className="text-right">{manage && e.status === 'RECORDED' ? <Button size="sm" variant="ghost" onClick={() => setCancelling(e)}>Cancel…</Button> : null}</Td>
                </Tr>
              ))}
              {entries.data && !entries.data.length ? <tr><Td colSpan={6} className="py-6 text-center text-fg-muted">No leave recorded in {year}.</Td></tr> : null}
            </tbody>
          </Table>
        </div>
      </Card>
      {newType ? <NewTypeDialog base={base} onClose={() => setNewType(false)} onDone={async () => { setNewType(false); await qc.invalidateQueries({ queryKey: ['leave-types', orgId] }); await refresh(); }} /> : null}
      {cancelling ? <CancelDialog base={base} entry={cancelling} onClose={() => setCancelling(null)} onDone={async () => { setCancelling(null); await refresh(); }} /> : null}
    </>
  );
}

function RecordLeave({ base, types, employees, onDone }: { base: string; types: LeaveType[]; employees: EmployeeSummary[]; onDone: () => Promise<unknown> }) {
  const [f, setF] = useState({ employeeId: '', leaveTypeId: '', from: '', to: '', days: '', reason: '' });
  const record = useMutation({
    mutationFn: () => api<Entry & { draftUpdated: string | null }>(`${base}/leave`, { method: 'POST', body: { ...f, reason: f.reason.trim() || null } }),
    onSuccess: async () => {
      setF({ ...f, from: '', to: '', days: '', reason: '' });
      await onDone();
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    record.reset();
    const next = { ...f, [k]: e.target.value };
    // The days default to the calendar days chosen; change them for weekends, holidays or half days.
    if (k === 'from' || k === 'to') {
      if (k === 'from' && (!next.to || next.to < next.from)) next.to = next.from;
      next.days = spanDays(next.from, next.to);
    }
    setF(next);
  };
  const ready = f.employeeId && f.leaveTypeId && f.from && f.to && f.days;
  return (
    <Card className="mb-4">
      <CardHeader title="Record leave" help={<SectionHelpSlot title="Record leave" />} description="One month at a time. Paid leave needs enough balance; unpaid leave updates that month's draft payslip." />
      <form className="grid gap-4 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-6" onSubmit={(e) => { e.preventDefault(); record.mutate(); }}>
        <Field label="Employee">{(p) => <Select {...p} value={f.employeeId} onChange={set('employeeId')}><option value="">Choose</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.code})</option>)}</Select>}</Field>
        <Field label="Leave type">{(p) => <Select {...p} value={f.leaveTypeId} onChange={set('leaveTypeId')}><option value="">Choose</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
        <Field label="From">{(p) => <Input {...p} type="date" value={f.from} onChange={set('from')} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={f.to} min={f.from} onChange={set('to')} />}</Field>
        <Field label="Days" hint="Whole or half days.">{(p) => <Input {...p} inputMode="decimal" value={f.days} onChange={set('days')} />}</Field>
        <Field label="Reason (optional)">{(p) => <Input {...p} value={f.reason} maxLength={300} onChange={set('reason')} />}</Field>
        <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-6">
          <Button type="submit" disabled={!ready} loading={record.isPending}>Record leave</Button>
          {record.data ? <span className="text-sm text-positive">Recorded {record.data.days} day{record.data.days === '1' ? '' : 's'} of {record.data.leaveType.name} for {record.data.employee.name}{record.data.draftUpdated ? `; ${record.data.draftUpdated} updated` : ''}.</span> : null}
        </div>
        {record.error ? <div className="sm:col-span-2 lg:col-span-6"><Alert title="Leave not recorded">{record.error.message}</Alert></div> : null}
      </form>
    </Card>
  );
}

function NewTypeDialog({ base, onClose, onDone }: { base: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const [f, setF] = useState({ code: '', name: '', paid: 'true', annualDays: '' });
  const save = useMutation({ mutationFn: () => api(`${base}/leave-types`, { method: 'POST', body: { code: f.code, name: f.name, paid: f.paid === 'true', annualDays: f.paid === 'true' ? f.annualDays : '0' } }), onSuccess: onDone });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New leave type" description="Whether it is paid cannot change once leave is recorded under it.">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Code" hint="Such as EL, SL or LWP.">{(p) => <Input {...p} value={f.code} maxLength={10} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Name">{(p) => <Input {...p} value={f.name} maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Pay">{(p) => <Select {...p} value={f.paid} onChange={(e) => setF({ ...f, paid: e.target.value })}><option value="true">Paid</option><option value="false">Unpaid (loss of pay)</option></Select>}</Field>
        {f.paid === 'true' ? <Field label="Days a year">{(p) => <Input {...p} inputMode="decimal" value={f.annualDays} onChange={(e) => setF({ ...f, annualDays: e.target.value })} />}</Field> : null}
        {save.error ? <div className="sm:col-span-2"><Alert title="Not saved">{save.error.message}</Alert></div> : null}
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending} disabled={!f.code || !f.name || (f.paid === 'true' && !f.annualDays)}>Add leave type</Button></div>
      </form>
    </Dialog>
  );
}

function CancelDialog({ base, entry, onClose, onDone }: { base: string; entry: Entry; onClose: () => void; onDone: () => Promise<unknown> }) {
  const [reason, setReason] = useState('');
  const cancel = useMutation({ mutationFn: () => api(`${base}/leave/${entry.id}/cancel`, { method: 'POST', body: { reason } }), onSuccess: onDone });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Cancel ${entry.leaveType.name} for ${entry.employee.name}`} description={`${entry.days} day${entry.days === '1' ? '' : 's'} from ${date(entry.from)}. The record stays, marked cancelled.`}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
        <Field label="Reason">{(p) => <Input {...p} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        {cancel.error ? <Alert title="Not cancelled">{cancel.error.message}</Alert> : null}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Keep it</Button><Button type="submit" variant="danger" loading={cancel.isPending}>Cancel leave</Button></div>
      </form>
    </Dialog>
  );
}
