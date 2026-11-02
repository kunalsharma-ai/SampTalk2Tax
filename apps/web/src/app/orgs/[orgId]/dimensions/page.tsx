'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { TYPE_LABEL, useDimensions, type DimensionType, type DimensionValue } from '@/lib/dimensions';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Form = { code: string; name: string; description: string; customer: string; startDate: string; endDate: string; isActive: boolean };
const empty: Form = { code: '', name: '', description: '', customer: '', startDate: '', endDate: '', isActive: true };
const fromValue = (v: DimensionValue): Form => ({ code: v.code, name: v.name, description: v.description ?? '', customer: v.customer ?? '', startDate: v.startDate ?? '', endDate: v.endDate ?? '', isActive: v.isActive });
const body = (type: DimensionType, f: Form) => ({
  code: f.code,
  name: f.name,
  description: f.description || null,
  ...(type === 'PROJECT' ? { customer: f.customer || null, startDate: f.startDate || null, endDate: f.endDate || null } : {}),
});

export default function DimensionsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const q = useDimensions();
  const [type, setType] = useState<DimensionType>('DEPARTMENT');
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['dimensions', orgId] });
  if (!org) return null;
  const all = q.data?.values ?? [];
  const values = all.filter((v) => v.type === type);
  const manage = !!q.data?.can.manage;
  const project = type === 'PROJECT';
  return (
    <>
      <PageHeader
        title="Departments and projects"
        description="Tag journal, invoice and bill lines with a department (a cost centre) and a project to see profit for each. Values are never deleted: make one inactive to stop new lines using it, and its history stays in the reports."
        actions={<Link href={`/orgs/${orgId}/reports/profit-by-dimension`}><Button variant="secondary">Profit by department or project</Button></Link>}
      />
      <ErrorAlert title="Could not load departments and projects" error={q.error} />
      <div className="mb-4 flex gap-2" role="tablist" aria-label="Kind">
        {(['DEPARTMENT', 'PROJECT'] as const).map((t) => (
          <Button key={t} role="tab" aria-selected={type === t} size="sm" variant={type === t ? 'primary' : 'ghost'} onClick={() => { setType(t); setEditing(null); }}>
            {t === 'DEPARTMENT' ? 'Departments' : 'Projects'} ({all.filter((v) => v.type === t).length})
          </Button>
        ))}
      </div>
      {manage ? <NewValue key={type} type={type} orgId={orgId} onDone={refresh} /> : null}
      {q.data ? (
        values.length ? (
          <Card className="overflow-x-auto">
            <Table aria-label={project ? 'Projects' : 'Departments'}>
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  {project ? <Th>Customer</Th> : null}
                  {project ? <Th>Runs</Th> : null}
                  <Th numeric>Lines tagged</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {values.map((v) =>
                  editing === v.id ? (
                    <Tr key={v.id}>
                      <Td colSpan={project ? 7 : 5}>
                        <EditValue v={v} orgId={orgId} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />
                      </Td>
                    </Tr>
                  ) : (
                    <Tr key={v.id}>
                      <Td className="num font-medium">{v.code}</Td>
                      <Td>
                        {v.name}
                        {v.description ? <span className="block text-xs text-fg-faint">{v.description}</span> : null}
                      </Td>
                      {project ? <Td>{v.customer ?? <span className="text-fg-faint">—</span>}</Td> : null}
                      {project ? <Td className="whitespace-nowrap text-xs">{v.startDate ? date(v.startDate) : 'Open'} to {v.endDate ? date(v.endDate) : 'open'}</Td> : null}
                      <Td numeric className="num">{v.lines}</Td>
                      <Td>{v.isActive ? <Badge tone="positive">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                      <Td>{manage ? <Button size="sm" variant="ghost" aria-label={`Change ${v.code}`} onClick={() => setEditing(v.id)}>Change…</Button> : null}</Td>
                    </Tr>
                  ),
                )}
              </tbody>
            </Table>
          </Card>
        ) : (
          <Card><EmptyState title={project ? 'No projects yet' : 'No departments yet'}>{project ? 'Add a project to track the revenue and cost of a job or contract.' : 'Add departments such as Sales or Operations to see what each one earns and spends.'}</EmptyState></Card>
        )
      ) : null}
    </>
  );
}

function Fields({ type, f, set }: { type: DimensionType; f: Form; set: (k: keyof Form) => (e: { target: { value: string } }) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
      <Field label="Code" hint="Letters, digits, - and _">{(p) => <Input {...p} className="uppercase" value={f.code} onChange={set('code')} maxLength={20} required />}</Field>
      <Field label="Name">{(p) => <Input {...p} value={f.name} onChange={set('name')} maxLength={120} required />}</Field>
      <div className="md:col-span-2">
        <Field label="Description (optional)">{(p) => <Input {...p} value={f.description} onChange={set('description')} maxLength={500} />}</Field>
      </div>
      {type === 'PROJECT' ? (
        <>
          <Field label="Customer (optional)">{(p) => <Input {...p} value={f.customer} onChange={set('customer')} maxLength={200} />}</Field>
          <Field label="Starts (optional)">{(p) => <Input {...p} type="date" value={f.startDate} onChange={set('startDate')} />}</Field>
          <Field label="Ends (optional)">{(p) => <Input {...p} type="date" value={f.endDate} onChange={set('endDate')} />}</Field>
        </>
      ) : null}
    </div>
  );
}

function NewValue({ type, orgId, onDone }: { type: DimensionType; orgId: string; onDone: () => void }) {
  const [f, setF] = useState<Form>(empty);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api<DimensionValue>(`/v1/orgs/${orgId}/dimensions`, { method: 'POST', body: { type, ...body(type, f) } }),
    onSuccess: () => { setF(empty); onDone(); },
  });
  const label = TYPE_LABEL[type].toLowerCase();
  return (
    <Card className="mb-4 p-4" aria-label={`Add a ${label}`}>
      <CardHeader title={`Add a ${label}`} />
      <form className="mt-3 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Fields type={type} f={f} set={set} />
        <ErrorAlert title="Not added" error={save.error} />
        <div><Button type="submit" loading={save.isPending}>Add {label}</Button></div>
      </form>
    </Card>
  );
}

function EditValue({ v, orgId, onDone, onCancel }: { v: DimensionValue; orgId: string; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<Form>(() => fromValue(v));
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => api<DimensionValue>(`/v1/orgs/${orgId}/dimensions/${v.id}`, { method: 'PUT', body: { ...body(v.type, f), isActive: f.isActive } }),
    onSuccess: onDone,
  });
  return (
    <form className="flex flex-col gap-3 py-2" aria-label={`Change ${v.code}`} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Fields type={v.type} f={f} set={set} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.isActive} onChange={(e) => setF((x) => ({ ...x, isActive: e.target.checked }))} />
        Active (new lines can use it)
      </label>
      {!f.isActive && v.lines ? <p className="text-xs text-fg-muted">Its {v.lines} tagged lines keep the tag and still show in the reports.</p> : null}
      <ErrorAlert title="Not saved" error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>Save</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
