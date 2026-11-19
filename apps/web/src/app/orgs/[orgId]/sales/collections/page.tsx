'use client';
import { IntegrationsLink } from '@/components/integrations-link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Stat, Table, Td, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { AiNoticeAlert } from '@/components/ai/ai-notice';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime, RISK, STATUS, type CollectionsOverview, type Reminder, type ReminderStatus } from '@/lib/collections';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function CollectionsPage() {
  return (
    <Suspense>
      <Collections />
    </Suspense>
  );
}

const VIEWS: { key: string; label: string; statuses: ReminderStatus[] | null }[] = [
  { key: 'review', label: 'To review', statuses: ['READY', 'SEND_FAILED', 'DRAFTING'] },
  { key: 'sent', label: 'Sent', statuses: ['SENT'] },
  { key: 'closed', label: 'Rejected or failed', statuses: ['REJECTED', 'FAILED'] },
  { key: 'all', label: 'All', statuses: null },
];

function Collections() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const view = VIEWS.find((v) => v.key === params.get('view')) ?? VIEWS[0];
  const base = `/v1/orgs/${orgId}/collections`;
  const overview = useQuery({
    queryKey: ['collections', orgId],
    queryFn: () => api<CollectionsOverview>(base),
    refetchInterval: (q) => (q.state.data?.latestRun?.status === 'RUNNING' ? 1500 : false),
  });
  const running = overview.data?.latestRun?.status === 'RUNNING';
  const list = useQuery({ queryKey: ['reminders', orgId], queryFn: () => api<Reminder[]>(`${base}/reminders`), refetchInterval: running ? 1500 : false });
  // When a run finishes, read the reminders once more so the last drafts show as written.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: ['reminders', orgId] });
    wasRunning.current = running;
  }, [running, qc, orgId]);
  const start = useMutation({
    mutationFn: () => api<CollectionsOverview>(`${base}/runs`, { method: 'POST' }),
    onSuccess: (o) => {
      qc.setQueryData(['collections', orgId], o);
      void qc.invalidateQueries({ queryKey: ['reminders', orgId] });
    },
  });
  if (!org) return null;
  const o = overview.data;
  const canManage = can(org.role, 'collections.manage');
  const shown = (list.data ?? []).filter((r) => !view.statuses || view.statuses.includes(r.status));
  const usable = !!o?.aiConfigured && !!o.aiEnabled;
  const count = (s: ReminderStatus[]) => s.reduce((n, k) => n + (o?.counts[k] ?? 0), 0);
  return (
    <>
      <PageHeader
        title="Collections"
        description={
          <>
            The AI model drafts one payment reminder per customer with overdue invoices, from the books, and says how likely the customer is to pay. Every amount and invoice number in a draft is checked against the books. Nothing is sent until a person reads the reminder and sends it.
          </>
        }
        actions={canManage && usable ? <Button loading={start.isPending || running} disabled={running} onClick={() => start.mutate()}>{running ? 'Drafting reminders…' : 'Draft reminders'}</Button> : null}
      />
      <ErrorAlert title="Could not load collections" error={overview.error ?? list.error} />
      <ErrorAlert title="Drafting did not start" error={start.error} />
      {o && !o.aiConfigured ? (
        <div className="mb-4">
          <Alert tone="warning" title="AI is not set up yet">
            An owner or admin can add a Claude API key in <IntegrationsLink />. Until then no reminders can be drafted, and nothing is sent to any AI provider. Reminders drafted earlier stay here.
          </Alert>
        </div>
      ) : null}
      {o ? <AiNoticeAlert notice={o.aiNotice} orgId={orgId} canChange={o.canChangeAi} /> : null}
      {o?.aiConfigured && !o.aiEnabled && !o.aiNotice ? (
        <div className="mb-4">
          <Alert tone="warning" title={`AI is off for ${org.name}`}>
            Drafting sends each customer&rsquo;s name, overdue invoices and payment history to the AI model ({o.model}).{' '}
            {o.canChangeAi ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/copilot`}>Turn AI on on the Copilot page.</Link> : 'An owner or admin can turn it on on the Copilot page.'}
          </Alert>
        </div>
      ) : null}
      {o && !o.emailReady ? (
        <div className="mb-4">
          <Alert tone="warning" title="Email is not set up yet">
            Reminders can be drafted and reviewed, but not sent until an owner or admin adds your mail server in <IntegrationsLink />.
          </Alert>
        </div>
      ) : null}
      {o ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="To review" value={count(['READY'])} tone={count(['READY']) ? 'warning' : 'neutral'} sub={count(['SEND_FAILED']) ? `${count(['SEND_FAILED'])} not delivered` : 'Waiting for a person'} />
            <Stat label="Sent" value={count(['SENT'])} tone="positive" sub={o.emailFrom ? `From ${o.emailFrom}` : 'Email not set up'} />
            <Stat label="Rejected" value={count(['REJECTED'])} sub="Never sent" />
            <Stat label="Drafts that failed" value={count(['FAILED'])} tone={count(['FAILED']) ? 'negative' : 'neutral'} sub={`${o.model}`} />
          </div>
          {o.latestRun ? <RunLine run={o.latestRun} limits={o.limits} /> : null}
          <div role="tablist" aria-label="Reminders by state" className="mb-3 flex w-fit flex-wrap gap-1 rounded-[var(--t2t-radius-md)] border border-line bg-surface p-1">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                role="tab"
                type="button"
                aria-selected={view.key === v.key}
                onClick={() => router.replace(`/orgs/${orgId}/sales/collections${v.key === 'review' ? '' : `?view=${v.key}`}`, { scroll: false })}
                className={cn('rounded px-3 py-1.5 text-sm transition-colors', view.key === v.key ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-surface-hover hover:text-fg')}
              >
                {v.label}
              </button>
            ))}
          </div>
          {shown.length ? (
            <ul className="flex flex-col gap-2" aria-label="Reminders">
              {shown.map((r) => <ReminderRow key={r.id} r={r} href={`/orgs/${orgId}/sales/collections/${r.id}`} />)}
            </ul>
          ) : (
            <Card>
              <EmptyState title={view.key === 'review' ? 'Nothing to review' : 'No reminders here'}>
                {view.key === 'review' ? (usable ? 'Draft reminders to have the AI write one for each customer with overdue invoices.' : 'Reminders appear here once AI is set up and turned on.') : 'Reminders move here when they are sent, rejected or could not be drafted.'}
              </EmptyState>
            </Card>
          )}
          {canManage ? <ReminderResults base={base} /> : null}
        </>
      ) : null}
    </>
  );
}

function RunLine({ run, limits }: { run: NonNullable<CollectionsOverview['latestRun']>; limits: CollectionsOverview['limits'] }) {
  return (
    <div className="mb-4 flex flex-col gap-2">
      <p className="text-sm text-fg-muted" role="status">
        {run.status === 'RUNNING' ? 'Drafting' : 'Last drafted'} {dateTime(run.createdAt)} by {run.startedBy} · {run.drafts} reminder{run.drafts === 1 ? '' : 's'}
        {run.skipped.length ? ` · ${run.skipped.length} customer${run.skipped.length === 1 ? '' : 's'} left out` : ''}
      </p>
      {run.skipped.length ? (
        <details className="rounded-[var(--t2t-radius-md)] border border-line bg-surface px-4 py-2 text-sm">
          <summary className="cursor-pointer text-fg-muted">Customers left out of this run</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {run.skipped.map((s) => (
              <li key={s.contactId}>
                <span className="font-medium">{s.name}</span>
                <span className="text-fg-muted">: {s.reason}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-fg-faint">A customer reminded in the last {limits.remindAgainAfterDays} days is left out. Up to {limits.customersPerRun} customers are drafted per run, most overdue first.</p>
        </details>
      ) : null}
    </div>
  );
}

function ReminderRow({ r, href }: { r: Reminder; href: string }) {
  const s = STATUS[r.status];
  const failing = r.status === 'READY' && r.checks.some((c) => !c.ok);
  return (
    <li>
      <Link
        href={href}
        aria-label={`${r.customer}: ${s.label}`}
        className="flex w-full flex-col gap-1 rounded-[var(--t2t-radius-md)] border border-line bg-surface px-4 py-3 transition hover:border-line-strong hover:bg-surface-hover sm:flex-row sm:items-center sm:gap-4"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{r.customer}</span>
            <Badge tone={s.tone}>{s.label}</Badge>
            {r.risk ? <Badge tone={RISK[r.risk].tone}>{RISK[r.risk].label}</Badge> : null}
            {failing ? <Badge tone="negative">Fails a check</Badge> : null}
            {r.edited ? <span className="text-xs text-fg-faint">edited</span> : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-fg-muted">
            {r.status === 'DRAFTING' ? 'The AI model is writing this reminder…' : r.status === 'FAILED' ? r.errorMessage : r.subject}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3 text-right sm:flex-col sm:items-end sm:gap-1">
          <span className="num whitespace-nowrap text-sm font-semibold"><Money value={r.facts.totalOverdue} currency={r.facts.currency} /></span>
          <span className="whitespace-nowrap text-xs text-fg-faint">
            {r.facts.overdue.length} overdue · oldest {r.facts.oldestDaysOverdue} days
          </span>
        </span>
      </Link>
    </li>
  );
}

interface ResultsView {
  today: string;
  days: number;
  windowDays: number;
  byCurrency: { currency: string; reminders: number; overdueThen: string; collected: string; collectedShare: string | null; paid: number; partPaid: number; notPaid: number; waiting: number; averageDaysToPay: number | null }[];
  reminders: { id: string; customer: string; sentOn: string; currency: string; overdueThen: string; collected: string; daysToFirstPayment: number | null; outcome: 'PAID' | 'PART_PAID' | 'WAITING' | 'NOT_PAID'; windowEnds: string }[];
}
const OUTCOME: Record<ResultsView['reminders'][number]['outcome'], { label: string; tone: 'positive' | 'warning' | 'neutral' | 'negative' }> = {
  PAID: { label: 'Paid', tone: 'positive' },
  PART_PAID: { label: 'Part paid', tone: 'warning' },
  WAITING: { label: 'Waiting', tone: 'neutral' },
  NOT_PAID: { label: 'Not paid', tone: 'negative' },
};

/** What the reminders sent in the last 90 days achieved, from receipts in the books. */
function ReminderResults({ base }: { base: string }) {
  // Receipts are recorded elsewhere, so read the results again each time the page opens.
  const q = useQuery({ queryKey: ['collections-results', base], queryFn: () => api<ResultsView>(`${base}/results`), refetchOnMount: 'always' });
  const v = q.data;
  return (
    <Card className="mt-6" role="region" aria-label="What reminders achieved">
      <CardHeader
        title="What reminders achieved"
        description={v ? `Reminders sent in the last ${v.days} days, and what each customer paid in the ${v.windowDays} days after, against what was overdue when it went. A payment counts for the latest reminder before it, and only up to what was overdue then.` : 'What customers paid after each reminder.'}
      />
      <ErrorAlert title="Could not load the results" error={q.error} />
      {v ? (
        v.reminders.length ? (
          <>
            {v.byCurrency.map((c) => (
              <div key={c.currency} className="grid grid-cols-2 gap-3 px-5 pt-4 xl:grid-cols-4">
                <Stat label={`Collected after reminders${v.byCurrency.length > 1 ? `, ${c.currency}` : ''}`} value={<Money value={c.collected} currency={c.currency} />} tone="positive" sub={c.collectedShare === null ? 'Nothing was overdue' : `${c.collectedShare}% of the overdue reminded about`} />
                <Stat label="Overdue when reminded" value={<Money value={c.overdueThen} currency={c.currency} />} sub={`${c.reminders} reminder${c.reminders === 1 ? '' : 's'}`} />
                <Stat label="Paid in full" value={`${c.paid} of ${c.reminders}`} sub={`${c.partPaid} part paid, ${c.notPaid} not paid, ${c.waiting} waiting`} />
                <Stat label="Days to first payment" value={c.averageDaysToPay ?? '—'} sub="On average, where something was paid" />
              </div>
            ))}
            <div className="mt-4 overflow-x-auto">
              <Table aria-label="Results by reminder">
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th>Sent</Th>
                    <Th className="text-right">Overdue then</Th>
                    <Th className="text-right">Collected after</Th>
                    <Th className="text-right">First payment</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {v.reminders.map((r) => (
                    <Tr key={r.id}>
                      <Td className="font-medium">{r.customer}</Td>
                      <Td className="whitespace-nowrap text-sm">{date(r.sentOn)}</Td>
                      <Td className="text-right"><Money value={r.overdueThen} currency={r.currency} /></Td>
                      <Td className="text-right"><Money value={r.collected} currency={r.currency} /></Td>
                      <Td className="whitespace-nowrap text-right text-sm">{r.daysToFirstPayment === null ? '—' : r.daysToFirstPayment === 0 ? 'Same day' : `After ${r.daysToFirstPayment} day${r.daysToFirstPayment === 1 ? '' : 's'}`}</Td>
                      <Td>
                        <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>
                        {r.outcome === 'WAITING' ? <span className="ml-2 text-xs text-fg-faint">until {date(r.windowEnds)}</span> : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        ) : (
          <EmptyState title="No reminders sent yet">Once reminders are sent, what each customer paid afterwards shows here.</EmptyState>
        )
      ) : null}
    </Card>
  );
}
