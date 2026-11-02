'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, EmptyState, Field, Stat, Textarea, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AiNoticeAlert } from '@/components/ai/ai-notice';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { BANK_AI_STATUS, CONFIDENCE, dateTime, type BankAiOverview, type BankAiStatus, type BankAiSuggestion } from '@/lib/collections';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function Page() {
  return (
    <Suspense>
      <BankAi />
    </Suspense>
  );
}

const VIEWS: { key: string; label: string; statuses: BankAiStatus[] | null }[] = [
  { key: 'review', label: 'To review', statuses: ['READY', 'DRAFTING'] },
  { key: 'accepted', label: 'Accepted', statuses: ['ACCEPTED'] },
  { key: 'closed', label: 'Dismissed or failed', statuses: ['DISMISSED', 'FAILED'] },
  { key: 'all', label: 'All', statuses: null },
];

function BankAi() {
  const { org, orgId } = useOrg();
  const { accountId } = useParams<{ accountId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const focus = params.get('suggestion');
  const view = VIEWS.find((v) => v.key === params.get('view')) ?? (focus ? VIEWS[3] : VIEWS[0]);
  const base = `/v1/orgs/${orgId}/banking/accounts/${accountId}/ai`;
  const overview = useQuery({ queryKey: ['bank-ai', orgId, accountId], queryFn: () => api<BankAiOverview>(base), refetchInterval: (q) => (q.state.data?.latestRun?.status === 'RUNNING' ? 1500 : false) });
  const running = overview.data?.latestRun?.status === 'RUNNING';
  const list = useQuery({ queryKey: ['bank-ai-suggestions', orgId, accountId], queryFn: () => api<BankAiSuggestion[]>(`${base}/suggestions`), refetchInterval: running ? 1500 : false });
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: ['bank-ai-suggestions', orgId, accountId] });
    wasRunning.current = running;
  }, [running, qc, orgId, accountId]);
  const start = useMutation({
    mutationFn: () => api<BankAiOverview>(`${base}/runs`, { method: 'POST' }),
    onSuccess: (o) => {
      qc.setQueryData(['bank-ai', orgId, accountId], o);
      void qc.invalidateQueries({ queryKey: ['bank-ai-suggestions', orgId, accountId] });
    },
  });
  if (!org) return null;
  const o = overview.data;
  const manage = can(org.role, 'banking.manage');
  const usable = !!o?.aiConfigured && !!o.aiEnabled;
  const shown = (list.data ?? []).filter((s) => !view.statuses || view.statuses.includes(s.status));
  const count = (k: BankAiStatus) => o?.counts[k] ?? 0;
  return (
    <>
      <div className="mb-2 text-sm">
        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/banking/${accountId}`}>← {o ? `${o.account.code} · ${o.account.name}` : 'Bank account'}</Link>
      </div>
      <PageHeader
        title="AI suggestions"
        description="For each bank line that is not matched yet, the AI model suggests what it is: ledger lines already in the books, a receipt or payment against open invoices or bills, or an entry to an account, with its reasons. Every suggestion is checked against the books. Nothing is recorded until you accept it, and then exactly as if you had done it by hand."
        actions={manage && usable ? <Button loading={start.isPending || running} disabled={running} onClick={() => start.mutate()}>{running ? 'Looking at lines…' : 'Suggest for unmatched lines'}</Button> : null}
      />
      <ErrorAlert title="Could not load suggestions" error={overview.error ?? list.error} />
      <ErrorAlert title="Did not start" error={start.error} />
      {o && !o.aiConfigured ? (
        <div className="mb-4">
          <Alert tone="warning" title="AI is not set up on this server">
            An administrator needs to set <code className="font-mono">ANTHROPIC_API_KEY</code> for the API and restart it. Until then nothing is sent to any AI provider. Matching by hand works as before.
          </Alert>
        </div>
      ) : null}
      {o ? <AiNoticeAlert notice={o.aiNotice} orgId={orgId} canChange={o.canChangeAi} /> : null}
      {o?.aiConfigured && !o.aiEnabled && !o.aiNotice ? (
        <div className="mb-4">
          <Alert tone="warning" title={`AI is off for ${org.name}`}>
            Suggestions send each bank line&rsquo;s text and amount, nearby ledger lines, open invoices or bills with customer and vendor names, and your chart of accounts to the AI model ({o.model}).{' '}
            {o.canChangeAi ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/copilot`}>Turn AI on on the Copilot page.</Link> : 'An owner or admin can turn it on on the Copilot page.'}
          </Alert>
        </div>
      ) : null}
      {o ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="To review" value={count('READY')} tone={count('READY') ? 'warning' : 'neutral'} sub="Waiting for a person" />
            <Stat label="Accepted" value={count('ACCEPTED')} tone="positive" sub="Recorded as suggested" />
            <Stat label="Dismissed" value={count('DISMISSED')} sub="Nothing recorded" />
            <Stat label="Failed" value={count('FAILED')} tone={count('FAILED') ? 'negative' : 'neutral'} sub={`No answer from ${o.model}`} />
          </div>
          {o.latestRun ? (
            <div className="mb-4 flex flex-col gap-2">
              <p className="text-sm text-fg-muted" role="status">
                {o.latestRun.status === 'RUNNING' ? 'Looking at lines since' : 'Last run'} {dateTime(o.latestRun.createdAt)} by {o.latestRun.startedBy} · {o.latestRun.suggestions} line{o.latestRun.suggestions === 1 ? '' : 's'}
                {o.latestRun.skipped.length ? ` · ${o.latestRun.skipped.length} left out` : ''}
              </p>
              {o.latestRun.skipped.length ? (
                <details className="rounded-[var(--t2t-radius-md)] border border-line bg-surface px-4 py-2 text-sm">
                  <summary className="cursor-pointer text-fg-muted">Lines left out of this run</summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {o.latestRun.skipped.map((s) => (
                      <li key={s.lineId}>
                        <span className="font-medium">{date(s.date)} · {s.description}</span> <span className="num">(<Money value={s.amount} currency={org.functionalCurrency} signed />)</span>
                        <span className="text-fg-muted">: {s.reason}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-fg-faint">Up to {o.limits.linesPerRun} lines per run, oldest first.</p>
                </details>
              ) : null}
            </div>
          ) : null}
          <div role="tablist" aria-label="Suggestions by state" className="mb-3 flex w-fit flex-wrap gap-1 rounded-[var(--t2t-radius-md)] border border-line bg-surface p-1">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                role="tab"
                type="button"
                aria-selected={view.key === v.key}
                onClick={() => router.replace(`/orgs/${orgId}/banking/${accountId}/ai${v.key === 'review' ? '' : `?view=${v.key}`}`, { scroll: false })}
                className={cn('rounded px-3 py-1.5 text-sm transition-colors', view.key === v.key ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-surface-hover hover:text-fg')}
              >
                {v.label}
              </button>
            ))}
          </div>
          {shown.length ? (
            <ul className="flex flex-col gap-3" aria-label="Suggestions">
              {shown.map((s) => <SuggestionCard key={s.id} s={s} currency={org.functionalCurrency} manage={manage} focused={focus === s.id} />)}
            </ul>
          ) : (
            <Card>
              <EmptyState title={view.key === 'review' ? 'Nothing to review' : 'No suggestions here'}>
                {view.key === 'review' ? (usable ? 'Ask for suggestions to have the AI look at the unmatched lines on this account.' : 'Suggestions appear here once AI is set up and turned on.') : 'Suggestions move here when they are accepted, dismissed or could not be made.'}
              </EmptyState>
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}

function What({ s, currency }: { s: BankAiSuggestion; currency: string }) {
  const r = s.resolved;
  if (s.status === 'DRAFTING') return <p className="text-sm text-fg-muted" role="status">The AI model is looking at this line…</p>;
  if (s.status === 'FAILED') return <p className="text-sm text-negative">{s.errorMessage}</p>;
  if (!r && s.action === 'NONE') return <p className="text-sm">The AI model could not tell what this line is.</p>;
  if (!r) return <p className="text-sm">{s.action === 'ENTRY' ? `Post to account ${s.proposal?.accountCode ?? '?'}` : s.action === 'MATCH' ? 'Match to ledger lines' : 'A receipt or payment'}, but it did not pass the checks below.</p>;
  if (r.action === 'NONE') return <p className="text-sm">The AI model could not tell what this line is.</p>;
  if (r.action === 'MATCH')
    return (
      <div className="text-sm">
        <p className="font-medium">Match to {r.ledger.length === 1 ? 'a ledger line' : `${r.ledger.length} ledger lines`} already in the books</p>
        <ul className="mt-1 flex flex-col gap-0.5 text-fg-muted">
          {r.ledger.map((l) => (
            <li key={l.ref}>
              {date(l.date)} · {l.text} · <span className="num"><Money value={l.amount} currency={currency} signed /></span>
            </li>
          ))}
        </ul>
      </div>
    );
  if (r.action === 'PAYMENT')
    return (
      <div className="text-sm">
        <p className="font-medium">
          Record a {s.line.amount.startsWith('-') ? 'payment to' : 'receipt from'} {r.contactName}
        </p>
        <ul className="mt-1 flex flex-col gap-0.5 text-fg-muted">
          {r.allocations.map((a) => (
            <li key={a.documentId}>
              {a.number}: <span className="num"><Money value={a.amount} currency={currency} /></span>
            </li>
          ))}
          {Number(r.unallocated) > 0 ? <li>Left on account: <span className="num"><Money value={r.unallocated} currency={currency} /></span></li> : null}
        </ul>
      </div>
    );
  return (
    <p className="text-sm">
      <span className="font-medium">Post to {r.accountCode} {r.accountName}</span>
      <span className="text-fg-muted"> · &ldquo;{r.description}&rdquo;</span>
    </p>
  );
}

function SuggestionCard({ s, currency, manage, focused }: { s: BankAiSuggestion; currency: string; manage: boolean; focused: boolean }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState('');
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  const path = `/v1/orgs/${orgId}/banking/ai-suggestions/${s.id}`;
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['bank-ai-suggestions', orgId] });
    void qc.invalidateQueries({ queryKey: ['bank-ai', orgId] });
    void qc.invalidateQueries({ queryKey: ['bank-lines', orgId] });
    void qc.invalidateQueries({ queryKey: ['bank-accounts', orgId] });
  };
  const accept = useMutation({ mutationFn: () => api<BankAiSuggestion>(`${path}/accept`, { method: 'POST' }), onSuccess: done });
  const dismiss = useMutation({ mutationFn: () => api<BankAiSuggestion>(`${path}/dismiss`, { method: 'POST', body: { note: note.trim() || null } }), onSuccess: () => { setDismissing(false); done(); } });
  const st = BANK_AI_STATUS[s.status];
  return (
    <li ref={ref}>
      <Card className={cn('p-4', focused && 'ring-2 ring-accent')} aria-label={`${s.line.description}: ${st.label}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-6">
          <div className="min-w-0 lg:w-[34%]">
            <p className="text-xs text-fg-muted">{date(s.line.date)}{s.line.reference ? ` · ${s.line.reference}` : ''}</p>
            <p className="mt-0.5 break-words text-sm font-medium">{s.line.description}</p>
            <p className="num mt-1 text-base font-semibold"><Money value={s.line.amount} currency={currency} signed /></p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone={st.tone}>{st.label}</Badge>
              {s.confidence ? <Badge tone={CONFIDENCE[s.confidence].tone}>{CONFIDENCE[s.confidence].label}</Badge> : null}
              {!s.lineOpen && s.status === 'READY' ? <Badge tone="neutral">Line already dealt with</Badge> : null}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <What s={s} currency={currency} />
            {s.reason ? <p className="mt-2 text-sm text-fg-muted"><span className="text-fg-faint">Why: </span>{s.reason}</p> : null}
            {s.checks.length ? (
              <ul className="mt-2 flex flex-col gap-0.5 text-xs" aria-label="Checks against the books">
                {s.checks.map((c) => (
                  <li key={c.label} className={cn('flex gap-1.5', c.ok ? 'text-fg-muted' : 'text-negative')}>
                    <span aria-hidden>{c.ok ? '✓' : '✕'}</span>
                    {c.label}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-2 text-xs text-fg-faint">
              Shown {s.shown.ledger} ledger lines, {s.shown.documents} open documents, {s.shown.accounts} accounts and {s.shown.history} earlier bookings
              {s.usage ? ` · ${s.usage.inputTokens.toLocaleString('en-IN')} tokens in, ${s.usage.outputTokens.toLocaleString('en-IN')} out` : ''}
            </p>
            {s.decidedBy ? (
              <p className="mt-2 text-sm">
                {s.status === 'ACCEPTED' ? 'Accepted' : 'Dismissed'} by {s.decidedBy} on {dateTime(s.decidedAt!)}
                {s.result?.paymentNumber ? ` · ${s.result.paymentNumber} recorded` : ''}
                {s.result?.entryNumber ? ` · ${s.result.entryNumber} posted` : ''}
                {s.decisionNote ? <span className="text-fg-muted"> · {s.decisionNote}</span> : null}
              </p>
            ) : null}
            {manage && s.status === 'READY' ? (
              <div className="mt-3 border-t border-line pt-3">
                <ErrorAlert title="Not accepted" error={accept.error} />
                <ErrorAlert title="Not dismissed" error={dismiss.error} />
                {dismissing ? (
                  <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); dismiss.mutate(); }}>
                    <Field label="Why not? (optional)">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />}</Field>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setDismissing(false)}>Cancel</Button>
                      <Button type="submit" variant="danger" size="sm" loading={dismiss.isPending}>Dismiss suggestion</Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setDismissing(true)}>Dismiss…</Button>
                    {s.canAccept ? <Button size="sm" loading={accept.isPending} onClick={() => accept.mutate()}>Accept</Button> : null}
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
