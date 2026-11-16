'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert as Notice, Badge, Button, Card, Dialog, EmptyState, Field, Select, Stat, Table, Td, Textarea, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { ACTION_LABEL, ago, AREAS, BAND, dateTime, evidenceHref, SEVERITY, STATUS, type Alert, type AlertDetail, type AlertList, type Area, type Scan } from '@/lib/alerts';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function AlertsPage() {
  return (
    <Suspense>
      <Alerts />
    </Suspense>
  );
}

const VIEWS = [
  { key: 'ACTIVE', label: 'Needs attention' },
  { key: 'DISMISSED', label: 'Dismissed' },
  { key: 'CLEARED', label: 'Cleared' },
  { key: 'ALL', label: 'All' },
] as const;
type View = (typeof VIEWS)[number]['key'];

function Alerts() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const view = (VIEWS.find((v) => v.key === params.get('status'))?.key ?? 'ACTIVE') as View;
  const area = (params.get('area') as Area | null) ?? null;
  const openId = params.get('alert');
  const q = useQuery({ queryKey: ['alerts', orgId, view], queryFn: () => api<AlertList>(`/v1/orgs/${orgId}/alerts?status=${view}`) });
  const run = useMutation({ mutationFn: () => api<Scan>(`/v1/orgs/${orgId}/alerts/scan`, { method: 'POST' }), onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts', orgId] });
      void qc.invalidateQueries({ queryKey: ['alert', orgId] });
    },
  });
  if (!org) return null;
  const d = q.data;
  const c = d?.currency ?? org.functionalCurrency;
  const canManage = can(org.role, 'alerts.manage');
  const go = (next: Partial<{ status: View; area: Area | null; alert: string | null }>) => {
    const s = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === undefined || (k === 'status' && v === 'ACTIVE')) s.delete(k);
      else s.set(k, v);
    }
    router.replace(`/orgs/${orgId}/alerts${s.size ? `?${s}` : ''}`, { scroll: false });
  };
  const shown = (d?.alerts ?? []).filter((a) => !area || a.area === area);
  const scan = run.data ?? d?.lastScan ?? null;
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Checks on cash, compliance, budgets and targets, and for money that may be leaking: duplicate bills and payments, regular customers not billed, and unusual manual journals. Each alert shows the figures it was raised on and a priority score that explains the order. The checks run in the background every hour, and when you open this page if the last run is over an hour old."
        actions={
          <>
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/alerts/settings`}>Check settings</Link>
            {canManage ? <Button loading={run.isPending} onClick={() => run.mutate()}>Run checks now</Button> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load alerts" error={q.error} />
      <ErrorAlert title="The checks did not run" error={run.error} />
      {d ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Critical" value={d.summary.critical} tone={d.summary.critical ? 'negative' : 'neutral'} sub="Open or acknowledged" />
            <Stat label="Warnings" value={d.summary.warning} tone={d.summary.warning ? 'warning' : 'neutral'} sub="Open or acknowledged" />
            <Stat label="For information" value={d.summary.info} tone="accent" sub="Open or acknowledged" />
            <Stat label="Being looked at" value={d.summary.acknowledged} tone="violet" sub={`${d.summary.dismissed} dismissed · ${d.summary.cleared} cleared`} />
          </div>
          <ScanLine scan={scan} justRan={!!run.data} />
          {view === 'ACTIVE' && d.alerts.length ? (
            <p className="mb-3 text-sm text-fg-muted">
              Most urgent first: <span className="num font-medium text-fg">{d.bands.urgent}</span> urgent, <span className="num font-medium text-fg">{d.bands.high}</span> high, <span className="num">{d.bands.normal}</span> normal, <span className="num">{d.bands.low}</span> low. The order comes from how severe each alert is, the money at stake
              {d.monthlyRevenue ? <> against average monthly revenue of <Money value={d.monthlyRevenue} currency={c} /></> : ''}, how long it has been open and how often it came back. Open an alert to see its score.
            </p>
          ) : null}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" aria-label="Alerts by state" className="flex flex-wrap gap-1 rounded-[var(--t2t-radius-md)] border border-line bg-surface p-1">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  role="tab"
                  type="button"
                  aria-selected={view === v.key}
                  onClick={() => go({ status: v.key })}
                  className={cn('rounded px-3 py-1.5 text-sm transition-colors', view === v.key ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-surface-hover hover:text-fg')}
                >
                  {v.label}
                  {v.key === 'ACTIVE' ? <span className="num ml-1.5 text-xs text-fg-muted">{d.summary.open + d.summary.acknowledged}</span> : null}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Area
              <Select className="w-44" value={area ?? ''} onChange={(e) => go({ area: (e.target.value || null) as Area | null })}>
                <option value="">Every area</option>
                {AREAS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </Select>
            </label>
          </div>
          {shown.length ? (
            <ul className="flex flex-col gap-2" aria-label="Alerts">
              {shown.map((a) => <AlertRow key={a.id} a={a} currency={c} onOpen={() => go({ alert: a.id })} />)}
            </ul>
          ) : (
            <Card>
              <EmptyState title={view === 'ACTIVE' ? 'Nothing needs attention' : 'No alerts here'}>
                {view === 'ACTIVE' ? 'Every check that is on found nothing, or what it found was dismissed.' : 'Alerts move here when they are dismissed or no longer found.'}
              </EmptyState>
            </Card>
          )}
          {openId ? <AlertDialog id={openId} canManage={canManage} onClose={() => go({ alert: null })} /> : null}
        </>
      ) : null}
    </>
  );
}

function ScanLine({ scan, justRan }: { scan: Scan | null; justRan: boolean }) {
  if (!scan) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      <p className="text-sm text-fg-muted" role={justRan ? 'status' : undefined}>
        {justRan ? 'Checks finished' : 'Last checked'} {ago(scan.finishedAt)}
        {scan.automatic ? ' (automatically)' : scan.ranBy ? ` by ${scan.ranBy}` : ''} · {scan.rulesRun} checks ran · {scan.found} found
        {justRan ? ` · ${scan.opened} new, ${scan.reopened} back, ${scan.cleared} cleared` : ''}
      </p>
      {scan.failures.length ? (
        <Notice tone="warning" title={`${scan.failures.length} check${scan.failures.length === 1 ? '' : 's'} could not run`}>
          <ul className="list-inside list-disc">{scan.failures.map((f) => <li key={f.rule}>{f.rule}: {f.message}</li>)}</ul>
          Their earlier alerts were left as they were.
        </Notice>
      ) : null}
    </div>
  );
}

function AlertRow({ a, currency, onOpen }: { a: Alert; currency: string; onOpen: () => void }) {
  const s = SEVERITY[a.severity];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${s.label}: ${a.title}`}
        className="relative flex w-full flex-col gap-1 overflow-hidden rounded-[var(--t2t-radius-md)] border border-line bg-surface py-3 pl-5 pr-4 text-left transition hover:border-line-strong hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:flex-row sm:items-center sm:gap-4"
      >
        <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', s.bar)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={s.tone}>{s.label}</Badge>
            {a.priority.score > 0 ? <Badge tone={BAND[a.priority.band].tone}><span className="sr-only">Priority </span>{BAND[a.priority.band].label} · <span className="num">{a.priority.score}</span></Badge> : null}
            <span className="text-xs text-fg-muted">{a.ruleName}</span>
            {a.status !== 'OPEN' ? <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge> : null}
            {a.reopenCount ? <span className="text-xs text-fg-faint">back {a.reopenCount}×</span> : null}
          </span>
          <span className="mt-1 block text-sm font-medium text-fg">{a.title}</span>
          <span className="mt-0.5 block text-xs text-fg-muted">{a.summary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3 text-right sm:flex-col sm:items-end sm:gap-1">
          {a.amount ? <span className="num whitespace-nowrap text-sm font-semibold"><Money value={a.amount} currency={currency} /></span> : null}
          <span className="whitespace-nowrap text-xs text-fg-faint">First found {ago(a.firstSeenAt)}</span>
        </span>
      </button>
    </li>
  );
}

function AlertDialog({ id, canManage, onClose }: { id: string; canManage: boolean; onClose: () => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alert', orgId, id], queryFn: () => api<AlertDetail>(`/v1/orgs/${orgId}/alerts/${id}`) });
  const [mode, setMode] = useState<'acknowledge' | 'dismiss' | 'reopen' | null>(null);
  const [note, setNote] = useState('');
  const act = useMutation({
    mutationFn: (m: 'acknowledge' | 'dismiss' | 'reopen') => api<AlertDetail>(`/v1/orgs/${orgId}/alerts/${id}/${m}`, { method: 'POST', body: m === 'dismiss' ? { reason: note.trim() } : { note: note.trim() || null } }),
    onSuccess: (a) => {
      qc.setQueryData(['alert', orgId, id], a);
      void qc.invalidateQueries({ queryKey: ['alerts', orgId] });
      setMode(null);
      setNote('');
    },
  });
  const a = q.data;
  const reasonShort = mode === 'dismiss' && note.trim().length < 3;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={a?.title ?? 'Alert'} description={a ? `${a.ruleName}. ${a.ruleDescription ?? ''}` : undefined}>
      <ErrorAlert title="Could not load the alert" error={q.error} />
      {a ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY[a.severity].tone}>{SEVERITY[a.severity].label}</Badge>
            <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
            <span className="text-xs text-fg-muted">First found {dateTime(a.firstSeenAt)} · last found {dateTime(a.lastSeenAt)}</span>
          </div>
          <p className="text-sm">{a.summary}</p>
          {a.statusNote ? (
            <p className="rounded border border-line bg-surface px-3 py-2 text-sm">
              <span className="text-fg-muted">{a.status === 'DISMISSED' ? 'Dismissed' : 'Note'} by {a.statusBy}: </span>
              {a.statusNote}
            </p>
          ) : null}
          <section aria-label="Evidence">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">What was found</h3>
            <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-4 gap-y-1 text-sm">
              {a.evidence.facts.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-fg-muted">{f.label}</dt>
                  <dd className={cn(f.kind === 'money' && 'num')}>{f.value}</dd>
                </div>
              ))}
            </dl>
            {a.evidence.rows ? (
              <div className="mt-3 overflow-x-auto">
                <Table aria-label="Records">
                  <thead>
                    <tr>{a.evidence.rows.columns.map((h, i) => <Th key={h} numeric={i === a.evidence.rows!.columns.length - 1}>{h}</Th>)}</tr>
                  </thead>
                  <tbody>
                    {a.evidence.rows.items.map((r, i) => {
                      const href = r.link ? evidenceHref(orgId, r.link) : null;
                      return (
                        <Tr key={i}>
                          {r.cells.map((cell, j) => (
                            <Td key={j} numeric={j === r.cells.length - 1} className="whitespace-nowrap">
                              {j === 0 && href ? <Link className="text-accent hover:underline" href={href}>{cell}</Link> : cell}
                            </Td>
                          ))}
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            ) : null}
            {a.evidence.links.length ? (
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {a.evidence.links.map((l) => {
                  const href = evidenceHref(orgId, l);
                  return href ? <li key={l.label}><Link className="text-accent hover:underline" href={href}>{l.label}</Link></li> : null;
                })}
              </ul>
            ) : null}
          </section>
          <section aria-label="Priority">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Priority: {BAND[a.priority.band].label}, <span className="num">{a.priority.score}</span> of 100
            </h3>
            {a.priority.score > 0 ? (
              <ul className="list-inside list-disc text-sm text-fg-muted">{a.priority.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            ) : (
              <p className="text-sm text-fg-muted">{a.priority.reasons[0] ?? 'Not active, so it needs no attention.'}</p>
            )}
          </section>
          <section aria-label="History">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">History</h3>
            <ol className="flex flex-col gap-1 border-l border-line pl-3 text-sm">
              {a.history.map((h) => (
                <li key={h.id}>
                  <span className="font-medium">{ACTION_LABEL[h.action]}</span>
                  <span className="text-fg-muted"> · {h.automatic ? 'by the checks' : h.by} · {dateTime(h.at)}</span>
                  {h.note ? <span className="block text-fg-muted">{h.note}</span> : null}
                </li>
              ))}
            </ol>
          </section>
          {canManage ? (
            mode ? (
              <form className="flex flex-col gap-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); if (!reasonShort) act.mutate(mode); }}>
                <ErrorAlert title="Not saved" error={act.error} />
                <Field
                  label={mode === 'dismiss' ? 'Why is this not a problem?' : 'Note (optional)'}
                  hint={mode === 'dismiss' ? 'A dismissed alert stays dismissed even if the checks find it again. The reason is kept in the history and the audit trail.' : undefined}
                  error={mode === 'dismiss' && note && reasonShort ? 'At least 3 characters' : undefined}
                >
                  {(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />}
                </Field>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => { setMode(null); setNote(''); act.reset(); }}>Cancel</Button>
                  <Button type="submit" variant={mode === 'dismiss' ? 'danger' : 'primary'} disabled={reasonShort} loading={act.isPending}>
                    {mode === 'acknowledge' ? 'Acknowledge' : mode === 'dismiss' ? 'Dismiss alert' : 'Reopen'}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
                {a.status === 'OPEN' ? <Button variant="secondary" onClick={() => setMode('acknowledge')}>Acknowledge</Button> : null}
                {a.status === 'OPEN' || a.status === 'ACKNOWLEDGED' ? <Button variant="ghost" onClick={() => setMode('dismiss')}>Dismiss…</Button> : null}
                {a.status === 'DISMISSED' ? <Button variant="secondary" onClick={() => setMode('reopen')}>Reopen</Button> : null}
                {a.status === 'CLEARED' ? <p className="text-sm text-fg-muted">The checks no longer find this. It comes back by itself if they do.</p> : null}
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
