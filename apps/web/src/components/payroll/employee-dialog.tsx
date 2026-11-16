'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { checkPan } from '@talk2tax/tax-engine';
import { Alert, Button, Dialog, Field, Input, Select } from '@talk2tax/ui';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useGstStates, useOrg } from '@/lib/org';
import type { Employee, PtCategory } from '@/lib/types';
import { componentsBody, DEFAULT_COMPONENTS, SalaryEditor, type ComponentDraft } from './salary-editor';

interface Draft {
  code: string;
  name: string;
  email: string;
  pan: string;
  dateOfJoining: string;
  dateOfLeaving: string;
  workStateCode: string;
  ptCategory: PtCategory;
  pfMember: boolean;
  epsMember: boolean;
  pfOnFullWages: boolean;
  uan: string;
  esiNumber: string;
  priorTaxYear: string;
  priorIncome: string;
  priorTds: string;
}

const AMT = /^\d{0,13}(\.\d{0,2})?$/;

function draftOf(e: Employee | null, defaultState: string): Draft {
  return {
    code: e?.code ?? '',
    name: e?.name ?? '',
    email: e?.email ?? '',
    pan: e?.pan ?? '',
    dateOfJoining: e?.dateOfJoining ?? '',
    dateOfLeaving: e?.dateOfLeaving ?? '',
    workStateCode: e?.workStateCode ?? defaultState,
    ptCategory: e?.ptCategory ?? 'GENERAL',
    pfMember: e?.pfMember ?? true,
    epsMember: e?.epsMember ?? true,
    pfOnFullWages: e?.pfOnFullWages ?? false,
    uan: e?.uan ?? '',
    esiNumber: e?.esiNumber ?? '',
    priorTaxYear: e?.priorTaxYear ?? '',
    priorIncome: e && e.priorIncome !== '0.00' ? e.priorIncome : '',
    priorTds: e && e.priorTds !== '0.00' ? e.priorTds : '',
  };
}

/** Add an employee with their first salary, or edit an employee's details (salary changes are revisions). */
export function EmployeeDialog({ open, employee, defaultState, onClose }: { open: boolean; employee: Employee | null; defaultState: string; onClose: (saved?: Employee) => void }) {
  const { orgId } = useOrg();
  const states = useGstStates();
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => draftOf(employee, defaultState));
  const [components, setComponents] = useState<ComponentDraft[]>(DEFAULT_COMPONENTS);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: d.code,
        name: d.name,
        email: d.email || null,
        pan: d.pan || null,
        dateOfJoining: d.dateOfJoining,
        dateOfLeaving: d.dateOfLeaving || null,
        workStateCode: d.workStateCode || null,
        ptCategory: d.ptCategory,
        pfMember: d.pfMember,
        epsMember: d.pfMember && d.epsMember,
        pfOnFullWages: d.pfMember && d.pfOnFullWages,
        uan: d.uan || null,
        esiNumber: d.esiNumber || null,
        priorTaxYear: d.priorIncome || d.priorTds ? d.priorTaxYear || null : null,
        priorIncome: d.priorIncome || '0',
        priorTds: d.priorTds || '0',
      };
      return employee
        ? api<Employee>(`/v1/orgs/${orgId}/payroll/employees/${employee.id}`, { method: 'PUT', body })
        : api<Employee>(`/v1/orgs/${orgId}/payroll/employees`, { method: 'POST', body: { ...body, structure: { effectiveFrom: `${d.dateOfJoining.slice(0, 7)}-01`, components: componentsBody(components) } } });
    },
    onSuccess: async (e) => {
      await qc.invalidateQueries({ queryKey: ['employees', orgId] });
      await qc.invalidateQueries({ queryKey: ['employee', orgId, e.id] });
      onClose(e);
    },
  });
  const pan = d.pan ? checkPan(d.pan) : null;
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={employee ? `Edit ${employee.name}` : 'New employee'} description={employee ? 'Salary changes are revisions from a month; add them on the employee page.' : 'Their first salary applies from the month they join.'}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Employee code">{(p) => <Input {...p} className="num" value={d.code} maxLength={30} onChange={(e) => set({ code: e.target.value })} />}</Field>
        <Field label="Name">{(p) => <Input {...p} value={d.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />}</Field>
        <Field label="PAN" error={pan && !pan.valid ? pan.issues[0] : undefined} hint="Without a PAN, TDS is at least 20% of taxable salary once tax is due.">{(p) => <Input {...p} className="num uppercase" value={d.pan} maxLength={10} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Email (optional)">{(p) => <Input {...p} type="email" value={d.email} maxLength={200} onChange={(e) => set({ email: e.target.value })} />}</Field>
        <Field label="Date of joining">{(p) => <Input {...p} type="date" value={d.dateOfJoining} onChange={(e) => set({ dateOfJoining: e.target.value })} />}</Field>
        <Field label="Date of leaving" hint="Leave empty while employed.">{(p) => <Input {...p} type="date" value={d.dateOfLeaving} onChange={(e) => set({ dateOfLeaving: e.target.value })} />}</Field>
        <Field label="Work state" hint="Decides professional tax.">
          {(p) => (
            <Select {...p} value={d.workStateCode} onChange={(e) => set({ workStateCode: e.target.value })}>
              <option value="">None</option>
              {(states.data ?? []).filter((s) => s.code !== '96' && s.code !== '97').map((s) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Professional tax category">
          {(p) => (
            <Select {...p} value={d.ptCategory} onChange={(e) => set({ ptCategory: e.target.value as PtCategory })}>
              <option value="GENERAL">Standard slab</option>
              <option value="WOMAN">Woman (Maharashtra: nil up to ₹25,000)</option>
              <option value="EXEMPT">Exempt under the state Act</option>
            </Select>
          )}
        </Field>
        <fieldset className="flex flex-col gap-2 text-sm sm:col-span-2">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">Provident fund</legend>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={d.pfMember} onChange={(e) => set({ pfMember: e.target.checked, epsMember: e.target.checked && d.epsMember, pfOnFullWages: e.target.checked && d.pfOnFullWages })} /> PF member</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" disabled={!d.pfMember} checked={d.epsMember} onChange={(e) => set({ epsMember: e.target.checked })} /> Pension scheme (EPS) member</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" disabled={!d.pfMember} checked={d.pfOnFullWages} onChange={(e) => set({ pfOnFullWages: e.target.checked })} /> PF on full wages above the ceiling (agreed with the employee)</label>
        </fieldset>
        <Field label="UAN (optional)">{(p) => <Input {...p} className="num" value={d.uan} maxLength={20} onChange={(e) => set({ uan: e.target.value })} />}</Field>
        <Field label="ESI number (optional)">{(p) => <Input {...p} className="num" value={d.esiNumber} maxLength={20} onChange={(e) => set({ esiNumber: e.target.value })} />}</Field>
        <details className="sm:col-span-2" open={!!(d.priorIncome || d.priorTds)}>
          <summary className="cursor-pointer text-sm text-fg-muted">Salary from a previous employer this tax year</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field label="Tax year" hint="For example 2026-27.">{(p) => <Input {...p} className="num" value={d.priorTaxYear} maxLength={7} placeholder="2026-27" onChange={(e) => set({ priorTaxYear: e.target.value })} />}</Field>
            <Field label="Taxable salary (₹)">{(p) => <Input {...p} className="num" inputMode="decimal" value={d.priorIncome} onChange={(e) => AMT.test(e.target.value) && set({ priorIncome: e.target.value })} />}</Field>
            <Field label="TDS deducted (₹)">{(p) => <Input {...p} className="num" inputMode="decimal" value={d.priorTds} onChange={(e) => AMT.test(e.target.value) && set({ priorTds: e.target.value })} />}</Field>
          </div>
        </details>
        {!employee ? (
          <div className="sm:col-span-2">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Monthly salary{d.dateOfJoining ? ` from ${d.dateOfJoining.slice(0, 7)}` : ''}</p>
            <SalaryEditor value={components} onChange={setComponents} />
          </div>
        ) : null}
        {save.error ? <div className="sm:col-span-2"><Alert title="Not saved">{save.error.message}{save.error instanceof ApiError && save.error.issues.length ? <ul className="mt-1 list-inside list-disc">{save.error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert></div> : null}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={() => onClose()}>Cancel</Button>
          <Button type="submit" loading={save.isPending} disabled={!d.code.trim() || !d.name.trim() || !d.dateOfJoining || (!!pan && !pan.valid)}>{employee ? 'Save employee' : 'Add employee'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
