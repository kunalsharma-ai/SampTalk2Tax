'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, SectionHelpSlot, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Rule {
  id: string;
  name: string;
  isActive: boolean;
  accountIds: string[];
  accounts: { id: string; code: string | null; name: string }[];
  sourceDepartmentId: string | null;
  source: string;
  targets: { departmentId: string; name: string; percent: string }[];
}
interface Run {
  id: string;
  ruleId: string;
  ruleName: string;
  from: string;
  to: string;
  total: string;
  status: 'POSTED' | 'REVERSED';
  journalEntryId: string;
  reversalEntryId: string | null;
  postedBy: string | null;
  postedAt: string;
}
interface Data {
  currency: string;
  rules: Rule[];
  runs: Run[];
  options: { departments: { id: string; code: string; name: string }[]; accounts: { id: string; code: string; name: string }[] };
}
interface Preview {
  total: string;
  lines: { accountId: string; debit?: string; credit?: string; departmentId: string | null; description: string }[];
  alreadyPostedRunId: string | null;
}

const monthStart = () => `${today().slice(0, 7)}-01`;

/** Cost allocation (GL-024): shared costs spread to cost centres (departments) by percentage. */
export default function CostAllocationsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['cost-allocations', orgId], queryFn: () => api<Data>(`/v1/orgs/${orgId}/cost-allocations`) });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  if (!org) return null;
  const d = q.data;
  const manage = can(org.role, 'accounts.manage');
  const run = can(org.role, 'close.manage') && can(org.role, 'journals.post');
  return (
    <>
      <PageHeader
        title="Cost allocation"
        description="Spread shared costs, such as rent, power or software, from where they were booked to the cost centres (departments) that use them, by fixed percentages. Each run posts one journal for a period, once; reverse it to run again."
        actions={manage && !editing ? <Button onClick={() => setEditing('new')}>New rule</Button> : null}
      />
      <ErrorAlert title="Could not load cost allocation" error={q.error as Error | null} />
      {d && editing ? <RuleEditor orgId={orgId} data={d} rule={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : null}
      {d && !d.rules.length && !editing ? (
        <Card className="mb-4"><EmptyState title="No allocation rules yet">{d.options.departments.length < 2 ? <>Add at least two departments in <Link className="text-accent underline" href={`/orgs/${orgId}/dimensions`}>Departments and projects</Link> first.</> : 'Add a rule such as rent split by floor area.'}</EmptyState></Card>
      ) : null}
      {d?.rules.map((r) => <RuleCard key={r.id} orgId={orgId} rule={r} currency={d.currency} departments={d.options.departments} canRun={run} canEdit={manage} onEdit={() => setEditing(r)} />)}
      {d?.runs.length ? (
        <Card>
          <CardHeader title="Allocation runs" />
          <Table aria-label="Allocation runs">
            <thead>
              <tr><Th>Rule</Th><Th>Period</Th><Th numeric>Allocated</Th><Th>Journal</Th><Th>Status</Th><Th /></tr>
            </thead>
            <tbody>
              {d.runs.map((x) => <RunRow key={x.id} orgId={orgId} run={x} currency={d.currency} canRun={run} />)}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}

function RuleCard({ orgId, rule, currency, departments, canRun, canEdit, onEdit }: { orgId: string; rule: Rule; currency: string; departments: { id: string; code: string; name: string }[]; canRun: boolean; canEdit: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [preview, setPreview] = useState<Preview | null>(null);
  const base = `/v1/orgs/${orgId}/cost-allocations/rules/${rule.id}`;
  const look = useMutation({ mutationFn: () => api<Preview>(`${base}/preview?from=${from}&to=${to}`), onSuccess: setPreview });
  const post = useMutation({
    mutationFn: () => api(`${base}/run`, { method: 'POST', body: { from, to } }),
    onSuccess: async () => {
      setPreview(null);
      await qc.invalidateQueries({ queryKey: ['cost-allocations', orgId] });
    },
  });
  const deptName = (id: string | null) => (id ? (departments.find((x) => x.id === id)?.name ?? rule.targets.find((t) => t.departmentId === id)?.name ?? '') : 'No department');
  return (
    <Card className="mb-4">
      <CardHeader
        title={rule.name}
        help={<SectionHelpSlot title="Allocation rule" />}
        description={`${rule.accounts.map((a) => `${a.code ?? ''} ${a.name}`.trim()).join(', ')} · from ${rule.source.toLowerCase()} to ${rule.targets.map((t) => `${t.name.replace(/^\S+ /, '')} ${t.percent}%`).join(', ')}`}
        actions={<div className="flex items-center gap-2">{rule.isActive ? null : <Badge tone="warning">Switched off</Badge>}{canEdit ? <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button> : null}</div>}
      />
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={`From (${rule.name})`}>{(p) => <Input {...p} type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} />}</Field>
          <Field label={`To (${rule.name})`}>{(p) => <Input {...p} type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} />}</Field>
          <Button variant="secondary" onClick={() => look.mutate()} disabled={look.isPending}>Preview</Button>
          {canRun && preview && preview.lines.length && !preview.alreadyPostedRunId ? <Button onClick={() => post.mutate()} disabled={post.isPending || !rule.isActive}>Post allocation of <Money value={preview.total} currency={currency} /></Button> : null}
        </div>
        <ErrorAlert title="Could not do that" error={(look.error ?? post.error) as Error | null} />
        {preview ? (
          preview.alreadyPostedRunId ? <p className="text-sm text-fg-muted">Already posted for this period. Reverse that run below to post it again.</p>
          : !preview.lines.length ? <p className="text-sm text-fg-muted">Nothing to allocate: no cost on these accounts {rule.sourceDepartmentId ? 'in that department' : 'without a department'} in the period.</p>
          : (
            <Table aria-label={`Allocation preview for ${rule.name}`}>
              <thead><tr><Th>Line</Th><Th>Department</Th><Th numeric>Debit</Th><Th numeric>Credit</Th></tr></thead>
              <tbody>
                {preview.lines.map((l, i) => (
                  <Tr key={i}>
                    <Td>{rule.accounts.find((a) => a.id === l.accountId)?.name} · {l.description.endsWith('out') ? 'out' : 'in'}</Td>
                    <Td>{deptName(l.departmentId)}</Td>
                    <Td numeric>{l.debit ? <Money value={l.debit} currency={currency} /> : ''}</Td>
                    <Td numeric>{l.credit ? <Money value={l.credit} currency={currency} /> : ''}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )
        ) : null}
      </div>
    </Card>
  );
}

function RunRow({ orgId, run, currency, canRun }: { orgId: string; run: Run; currency: string; canRun: boolean }) {
  const qc = useQueryClient();
  const reverse = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/cost-allocations/runs/${run.id}/reverse`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cost-allocations', orgId] }) });
  return (
    <Tr>
      <Td>{run.ruleName}<span className="block text-xs text-fg-muted">{run.postedBy ?? ''}</span></Td>
      <Td className="whitespace-nowrap">{date(run.from)} – {date(run.to)}</Td>
      <Td numeric><Money value={run.total} currency={currency} /></Td>
      <Td><Link className="text-accent underline" href={`/orgs/${orgId}/journals/${run.journalEntryId}`}>Journal</Link>{run.reversalEntryId ? <> · <Link className="text-accent underline" href={`/orgs/${orgId}/journals/${run.reversalEntryId}`}>reversal</Link></> : null}</Td>
      <Td><Badge tone={run.status === 'POSTED' ? 'positive' : 'neutral'}>{run.status === 'POSTED' ? 'Posted' : 'Reversed'}</Badge></Td>
      <Td>{canRun && run.status === 'POSTED' ? <Button size="sm" variant="ghost" onClick={() => reverse.mutate()} disabled={reverse.isPending}>Reverse</Button> : null}{reverse.error ? <span className="block text-xs text-negative">{(reverse.error as Error).message}</span> : null}</Td>
    </Tr>
  );
}

function RuleEditor({ orgId, data, rule, onDone }: { orgId: string; data: Data; rule: Rule | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(rule?.name ?? '');
  const [accountIds, setAccountIds] = useState<string[]>(rule?.accountIds ?? []);
  const [source, setSource] = useState<string>(rule?.sourceDepartmentId ?? '');
  const [targets, setTargets] = useState<{ departmentId: string; percent: string }[]>(rule?.targets.map(({ departmentId, percent }) => ({ departmentId, percent })) ?? [{ departmentId: '', percent: '' }, { departmentId: '', percent: '' }]);
  const [isActive, setActive] = useState(rule?.isActive ?? true);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, accountIds, sourceDepartmentId: source || null, targets: targets.filter((t) => t.departmentId || t.percent), isActive };
      return rule ? api(`/v1/orgs/${orgId}/cost-allocations/rules/${rule.id}`, { method: 'PUT', body }) : api(`/v1/orgs/${orgId}/cost-allocations/rules`, { method: 'POST', body });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['cost-allocations', orgId] });
      onDone();
    },
  });
  const sum = targets.reduce((s, t) => s + (Number(t.percent) || 0), 0);
  const set = (i: number, patch: Partial<{ departmentId: string; percent: string }>) => setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <Card className="mb-4">
      <CardHeader title={rule ? `Edit ${rule.name}` : 'New allocation rule'} help={<SectionHelpSlot title="New allocation rule" />} description="Choose the expense accounts, where the cost sits now, and how it is shared. Shares add up to 100 percent." />
      <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rent by floor area" maxLength={100} required />}</Field>
        <fieldset>
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Expense accounts to allocate</legend>
          <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
            {data.options.accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={accountIds.includes(a.id)} onChange={(e) => setAccountIds((xs) => (e.target.checked ? [...xs, a.id] : xs.filter((x) => x !== a.id)))} />
                <span className="num text-fg-muted">{a.code}</span> {a.name}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Cost booked to">{(p) => (
          <Select {...p} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">No department</option>
            {data.options.departments.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}
          </Select>
        )}</Field>
        <fieldset>
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Shared to</legend>
          <div className="space-y-2">
            {targets.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_8rem_auto] items-center gap-2">
                <Select aria-label={`Department ${i + 1}`} value={t.departmentId} onChange={(e) => set(i, { departmentId: e.target.value })}>
                  <option value="">Choose a department</option>
                  {data.options.departments.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}
                </Select>
                <Input aria-label={`Share ${i + 1} (percent)`} className="num text-right" inputMode="decimal" value={t.percent} onChange={(e) => set(i, { percent: e.target.value })} placeholder="%" />
                <Button type="button" size="sm" variant="ghost" onClick={() => setTargets((ts) => ts.filter((_, j) => j !== i))} aria-label={`Remove department ${i + 1}`}>Remove</Button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Button type="button" size="sm" variant="ghost" onClick={() => setTargets((ts) => [...ts, { departmentId: '', percent: '' }])}>Add a department</Button>
            <span className={`text-sm ${Math.abs(sum - 100) < 1e-9 ? 'text-positive' : 'text-fg-muted'}`}>Total {Number(sum.toFixed(4))}%</span>
          </div>
        </fieldset>
        {rule ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isActive} onChange={(e) => setActive(e.target.checked)} /> In use</label> : null}
        <ErrorAlert title="Could not save the rule" error={save.error as Error | null} />
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>{rule ? 'Save' : 'Add rule'}</Button>
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
