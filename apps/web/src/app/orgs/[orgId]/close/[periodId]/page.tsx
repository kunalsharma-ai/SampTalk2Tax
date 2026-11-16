'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Stat, Table, Td, Textarea, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AiNoticeAlert } from '@/components/ai/ai-notice';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { ADJUSTMENT_STATUS, CLOSE_STATUS, type CloseAdjustmentView, type CloseView } from '@/lib/close';
import { CONFIDENCE, dateTime } from '@/lib/collections';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function ClosePage() {
  const { org, orgId } = useOrg();
  const { periodId } = useParams<{ periodId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/close/${periodId}`;
  const key = ['close', orgId, periodId];
  const q = useQuery({ queryKey: key, queryFn: () => api<CloseView>(base), refetchInterval: (s) => (s.state.data?.review?.status === 'RUNNING' ? 1500 : false) });
  const set = (v: CloseView) => {
    qc.setQueryData(key, v);
    void qc.invalidateQueries({ queryKey: ['close-list', orgId] });
    void qc.invalidateQueries({ queryKey: ['periods', orgId] });
  };
  const start = useMutation({ mutationFn: () => api<CloseView>(`${base}/start`, { method: 'POST' }), onSuccess: set });
  const tasks = useMutation({ mutationFn: () => api<{ created: number; close: CloseView }>(`${base}/tasks`, { method: 'POST' }), onSuccess: (r) => set(r.close) });
  const review = useMutation({ mutationFn: () => api<CloseView>(`${base}/reviews`, { method: 'POST' }), onSuccess: set });
  if (!org) return null;
  const v = q.data;
  const cur = org.functionalCurrency;
  const status = v ? (v.close?.status ?? 'NOT_STARTED') : null;
  const inProgress = status === 'IN_PROGRESS';
  const running = v?.review?.status === 'RUNNING';
  const waiting = v?.adjustments.filter((a) => a.status === 'READY').length ?? 0;
  const latest = v?.review ? v.adjustments.filter((a) => a.reviewId === v.review!.id || a.status !== 'SUPERSEDED') : [];
  return (
    <>
      <div className="mb-2 text-sm">
        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/close`}>← Month-end close</Link>
      </div>
      <PageHeader
        title={v ? `${v.period.name} close` : 'Month-end close'}
        description={v ? `${date(v.period.startDate)} to ${date(v.period.endDate)}. The checklist is worked out from the books each time you open this page. Nothing the AI proposes is posted until a person approves it.` : undefined}
        actions={v && !v.close && v.can.manage ? <Button loading={start.isPending} onClick={() => start.mutate()}>Start close</Button> : null}
      />
      <ErrorAlert title="Could not load this month" error={q.error} />
      <ErrorAlert title="Did not start" error={start.error} />
      {v ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Close" value={<Badge tone={CLOSE_STATUS[status!].tone}>{CLOSE_STATUS[status!].label}</Badge>} sub={v.close ? `Started by ${v.close.startedBy}` : 'Not started yet'} />
            <Stat label="Blocking checks open" value={v.readiness.blocking} tone={v.readiness.blocking ? 'negative' : 'positive'} sub="Must pass to close" />
            <Stat label="Warnings open" value={v.readiness.warnings} tone={v.readiness.warnings ? 'warning' : 'neutral'} sub="Need a note to close" />
            <Stat label="Entries to review" value={waiting} tone={waiting ? 'warning' : 'neutral'} sub="Proposed by the AI" />
          </div>

          <Card className="mb-4">
            <CardHeader
              title="Checklist"
              description={status === 'CLOSED' ? 'As it stood when the month was closed.' : 'Blocking checks must pass before the month can close. Warnings can be accepted with a note.'}
              actions={inProgress && v.can.manage ? <Button variant="secondary" size="sm" loading={tasks.isPending} onClick={() => tasks.mutate()}>Create tasks for open checks</Button> : null}
            />
            <ErrorAlert title="Tasks not created" error={tasks.error} />
            {tasks.data ? <p className="px-5 pb-2 text-sm text-fg-muted" role="status">{tasks.data.created ? `${tasks.data.created} task${tasks.data.created === 1 ? '' : 's'} created for accountants.` : 'Every open check already has an open task.'}</p> : null}
            <ul className="divide-y divide-line" aria-label="Checklist">
              {v.checks.map((c) => (
                <li key={c.key} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:gap-4" aria-label={`${c.label}: ${c.ok ? 'passed' : 'open'}`}>
                  <span aria-hidden className={cn('mt-0.5 w-4 shrink-0 text-sm font-semibold', c.ok ? 'text-positive' : c.severity === 'BLOCKING' ? 'text-negative' : 'text-warning')}>{c.ok ? '✓' : c.severity === 'BLOCKING' ? '✕' : '!'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {c.label}
                      {!c.ok ? <Badge className="ml-2" tone={c.severity === 'BLOCKING' ? 'negative' : 'warning'}>{c.severity === 'BLOCKING' ? 'Blocking' : 'Warning'}</Badge> : null}
                    </p>
                    <p className="text-sm text-fg-muted">{c.detail}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-sm">
                    {c.task ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/tasks`}>{c.task.status === 'OPEN' ? 'Task open' : c.task.status === 'DONE' ? 'Task done' : 'Task cancelled'}</Link> : null}
                    {!c.ok && c.link && status !== 'CLOSED' ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${c.link}`}>Open</Link> : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="mb-4">
            <CardHeader
              title="AI review"
              description="The AI model is shown the checklist and how every account moved this month against the three months before. It points out what looks unusual and proposes adjusting entries, such as accruals for regular costs not yet billed. It never posts anything."
              actions={inProgress && v.can.manage && v.ai.configured && v.ai.enabled && v.period.status === 'OPEN' ? <Button size="sm" loading={review.isPending || running} disabled={running} onClick={() => review.mutate()}>{running ? 'Reviewing…' : v.review ? 'Review again' : 'Review with AI'}</Button> : null}
            />
            <div className="px-5 pb-5">
              <ErrorAlert title="Review did not start" error={review.error} />
              {!v.ai.configured ? (
                <Alert tone="warning" title="AI is not set up on this server">
                  An administrator needs to set <code className="font-mono">ANTHROPIC_API_KEY</code> for the API and restart it. The checklist, tasks and closing work without it.
                </Alert>
              ) : v.ai.notice ? (
                <AiNoticeAlert notice={v.ai.notice} orgId={orgId} canChange={v.ai.canChangeAi} />
              ) : !v.ai.enabled ? (
                <Alert tone="warning" title={`AI is off for ${org.name}`}>
                  A review sends account codes, names and monthly totals, and the checklist, to the AI model ({v.ai.model}).{' '}
                  {v.ai.canChangeAi ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/copilot`}>Turn AI on on the Copilot page.</Link> : 'An owner or admin can turn it on on the Copilot page.'}
                </Alert>
              ) : null}
              {v.review ? (
                <div className="mt-2 flex flex-col gap-3">
                  <p className="text-xs text-fg-muted" role="status">
                    {running ? 'Reviewing since' : 'Reviewed'} {dateTime(running ? v.review.createdAt : v.review.finishedAt ?? v.review.createdAt)} · started by {v.review.startedBy} · {v.review.model}
                    {v.review.inputTokens !== null ? ` · ${v.review.inputTokens.toLocaleString('en-IN')} tokens in, ${(v.review.outputTokens ?? 0).toLocaleString('en-IN')} out` : ''} · shown {v.review.shown.accounts} accounts
                  </p>
                  {v.review.status === 'FAILED' ? <p className="text-sm text-negative">{v.review.errorMessage}</p> : null}
                  {v.review.summary ? <p className="text-sm">{v.review.summary}</p> : null}
                  {v.review.findings.length ? (
                    <ul className="flex flex-col gap-1.5" aria-label="What the AI noticed">
                      {v.review.findings.map((f, i) => (
                        <li key={i} className="text-sm">
                          <span className="font-medium">{f.title}.</span> <span className="text-fg-muted">{f.detail}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : v.ai.configured && v.ai.enabled ? (
                <p className="text-sm text-fg-muted">{inProgress ? 'No review yet.' : v.close ? 'No review was run.' : 'Start the close to have the AI review the month.'}</p>
              ) : null}
            </div>
          </Card>

          {latest.length ? (
            <section className="mb-4">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">Proposed adjusting entries</h2>
              <ul className="flex flex-col gap-3" aria-label="Proposed adjusting entries">
                {latest.map((a) => <AdjustmentCard key={a.id} a={a} v={v} currency={cur} onDone={set} />)}
              </ul>
            </section>
          ) : null}

          {inProgress ? <CloseCard v={v} base={base} onDone={set} /> : null}
          {v.certifications.length ? <Certifications v={v} base={base} currency={cur} onDone={set} /> : null}
        </>
      ) : null}
    </>
  );
}

function AdjustmentCard({ a, v, currency, onDone }: { a: CloseAdjustmentView; v: CloseView; currency: string; onDone: (v: CloseView) => void }) {
  const { orgId } = useOrg();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const path = `/v1/orgs/${orgId}/close/adjustments/${a.id}`;
  const post = useMutation({ mutationFn: () => api<CloseView>(`${path}/post`, { method: 'POST' }), onSuccess: onDone });
  const reject = useMutation({ mutationFn: () => api<CloseView>(`${path}/reject`, { method: 'POST', body: { note: note.trim() || null } }), onSuccess: (r) => { setRejecting(false); onDone(r); } });
  const st = ADJUSTMENT_STATUS[a.status];
  const lines = a.resolved?.lines ?? a.proposedLines.map((l) => ({ accountCode: l.accountCode, accountName: '', debit: l.debit ?? '', credit: l.credit ?? '', description: l.description ?? '' }));
  return (
    <li>
      <Card className="p-4" aria-label={`${a.description}: ${st.label}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-6">
          <div className="min-w-0 lg:w-[38%]">
            <p className="text-sm font-medium">{a.description}</p>
            <p className="mt-0.5 text-xs text-fg-muted">
              Dated {date(v.period.endDate)}
              {a.reverseNextPeriod ? ` · reverses ${a.resolved?.reverseOn ? `on ${date(a.resolved.reverseOn)}` : 'next month'}` : ''}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone={st.tone}>{st.label}</Badge>
              <Badge tone={CONFIDENCE[a.confidence].tone}>{CONFIDENCE[a.confidence].label}</Badge>
            </div>
            <p className="mt-2 text-sm text-fg-muted"><span className="text-fg-faint">Why: </span>{a.reason}</p>
          </div>
          <div className="min-w-0 flex-1">
            <Table aria-label={`Lines of ${a.description}`}>
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th numeric>Debit</Th>
                  <Th numeric>Credit</Th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <Tr key={i}>
                    <Td className="text-sm">{l.accountCode} {l.accountName}</Td>
                    <Td numeric>{l.debit && Number(l.debit) > 0 ? <Money value={l.debit} currency={currency} /> : null}</Td>
                    <Td numeric>{l.credit && Number(l.credit) > 0 ? <Money value={l.credit} currency={currency} /> : null}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <ul className="mt-2 flex flex-col gap-0.5 text-xs" aria-label="Checks">
              {a.checks.map((c) => (
                <li key={c.label} className={cn('flex gap-1.5', c.ok ? 'text-fg-muted' : 'text-negative')}>
                  <span aria-hidden>{c.ok ? '✓' : '✕'}</span>
                  {c.label}
                </li>
              ))}
            </ul>
            {a.decidedBy ? (
              <p className="mt-2 text-sm">
                {a.status === 'POSTED' ? 'Posted' : 'Rejected'} by {a.decidedBy} on {dateTime(a.decidedAt!)}
                {a.journal ? (
                  <>
                    {' · '}
                    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${a.journal.id}`}>Journal #{a.journal.number}</Link>
                  </>
                ) : null}
                {a.reversal ? (
                  <>
                    {', reversed by '}
                    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${a.reversal.id}`}>#{a.reversal.number}</Link>
                  </>
                ) : null}
                {a.decisionNote ? <span className="text-fg-muted"> · {a.decisionNote}</span> : null}
              </p>
            ) : a.status === 'SUPERSEDED' ? (
              <p className="mt-2 text-sm text-fg-muted">Not decided before a later review or the close; nothing was posted.</p>
            ) : null}
            {v.can.manage && a.status === 'READY' && v.close?.status === 'IN_PROGRESS' ? (
              <div className="mt-3 border-t border-line pt-3">
                <ErrorAlert title="Not posted" error={post.error} />
                <ErrorAlert title="Not rejected" error={reject.error} />
                {rejecting ? (
                  <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); reject.mutate(); }}>
                    <Field label="Why not? (optional)">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />}</Field>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setRejecting(false)}>Cancel</Button>
                      <Button type="submit" variant="danger" size="sm" loading={reject.isPending}>Reject entry</Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {!v.can.post && a.canPost ? <span className="text-xs text-fg-faint">Posting needs permission to post journals.</span> : null}
                    <Button variant="ghost" size="sm" onClick={() => setRejecting(true)}>Reject…</Button>
                    {a.canPost && v.can.post ? <Button size="sm" loading={post.isPending} onClick={() => post.mutate()}>{a.reverseNextPeriod ? 'Post with reversal' : 'Post entry'}</Button> : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </Card>
    </li>
  );
}

function CloseCard({ v, base, onDone }: { v: CloseView; base: string; onDone: (v: CloseView) => void }) {
  const [note, setNote] = useState('');
  const close = useMutation({ mutationFn: () => api<CloseView>(`${base}/close`, { method: 'POST', body: { note: note.trim() || null } }), onSuccess: onDone });
  const blocked = v.readiness.blocking > 0;
  const needNote = v.readiness.noteRequired && note.trim().length < 10;
  return (
    <Card className="mb-4">
      <CardHeader title={`Close ${v.period.name}`} description="Closing works the checklist out again, locks the month so nothing more can be posted into it, and records a certification with the figures as they stand. Proposed entries not yet decided are set aside." />
      <div className="px-5 pb-5">
        {v.can.close ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); close.mutate(); }}>
            <ErrorAlert title="Not closed" error={close.error} />
            {blocked ? <Alert tone="warning" title="Not ready to close">{v.readiness.blocking} blocking check{v.readiness.blocking === 1 ? '' : 's'} still open. Deal with {v.readiness.blocking === 1 ? 'it' : 'them'} first.</Alert> : null}
            <Field label={v.readiness.noteRequired ? `Why closing with ${v.readiness.warnings} warning${v.readiness.warnings === 1 ? '' : 's'} open is acceptable` : 'Note for the certification (optional)'}>
              {(p) => <Textarea {...p} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={close.isPending} disabled={blocked || needNote}>Close and lock {v.period.name}</Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-fg-muted">An owner or admin closes the month once the checklist is done.</p>
        )}
      </div>
    </Card>
  );
}

function Certifications({ v, base, currency, onDone }: { v: CloseView; base: string; currency: string; onDone: (v: CloseView) => void }) {
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const reopen = useMutation({ mutationFn: () => api<CloseView>(`${base}/reopen`, { method: 'POST', body: { reason } }), onSuccess: (r) => { setReopening(false); setReason(''); onDone(r); } });
  return (
    <section aria-label="Certifications">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">Certifications</h2>
      <div className="flex flex-col gap-3">
        {v.certifications.map((c) => (
          <Card key={c.id} className="p-4" aria-label={`Closed by ${c.certifiedBy}`}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Closed by {c.certifiedBy} on {dateTime(c.certifiedAt)}</p>
              {c.reopenedAt ? <Badge tone="neutral">Reopened</Badge> : <Badge tone="positive">In force</Badge>}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
              {[
                ['Revenue in the month', c.totals.revenue],
                ['Expenses in the month', c.totals.expenses],
                ['Net profit in the month', c.totals.netProfit],
                ['Trial balance (each side)', c.totals.trialBalanceDebit],
                ['Assets at month end', c.totals.assets],
                ['Liabilities at month end', c.totals.liabilities],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-fg-faint">{label}</dt>
                  <dd className="num"><Money value={value} currency={currency} signed /></dd>
                </div>
              ))}
              <div>
                <dt className="text-xs text-fg-faint">Journals posted in the month</dt>
                <dd className="num">{c.totals.journalsPosted}</dd>
              </div>
            </dl>
            {c.warningsAccepted.length ? <p className="mt-3 text-sm text-fg-muted">Closed with open: {c.warningsAccepted.join('; ')}.</p> : null}
            {c.note ? <p className="mt-1 text-sm"><span className="text-fg-faint">Note: </span>{c.note}</p> : null}
            {c.reopenedAt ? <p className="mt-2 text-sm">Reopened by {c.reopenedBy} on {dateTime(c.reopenedAt)}: <span className="text-fg-muted">{c.reopenReason}</span></p> : null}
            {!c.reopenedAt && v.close?.status === 'CLOSED' && v.can.close ? (
              <div className="mt-3 border-t border-line pt-3">
                <ErrorAlert title="Not reopened" error={reopen.error} />
                {reopening ? (
                  <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); reopen.mutate(); }}>
                    <Field label="Why reopen this month?">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}</Field>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setReopening(false)}>Cancel</Button>
                      <Button type="submit" variant="danger" size="sm" loading={reopen.isPending} disabled={reason.trim().length < 10}>Reopen month</Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setReopening(true)}>Reopen…</Button>
                  </div>
                )}
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </section>
  );
}
