'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Select, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { ScenarioBuilder } from '@/components/twin/scenario-builder';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe, useOrg } from '@/lib/org';
import { DRIVERS, monthLabel, shiftYm, STATUS, versionReason, type Scenario, type ScenarioDetail, type ScenarioNote } from '@/lib/twin';
import { can } from '@/lib/types';

/**
 * The scenario war room: the scenario itself (changes, projection, impacts, suggestions), its
 * approval, the team's notes pinned to months or changes, and every saved version.
 */
export default function ScenarioPage() {
  const { org, orgId } = useOrg();
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const key = ['twin-scenario', orgId, scenarioId];
  const q = useQuery({ queryKey: key, queryFn: () => api<ScenarioDetail>(`/v1/orgs/${orgId}/twin/scenarios/${scenarioId}`) });
  const [savedAs, setSavedAs] = useState<number | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['twin-scenarios', orgId] });
  };
  const del = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/twin/scenarios/${scenarioId}`, { method: 'DELETE' }), onSuccess: () => router.push(`/orgs/${orgId}/planning/twin`) });
  if (!org) return null;
  const manage = can(org.role, 'scenarios.manage');
  const d = q.data;
  const s = d?.scenario;
  const locked = s?.status === 'SUBMITTED' || s?.status === 'APPROVED';
  return (
    <>
      <PageHeader
        title={s?.name ?? 'Scenario'}
        description={s?.description ?? 'A saved what-if scenario, re-run against the latest actual figures.'}
        actions={
          <>
            {manage && s && !locked ? <Button variant="ghost" onClick={() => confirm(`Delete the scenario "${s.name}"?`) && del.mutate()}>Delete</Button> : null}
            {s?.status === 'APPROVED' && can(org.role, 'decisions.manage') ? <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/decisions/new?sourceType=SCENARIO&sourceId=${s.id}`}>Record as a decision</Link> : null}
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/twin`}>All scenarios</Link>
          </>
        }
      />
      <ErrorAlert title="Could not load the scenario" error={q.error ?? del.error} />
      {d && s ? (
        <div className="space-y-4">
          <ApprovalBar orgId={orgId} s={s} people={d.people} myId={me.data?.user.id} canManage={manage} canApprove={can(org.role, 'scenarios.approve')} savedAs={savedAs} onDone={() => (setSavedAs(null), refresh())} />
          <ScenarioBuilder
            key={`${s.id}:${s.version}:${s.status}`}
            orgId={orgId}
            scenarioId={s.id}
            canManage={manage}
            locked={locked}
            initial={s}
            onSaved={(x) => (setSavedAs(x.version), refresh())}
          />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
            <Notes orgId={orgId} d={d} myId={me.data?.user.id} canManage={manage} onDone={refresh} />
            <Versions orgId={orgId} d={d} canRestore={manage && !locked} onDone={refresh} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ApprovalBar({ orgId, s, people, myId, canManage, canApprove, savedAs, onDone }: { orgId: string; s: Scenario; people: Record<string, string>; myId?: string; canManage: boolean; canApprove: boolean; savedAs: number | null; onDone: () => void }) {
  const [note, setNote] = useState('');
  const act = useMutation({
    mutationFn: (a: 'submit' | 'withdraw' | 'approve' | 'reject' | 'reopen') => api<Scenario>(`/v1/orgs/${orgId}/twin/scenarios/${s.id}/${a}`, { method: 'POST', body: a === 'approve' || a === 'reject' ? { note: note.trim() || null } : undefined }),
    onSuccess: () => (setNote(''), onDone()),
  });
  const st = STATUS[s.status];
  const mine = !!myId && s.submittedById === myId;
  const who = (id: string | null) => (id ? people[id] ?? 'someone' : 'someone');
  return (
    <Card className="p-4" aria-label="Approval">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            <span className="text-sm text-fg-muted">Version {s.version}</span>
            {savedAs ? <span role="status" className="text-sm text-positive">Saved as version {savedAs}</span> : null}
          </div>
          <p className="text-sm text-fg-muted">
            {s.status === 'DRAFT' ? 'A draft: change it freely, then submit it for approval when the team agrees.' : null}
            {s.status === 'SUBMITTED' ? `Submitted by ${who(s.submittedById)} on ${dateTime(s.submittedAt!)}. Frozen until it is decided or withdrawn.` : null}
            {s.status === 'APPROVED' ? `Approved by ${who(s.decidedById)} on ${dateTime(s.decidedAt!)}. Frozen: reopen it as a draft to change it.` : null}
            {s.status === 'REJECTED' ? `Rejected by ${who(s.decidedById)} on ${dateTime(s.decidedAt!)}. Change it and submit it again.` : null}
          </p>
          {s.decisionNote ? <p className="text-sm" aria-label="Decision note">“{s.decisionNote}”</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (s.status === 'DRAFT' || s.status === 'REJECTED') ? <Button onClick={() => act.mutate('submit')} loading={act.isPending}>Submit for approval</Button> : null}
          {canManage && s.status === 'SUBMITTED' ? <Button variant="secondary" onClick={() => act.mutate('withdraw')} loading={act.isPending}>Withdraw</Button> : null}
          {canManage && s.status === 'APPROVED' ? <Button variant="secondary" onClick={() => act.mutate('reopen')} loading={act.isPending}>Reopen as draft</Button> : null}
        </div>
      </div>
      {s.status === 'SUBMITTED' && canApprove ? (
        mine ? (
          <p className="mt-3 text-sm text-fg-muted">You submitted this scenario, so someone else must approve or reject it.</p>
        ) : (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-[280px] flex-1">
              <Field label="Decision note" hint="Needed when rejecting.">{(p) => <Textarea {...p} rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}</Field>
            </div>
            <Button onClick={() => act.mutate('approve')} loading={act.isPending}>Approve</Button>
            <Button variant="danger" onClick={() => act.mutate('reject')} loading={act.isPending}>Reject</Button>
          </div>
        )
      ) : null}
      {act.error ? <div className="mt-3"><ErrorAlert title="Not done" error={act.error} /></div> : null}
    </Card>
  );
}

function Notes({ orgId, d, myId, canManage, onDone }: { orgId: string; d: ScenarioDetail; myId?: string; canManage: boolean; onDone: () => void }) {
  const s = d.scenario;
  const [body, setBody] = useState('');
  const [month, setMonth] = useState('');
  const [change, setChange] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const base = `/v1/orgs/${orgId}/twin/scenarios/${s.id}/notes`;
  const add = useMutation({
    mutationFn: () => api<ScenarioNote>(base, { method: 'POST', body: { body, month: month ? Number(month) : null, changeNumber: change ? Number(change) : null } }),
    onSuccess: () => (setBody(''), setMonth(''), setChange(''), onDone()),
  });
  const resolve = useMutation({ mutationFn: (n: ScenarioNote) => api(`${base}/${n.id}`, { method: 'PUT', body: { resolved: !n.resolvedAt } }), onSuccess: onDone });
  const remove = useMutation({ mutationFn: (n: ScenarioNote) => api(`${base}/${n.id}`, { method: 'DELETE' }), onSuccess: onDone });
  const first = shiftYm(d.result.baseline.toMonth, 1);
  const monthName = (n: number) => monthLabel(shiftYm(first, n - 1));
  const changeName = (n: number) => `${n}. ${s.drivers[n - 1]?.label || (s.drivers[n - 1] ? DRIVERS[s.drivers[n - 1]!.kind]?.title : 'Removed change')}`;
  const open = d.notes.filter((n) => !n.resolvedAt);
  const resolved = d.notes.filter((n) => n.resolvedAt);
  const list = showResolved ? [...open, ...resolved] : open;
  return (
    <Card className="p-4" aria-label="Notes">
      <CardHeader title={`Notes (${open.length} open)`} description="Questions and comments from the team, pinned to a month or a change when it helps." />
      {!list.length ? <p className="text-sm text-fg-muted">No open notes.</p> : null}
      <ul className="space-y-2" aria-label="Scenario notes">
        {list.map((n) => (
          <li key={n.id} className={`rounded-md border border-line p-3 text-sm ${n.resolvedAt ? 'opacity-70' : ''}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span className="font-medium text-fg">{d.people[n.authorId] ?? 'Someone'}</span>
              <span>{dateTime(n.createdAt)}</span>
              <Badge>v{n.version}</Badge>
              {n.month ? <Badge tone="accent">{monthName(n.month)}</Badge> : null}
              {n.changeNumber ? <Badge tone="violet">{changeName(n.changeNumber)}</Badge> : null}
              {n.resolvedAt ? <Badge tone="positive">Resolved by {d.people[n.resolvedById!] ?? 'someone'}</Badge> : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
            <div className="mt-1 flex gap-2">
              {n.authorId === myId || canManage ? <Button size="sm" variant="ghost" onClick={() => resolve.mutate(n)}>{n.resolvedAt ? 'Reopen' : 'Resolve'}</Button> : null}
              {n.authorId === myId ? <Button size="sm" variant="ghost" onClick={() => confirm('Delete this note?') && remove.mutate(n)}>Delete</Button> : null}
            </div>
          </li>
        ))}
      </ul>
      {resolved.length ? (
        <button type="button" className="mt-2 text-xs text-accent hover:underline" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide resolved notes' : `Show ${resolved.length} resolved`}
        </button>
      ) : null}
      <form
        className="mt-4 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Add a note">{(p) => <Textarea {...p} rows={2} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="About the month">
            {(p) => (
              <Select {...p} value={month} onChange={(e) => setMonth(e.target.value)}>
                <option value="">Any month</option>
                {Array.from({ length: s.horizonMonths }, (_, i) => <option key={i} value={i + 1}>{monthName(i + 1)}</option>)}
              </Select>
            )}
          </Field>
          <Field label="About the change">
            {(p) => (
              <Select {...p} value={change} onChange={(e) => setChange(e.target.value)}>
                <option value="">The whole scenario</option>
                {s.drivers.map((_, i) => <option key={i} value={i + 1}>{changeName(i + 1)}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={!body.trim()} loading={add.isPending}>Add note</Button>
        {add.error || resolve.error || remove.error ? <ErrorAlert title="Not done" error={add.error ?? resolve.error ?? remove.error} /> : null}
      </form>
    </Card>
  );
}

function Versions({ orgId, d, canRestore, onDone }: { orgId: string; d: ScenarioDetail; canRestore: boolean; onDone: () => void }) {
  const restore = useMutation({ mutationFn: (v: number) => api(`/v1/orgs/${orgId}/twin/scenarios/${d.scenario.id}/versions/${v}/restore`, { method: 'POST' }), onSuccess: onDone });
  return (
    <Card className="p-4" aria-label="Version history">
      <CardHeader title="Version history" description="Every saved set of changes. Restoring makes an earlier version the newest; nothing is lost." />
      <ol className="space-y-2" aria-label="Versions">
        {d.versions.map((v) => {
          const current = v.version === d.scenario.version;
          return (
            <li key={v.version} className="flex items-start justify-between gap-2 rounded-md border border-line p-3 text-sm">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg">Version {v.version}</span>
                  {current ? <Badge tone="accent">Current</Badge> : null}
                </div>
                <div className="text-xs text-fg-muted">
                  {versionReason(v.reason)} by {d.people[v.createdById] ?? 'someone'}, {dateTime(v.createdAt)}
                </div>
                <div className="text-xs text-fg-muted">{v.drivers.length ? v.drivers.map((x) => DRIVERS[x.kind]?.title ?? x.kind).join(', ') : 'No changes'} · {v.horizonMonths} months</div>
              </div>
              {canRestore && !current ? (
                <Button size="sm" variant="ghost" aria-label={`Restore version ${v.version}`} onClick={() => confirm(`Restore version ${v.version}? It becomes a new version; the current one is kept.`) && restore.mutate(v.version)}>
                  Restore
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {restore.error ? <ErrorAlert title="Not restored" error={restore.error} /> : null}
    </Card>
  );
}
