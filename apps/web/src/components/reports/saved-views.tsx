'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AS_OF_PRESETS, RANGE_PRESETS, VIEW_REPORTS, type ViewReport } from '@talk2tax/accounting-engine';
import { Button, Input, Select } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';

export interface ViewParams {
  from: string | null;
  to: string;
  basis?: 'ACCRUAL' | 'CASH' | null;
  departmentId?: string | null;
  projectId?: string | null;
}
type SavedView = { id: string; name: string; shared: boolean; mine: boolean; canChange: boolean; owner: { name: string | null }; opensWith: ViewParams };

/**
 * Saved views for a report (RPT-028, RPT-029, RPT-037): open a view to apply its filters, or save
 * the filters on screen under a name, with the period kept fixed or relative to the day it is
 * opened, for yourself or shared with everyone who can read reports.
 */
export function SavedViews({ orgId, report, current, onApply }: { orgId: string; report: ViewReport; current: ViewParams; onApply: (p: ViewParams) => void }) {
  const qc = useQueryClient();
  const key = ['report-views', orgId, report];
  const base = `/v1/orgs/${orgId}/report-views`;
  const q = useQuery({ queryKey: key, queryFn: () => api<SavedView[]>(`${base}?report=${report}`) });
  const asOf = VIEW_REPORTS[report].dates === 'AS_OF';
  const presets = asOf ? AS_OF_PRESETS : RANGE_PRESETS;
  const [selected, setSelected] = useState('');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<string>('FIXED');
  const [shared, setShared] = useState(false);
  const allowed: readonly string[] = VIEW_REPORTS[report].filters;
  const save = useMutation({
    mutationFn: () => {
      const filters: Record<string, unknown> = { dates: { preset, from: preset === 'FIXED' && !asOf ? current.from : null, to: preset === 'FIXED' ? current.to : null } };
      for (const k of ['basis', 'departmentId', 'projectId'] as const) if (allowed.includes(k) && current[k]) filters[k] = current[k];
      return api<SavedView>(base, { method: 'POST', body: { name, report, filters, shared } });
    },
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: key });
      setSelected(v.id);
      onApply(v.opensWith);
      setOpen(false);
      setName('');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelected('');
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const views = q.data ?? [];
  const chosen = views.find((v) => v.id === selected);
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
          Saved view
          <Select
            className="w-80"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              const v = views.find((x) => x.id === e.target.value);
              if (v) onApply(v.opensWith);
            }}
          >
            <option value="">{views.length ? 'Choose a view…' : 'No saved views yet'}</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.shared ? (v.mine ? ' (shared)' : ` (shared by ${v.owner.name ?? 'a member'})`) : ''}</option>
            ))}
          </Select>
        </label>
        <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Save view'}</Button>
        {chosen?.canChange ? <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate(chosen.id)}>Delete view</Button> : null}
      </div>
      {open ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
            View name
            <Input className="w-64" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
            {asOf ? 'Date when opened' : 'Period when opened'}
            <Select className="w-64" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Share with everyone who can read reports
          </label>
          <Button type="submit" size="sm" disabled={!name.trim()} loading={save.isPending}>Save</Button>
        </form>
      ) : null}
      <ErrorAlert title="The view was not saved" error={save.error} />
      <ErrorAlert title="The view was not deleted" error={remove.error} />
    </div>
  );
}
