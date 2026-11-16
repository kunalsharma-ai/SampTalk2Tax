'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Textarea, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  assignee: { type: 'user'; userId: string; label: string } | { type: 'role'; role: string; label: string };
  dueDate: string | null;
  overdue: boolean;
  link: { path: string; label: string } | null;
  workflow: { id: string; name: string; runId: string } | null;
  source: Source;
  sourceLabel: string;
  createdBy: string | null;
  createdAt: string;
  closedBy: string | null;
  closedAt: string | null;
  closeNote: string | null;
  canClose: boolean;
}
interface TaskList {
  counts: { mineOpen: number; mineOverdue: number };
  tasks: Task[];
}
interface Member {
  userId: string;
  name: string;
  role: string;
}

type Source = 'PERSON' | 'WORKFLOW' | 'AI_AGENT' | 'ALERT' | 'CLOSE';
const SOURCES: { key: Source | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'Anywhere' },
  { key: 'PERSON', label: 'People' },
  { key: 'ALERT', label: 'Alerts' },
  { key: 'WORKFLOW', label: 'Automations' },
  { key: 'AI_AGENT', label: 'The AI assistant' },
  { key: 'CLOSE', label: 'Month-end close' },
];
const SOURCE_TONE: Record<Source, 'neutral' | 'negative' | 'accent' | 'violet' | 'warning'> = { PERSON: 'neutral', ALERT: 'negative', WORKFLOW: 'accent', AI_AGENT: 'violet', CLOSE: 'warning' };

/** Who or what made the task, in words. */
function origin(t: Task): string {
  if (t.source === 'ALERT') return 'From an alert';
  if (t.source === 'CLOSE') return `From the month-end close${t.createdBy ? `, by ${t.createdBy}` : ''}`;
  if (t.source === 'AI_AGENT') return `Proposed by the AI assistant, confirmed by ${t.createdBy ?? 'a former member'}`;
  return `From ${t.createdBy ?? 'a former member'}`;
}

const STATUSES = [
  { key: 'OPEN', label: 'Open' },
  { key: 'DONE', label: 'Done' },
  { key: 'CANCELLED', label: 'Cancelled' },
  { key: 'ALL', label: 'All' },
] as const;
const ROLES = [
  { role: 'OWNER', label: 'Owners' },
  { role: 'ADMIN', label: 'Admins' },
  { role: 'ACCOUNTANT', label: 'Accountants' },
  { role: 'APPROVER', label: 'Approvers' },
  { role: 'VIEWER', label: 'Viewers' },
];

export default function TasksPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [status, setStatus] = useState<(typeof STATUSES)[number]['key']>('OPEN');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [source, setSource] = useState<Source | 'ALL'>('ALL');
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<{ task: Task; to: 'complete' | 'cancel' } | null>(null);
  const q = useQuery({ queryKey: ['tasks', orgId, scope, status, source], queryFn: () => api<TaskList>(`/v1/orgs/${orgId}/tasks?scope=${scope}&status=${status}&source=${source}`), enabled: !!org });
  if (!org) return null;
  const manager = can(org.role, 'workflows.manage');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tasks', orgId] });
  return (
    <>
      <PageHeader
        title={scope === 'mine' ? 'My tasks' : 'Everyone’s tasks'}
        description="One queue for everything that needs doing: tasks for you or your role from people, alerts, automations, the AI assistant (once you confirm) and the month-end close. Each says where it came from and links to the record it is about."
        actions={<Button onClick={() => setCreating(true)}>New task</Button>}
      />
      <ErrorAlert title="Could not load tasks" error={q.error} />
      {q.data ? (
        <p className="mb-4 text-sm text-fg-muted" role="status">
          <span className="num font-medium text-fg">{q.data.counts.mineOpen}</span> open for you
          {q.data.counts.mineOverdue ? <>, <span className="num font-medium text-negative">{q.data.counts.mineOverdue} overdue</span></> : null}
        </p>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Tasks by state" className="flex flex-wrap gap-1 rounded-[var(--t2t-radius-md)] border border-line bg-surface p-1">
          {STATUSES.map((s) => (
            <button key={s.key} role="tab" type="button" aria-selected={status === s.key} onClick={() => setStatus(s.key)} className={cn('rounded px-3 py-1.5 text-sm transition-colors', status === s.key ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-surface-hover hover:text-fg')}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
          From
          <Select aria-label="Tasks from" className="w-44" value={source} onChange={(e) => setSource(e.target.value as Source | 'ALL')}>
            {SOURCES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </Select>
        </label>
        {manager ? (
          <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Show
            <Select className="w-56" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')}>
              <option value="mine">Mine and my role’s</option>
              <option value="all">Everyone’s</option>
            </Select>
          </label>
        ) : null}
        </div>
      </div>
      {q.data && !q.data.tasks.length ? (
        <Card>
          <EmptyState title={status === 'OPEN' ? 'Nothing to do' : 'No tasks here'}>{source !== 'ALL' ? 'None from here. Choose “Anywhere” to see every task.' : status === 'OPEN' ? 'New tasks for you or your role appear here.' : 'Closed tasks are kept here.'}</EmptyState>
        </Card>
      ) : null}
      {q.data?.tasks.length ? (
        <ul className="flex flex-col gap-2" aria-label="Tasks">
          {q.data.tasks.map((t) => (
            <li key={t.id}>
              <Card className="flex flex-wrap items-start justify-between gap-3 px-5 py-4" aria-label={t.title}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('font-medium', t.status !== 'OPEN' && 'text-fg-muted line-through')}>{t.title}</span>
                    {t.source !== 'PERSON' ? <Badge tone={SOURCE_TONE[t.source]}>{t.sourceLabel}</Badge> : null}
                    {t.status === 'DONE' ? <Badge tone="positive">Done</Badge> : t.status === 'CANCELLED' ? <Badge>Cancelled</Badge> : t.overdue ? <Badge tone="negative">Overdue</Badge> : null}
                  </div>
                  {t.description ? <p className="mt-1 whitespace-pre-line text-sm text-fg-muted">{t.description}</p> : null}
                  <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
                    <span>For {t.assignee.label}</span>
                    {t.dueDate ? <span className={cn(t.overdue && 'text-negative')}>Due {date(t.dueDate)}</span> : <span>No due date</span>}
                    {t.link ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${t.link.path}`}>{t.link.label}</Link> : null}
                    <span>{t.workflow ? <>From the automation {manager ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/automations/${t.workflow.id}`}>{t.workflow.name}</Link> : t.workflow.name}</> : origin(t)}</span>
                    {t.closedAt ? <span>{t.status === 'DONE' ? 'Done' : 'Cancelled'} {t.closedBy ? `by ${t.closedBy}` : t.source === 'ALERT' ? 'automatically' : 'by a former member'}{t.closeNote ? `: ${t.closeNote}` : ''}</span> : null}
                  </p>
                </div>
                {t.canClose ? (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => setClosing({ task: t, to: 'complete' })}>Mark done</Button>
                    <Button size="sm" variant="ghost" onClick={() => setClosing({ task: t, to: 'cancel' })}>Cancel task</Button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
      {creating ? <NewTask orgId={orgId} onClose={() => setCreating(false)} onCreated={refresh} /> : null}
      {closing ? <CloseTask orgId={orgId} task={closing.task} to={closing.to} onClose={() => setClosing(null)} onDone={refresh} /> : null}
    </>
  );
}

function NewTask({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: () => void }) {
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => api<Member[]>(`/v1/orgs/${orgId}/members`) });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [who, setWho] = useState('role:ACCOUNTANT');
  const [due, setDue] = useState('');
  const create = useMutation({
    mutationFn: () => {
      const [kind, v] = who.split(':');
      return api(`/v1/orgs/${orgId}/tasks`, { method: 'POST', body: { title, description: description || null, assignTo: kind === 'role' ? { role: v } : { userId: v }, dueDate: due || null } });
    },
    onSuccess: () => (onCreated(), onClose()),
  });
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())} title="New task" description="Give a task to a person or to everyone with a role.">
      <form className="flex flex-col gap-3" onSubmit={(e) => (e.preventDefault(), create.mutate())}>
        <Field label="Title">{(p) => <Input {...p} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Details (optional)">{(p) => <Textarea {...p} rows={3} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="For">
            {(p) => (
              <Select {...p} value={who} onChange={(e) => setWho(e.target.value)}>
                <optgroup label="Everyone with a role">{ROLES.map((r) => <option key={r.role} value={`role:${r.role}`}>{r.label}</option>)}</optgroup>
                <optgroup label="One person">{(members.data ?? []).filter((m) => m.role !== 'EMPLOYEE').map((m) => <option key={m.userId} value={`user:${m.userId}`}>{m.name}</option>)}</optgroup>
              </Select>
            )}
          </Field>
          <Field label="Due (optional)">{(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
        </div>
        <ErrorAlert title="The task was not created" error={create.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button type="submit" loading={create.isPending}>Create task</Button>
        </div>
      </form>
    </Dialog>
  );
}

function CloseTask({ orgId, task, to, onClose, onDone }: { orgId: string; task: Task; to: 'complete' | 'cancel'; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const close = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/tasks/${task.id}/${to}`, { method: 'POST', body: { note: note || null } }), onSuccess: () => (onDone(), onClose()) });
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())} title={to === 'complete' ? 'Mark the task done' : 'Cancel the task'} description={task.title}>
      <form className="flex flex-col gap-3" onSubmit={(e) => (e.preventDefault(), close.mutate())}>
        <Field label="Note (optional)" hint="Kept with the task.">{(p) => <Textarea {...p} rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}</Field>
        <ErrorAlert title="The task was not changed" error={close.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Back</Button>
          <Button type="submit" variant={to === 'complete' ? 'primary' : 'danger'} loading={close.isPending}>{to === 'complete' ? 'Mark done' : 'Cancel task'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
