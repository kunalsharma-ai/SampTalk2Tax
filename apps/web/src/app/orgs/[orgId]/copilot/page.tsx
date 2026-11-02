'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Markdown } from '@/components/copilot/markdown';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { CopilotConversation, CopilotConversationSummary, CopilotMessage, CopilotStatus, STARTERS, when } from '@/lib/copilot';
import { useOrg } from '@/lib/org';

const MAX_CHARS = 4000;

export default function CopilotPage() {
  return (
    <Suspense>
      <Copilot />
    </Suspense>
  );
}

function Copilot() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const selected = params.get('c');
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const base = `/v1/orgs/${orgId}/copilot`;

  const status = useQuery({ queryKey: ['copilot-status', orgId], queryFn: () => api<CopilotStatus>(`${base}/status`) });
  const list = useQuery({ queryKey: ['copilot-conversations', orgId], queryFn: () => api<CopilotConversationSummary[]>(`${base}/conversations`) });
  const conv = useQuery({
    queryKey: ['copilot-conversation', orgId, selected],
    queryFn: () => api<CopilotConversation>(`${base}/conversations/${selected}`),
    enabled: !!selected,
    // Read again while an answer is being worked on.
    refetchInterval: (q) => (q.state.data?.messages.some((m) => m.status === 'PENDING') ? 1500 : false),
  });
  const pending = !!conv.data?.messages.some((m) => m.status === 'PENDING');
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) void qc.invalidateQueries({ queryKey: ['copilot-conversations', orgId] });
    wasPending.current = pending;
  }, [pending, qc, orgId]);

  const open = (id: string | null) => router.replace(`/orgs/${orgId}/copilot${id ? `?c=${id}` : ''}`, { scroll: false });

  const ask = useMutation({
    mutationFn: (question: string) =>
      selected && !conv.data?.closed
        ? api<CopilotConversation>(`${base}/conversations/${selected}/messages`, { method: 'POST', body: { question } })
        : api<CopilotConversation>(`${base}/conversations`, { method: 'POST', body: { question } }),
    onSuccess: (c) => {
      setDraft('');
      qc.setQueryData(['copilot-conversation', orgId, c.id], c);
      void qc.invalidateQueries({ queryKey: ['copilot-conversations', orgId] });
      if (c.id !== selected) open(c.id);
    },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api<CopilotStatus>(`${base}/settings`, { method: 'PUT', body: { enabled } }),
    onSuccess: (s) => qc.setQueryData(['copilot-status', orgId], s),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`${base}/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(false);
      void qc.invalidateQueries({ queryKey: ['copilot-conversations', orgId] });
      open(null);
    },
  });

  if (!org) return null;
  const s = status.data;
  const usable = !!s?.configured && !!s?.enabled;
  const tooLong = draft.trim().length > MAX_CHARS;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = draft.trim();
    if (q && !tooLong && usable && !pending) ask.mutate(q);
  };
  const retry = (m: CopilotMessage) => {
    const question = conv.data?.messages.find((x) => x.seq === m.seq - 1)?.text ?? '';
    setDraft(question);
    box.current?.focus();
  };

  return (
    <>
      <PageHeader
        title="Copilot"
        description="Ask questions about your books in plain language. The copilot reads your posted records (reports, KPIs, cash flow, budgets, alerts, compliance) and shows which ones each answer came from. It cannot change anything."
        actions={
          s?.configured && s.enabled && s.canChange ? (
            <Button variant="ghost" size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(false)}>
              Turn off for the organisation
            </Button>
          ) : null
        }
      />
      <ErrorAlert title="Could not load the copilot" error={status.error} />
      <ErrorAlert title="Could not change the setting" error={toggle.error} />
      {s && !s.configured ? (
        <div className="mb-6">
          <Alert tone="warning" title="The AI copilot is not set up">
            This server has no AI provider key. An administrator needs to set <code className="font-mono">ANTHROPIC_API_KEY</code> for the API and restart it. Until then nothing is sent to any AI provider, and no answers can be given. Your earlier conversations stay readable.
          </Alert>
        </div>
      ) : null}
      {s?.configured && !s.enabled ? (
        <Card className="mb-6 p-5" aria-label="Turn on the copilot">
          <h2 className="text-sm font-semibold">The copilot is off for {org.name}</h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">
            When it is on, each question and the figures the copilot reads to answer it (report totals, customer and vendor names, amounts) are sent to {s.provider}&rsquo;s {s.model} model. Questions are kept in your own conversation history, which other members cannot see. Each member can ask up to {s.questionsPerHour} questions an hour.
          </p>
          {s.changedAt ? <p className="mt-2 text-xs text-fg-faint">Turned off by {s.changedBy} on {when(s.changedAt)}</p> : null}
          <div className="mt-4">
            {s.canChange ? (
              <Button loading={toggle.isPending} onClick={() => toggle.mutate(true)}>
                Turn on the copilot
              </Button>
            ) : (
              <p className="text-sm text-fg-muted">An owner or admin can turn it on.</p>
            )}
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside aria-label="Conversations" className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => open(null)} disabled={!selected}>
            New conversation
          </Button>
          <ErrorAlert title="Could not load conversations" error={list.error} />
          <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
            {list.data?.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => open(c.id)}
                  aria-current={c.id === selected ? 'page' : undefined}
                  className={`w-full rounded-[var(--t2t-radius-md)] px-3 py-2 text-left text-sm hover:bg-surface-hover ${c.id === selected ? 'bg-surface-hover font-medium' : ''}`}
                >
                  <span className="line-clamp-2">{c.title}</span>
                  <span className="mt-0.5 block text-xs text-fg-faint">
                    {when(c.updatedAt)} · {c.questions} {c.questions === 1 ? 'question' : 'questions'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {list.data && !list.data.length ? <p className="px-1 text-xs text-fg-faint">Your conversations appear here. Only you can see them.</p> : null}
        </aside>

        <Card className="flex min-h-[60vh] flex-col p-0" aria-label="Conversation">
          {selected && conv.data ? (
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">{conv.data.title}</h2>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            </div>
          ) : null}
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4" aria-live="polite">
            <ErrorAlert title="Could not load the conversation" error={conv.error} />
            {!selected ? (
              <EmptyState title="Ask about your books">
                <p className="mb-3">For example:</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {STARTERS.map((q) => (
                    <button key={q} type="button" disabled={!usable} onClick={() => setDraft(q)} className="rounded-full border border-line px-3 py-1 text-xs text-fg hover:bg-surface-hover disabled:opacity-50">
                      {q}
                    </button>
                  ))}
                </div>
              </EmptyState>
            ) : null}
            {conv.data?.messages.map((m) => (m.role === 'USER' ? <Question key={m.id} m={m} /> : <Answer key={m.id} m={m} orgId={orgId} onRetry={() => retry(m)} canRetry={usable && !pending && !conv.data.closed} />))}
          </div>
          <form onSubmit={submit} className="border-t border-line px-5 py-4">
            {conv.data?.closed ? (
              <p className="mb-2 text-xs text-fg-muted">This conversation was started with an earlier version of the copilot. Your next question starts a new conversation.</p>
            ) : null}
            <ErrorAlert title="The question was not sent" error={ask.error} />
            <label htmlFor="copilot-question" className="sr-only">
              Your question
            </label>
            <Textarea
              id="copilot-question"
              ref={box}
              rows={3}
              value={draft}
              disabled={!usable}
              placeholder={usable ? 'Ask about revenue, margins, cash, customers, budgets, alerts or filings…' : 'The copilot is not available'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) submit(e as unknown as FormEvent);
              }}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className={`text-xs ${tooLong ? 'text-negative' : 'text-fg-faint'}`}>
                {tooLong ? `Keep a question under ${MAX_CHARS} characters` : 'Enter to send, Shift+Enter for a new line. Answers can be wrong: check the figures in the linked reports before relying on them.'}
              </span>
              <Button type="submit" disabled={!usable || !draft.trim() || tooLong || pending} loading={ask.isPending}>
                Ask
              </Button>
            </div>
          </form>
        </Card>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete this conversation?" description="The questions and answers are removed for good. The audit trail keeps a record that a conversation was deleted.">
        <ErrorAlert title="Not deleted" error={remove.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => selected && remove.mutate(selected)}>
            Delete conversation
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function Question({ m }: { m: CopilotMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-[var(--t2t-radius-lg)] bg-surface-hover px-4 py-2 text-sm" role="group" aria-label="Question">
        {m.text}
        <div className="mt-1 text-right text-[11px] text-fg-faint">{when(m.createdAt)}</div>
      </div>
    </div>
  );
}

const FAILED_TITLE: Record<string, string> = { REFUSED: 'No answer', INCOMPLETE: 'The answer is incomplete', FAILED: 'The answer failed' };

function Answer({ m, orgId, onRetry, canRetry }: { m: CopilotMessage; orgId: string; onRetry: () => void; canRetry: boolean }) {
  return (
    <section className="max-w-[95%]" aria-label="Copilot answer">
      {m.status === 'PENDING' ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-[var(--t2t-accent)]" aria-hidden />
          Working on the answer{m.sources.length ? ` · looked at ${m.sources.length} ${m.sources.length === 1 ? 'report' : 'reports'} so far` : '…'}
        </p>
      ) : null}
      {m.text ? <Markdown text={m.text} /> : null}
      {m.status !== 'PENDING' && m.status !== 'COMPLETE' ? (
        <div className="mt-2">
          <Alert tone={m.status === 'FAILED' ? 'negative' : 'warning'} title={FAILED_TITLE[m.status]}>
            {m.errorMessage}
            {canRetry ? (
              <div className="mt-2">
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  Ask again
                </Button>
              </div>
            ) : null}
          </Alert>
        </div>
      ) : null}
      {m.sources.length ? (
        <div className="mt-3" role="region" aria-label="Looked at">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Looked at</h3>
          <ul className="mt-1 flex flex-wrap gap-2">
            {m.sources.map((src, i) => (
              <li key={i}>
                {src.ok ? (
                  <Link href={`/orgs/${orgId}${src.path}`} className="inline-flex rounded-full border border-line px-2.5 py-0.5 text-xs text-accent hover:bg-surface-hover">
                    {src.label}
                  </Link>
                ) : (
                  <span className="inline-flex rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-muted" title={src.error}>
                    {src.label}: could not be read
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {m.status === 'COMPLETE' ? (
        <p className="mt-2 text-[11px] text-fg-faint">
          {when(m.completedAt ?? m.createdAt)} · {m.servedModel}
          {m.usage ? ` · ${m.usage.inputTokens.toLocaleString('en-IN')} tokens in, ${m.usage.outputTokens.toLocaleString('en-IN')} out` : ''}
          {m.sources.length === 0 ? (
            <>
              {' · '}
              <Badge tone="warning">Not based on your reports</Badge>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
