'use client';
import { IntegrationsLink } from '@/components/integrations-link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert as Notice, Badge, Button, Card, CardHeader, Dialog, EmptyState, Select, Table, Td, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { ACTION_LABEL, ACTION_STATUS, assigneeLabel, dateTime, describeCondition, emailToLabel, RUN_STATUS, seconds, type Catalogue, type Run, type RunStatus, type Workflow } from '@/lib/workflows';

export default function WorkflowPage() {
  const { org, orgId } = useOrg();
  const { workflowId } = useParams<{ workflowId: string }>();
  const qc = useQueryClient();
  const router = useRouter();
  const base = `/v1/orgs/${orgId}/workflows/${workflowId}`;
  const [filter, setFilter] = useState<RunStatus | ''>('');
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ matched: boolean; run: Run } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const cat = useQuery({ queryKey: ['workflow-catalogue', orgId], queryFn: () => api<Catalogue>(`/v1/orgs/${orgId}/workflows/catalogue`), enabled: !!org });
  const w = useQuery({ queryKey: ['workflow', orgId, workflowId], queryFn: () => api<Workflow>(base), enabled: !!org });
  const runs = useQuery({
    queryKey: ['workflow-runs', orgId, workflowId, filter],
    queryFn: () => api<Run[]>(`${base}/runs${filter ? `?status=${filter}` : ''}`),
    enabled: !!org,
    // While a webhook is waiting to be sent, keep the log fresh.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'RUNNING') ? 5000 : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['workflow', orgId, workflowId] });
    void qc.invalidateQueries({ queryKey: ['workflow-runs', orgId, workflowId] });
    void qc.invalidateQueries({ queryKey: ['workflows', orgId] });
  };
  const toggle = useMutation({ mutationFn: (on: boolean) => api<Workflow>(`${base}/${on ? 'turn-on' : 'turn-off'}`, { method: 'POST' }), onSuccess: (x) => (qc.setQueryData(['workflow', orgId, workflowId], x), refresh()) });
  const test = useMutation({
    mutationFn: (sendWebhooks: boolean) => api<{ matched: boolean; run: Run }>(`${base}/test`, { method: 'POST', body: { sendWebhooks } }),
    onSuccess: (r) => (setTestResult(r), refresh()),
  });
  const rotate = useMutation({ mutationFn: () => api<Workflow>(`${base}/rotate-secret`, { method: 'POST' }), onSuccess: (x) => (qc.setQueryData(['workflow', orgId, workflowId], x), setConfirmRotate(false), setShowSecret(true)) });

  if (!org) return null;
  const wf = w.data;
  const t = cat.data?.triggers.find((x) => x.key === wf?.trigger);
  const hasWebhook = !!wf?.actions.some((a) => a.type === 'WEBHOOK');
  const hasEmail = !!wf?.actions.some((a) => a.type === 'SEND_EMAIL');
  const scheduled = wf?.triggerKind === 'schedule';
  const contactWord = t?.facts.find((f) => f.key === 'contactName')?.label.toLowerCase() ?? 'customer or vendor';
  return (
    <>
      <PageHeader
        title={wf?.name ?? 'Workflow'}
        description={wf ? <>Version {wf.version} · created by {wf.createdBy ?? 'a former member'} · <Link className="text-accent hover:underline" href={`/orgs/${orgId}/automations`}>All automations</Link></> : undefined}
        actions={
          wf ? (
            <>
              {wf.enabled ? <Badge tone="positive">On</Badge> : <Badge>Off</Badge>}
              <Button variant="secondary" onClick={() => router.push(`/orgs/${orgId}/automations/${workflowId}/edit`)}>Edit</Button>
              <Button variant="secondary" loading={test.isPending && test.variables === false} onClick={() => test.mutate(false)}>Test</Button>
              {hasWebhook || hasEmail ? (
                <Button variant="secondary" loading={test.isPending && test.variables === true} onClick={() => test.mutate(true)}>
                  {hasEmail ? (hasWebhook ? 'Test and send' : 'Test and email me') : 'Test and send webhooks'}
                </Button>
              ) : null}
              <Button variant={wf.enabled ? 'danger' : 'primary'} loading={toggle.isPending} onClick={() => toggle.mutate(!wf.enabled)}>{wf.enabled ? 'Turn off' : 'Turn on'}</Button>
            </>
          ) : null
        }
      />
      <ErrorAlert title="Could not load the workflow" error={w.error} />
      <ErrorAlert title="Could not change the workflow" error={toggle.error} />
      <ErrorAlert title="The test did not run" error={test.error} />
      {wf ? (
        <div className="flex flex-col gap-4">
          {!wf.enabled ? (
            <Notice tone="warning" title="This workflow is off">
              {scheduled
                ? 'It does nothing until it is turned on. When it is, it acts only on times and dates from then on, so turning it on never sends a backlog.'
                : 'It does nothing until it is turned on. When it is, it acts only on what happens from then on, not on earlier events.'}
            </Notice>
          ) : null}
          {hasEmail && cat.data && !cat.data.email.ready ? (
            <Notice tone="warning" title="Email is not set up yet">Its emails fail, with that reason in the run log, until an owner or admin adds your mail server in <IntegrationsLink />. Tasks and webhooks still work.</Notice>
          ) : null}

          <Card>
            <CardHeader title="What it does" description={wf.description ?? undefined} />
            <dl className="grid gap-4 p-5 md:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">When</dt>
                <dd className="mt-1 text-sm">
                  {wf.triggerLabel}
                  {wf.nextOccurrence ? <p className="text-xs text-fg-muted">Next: {dateTime(wf.nextOccurrence)}</p> : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">Only if</dt>
                <dd className="mt-1 text-sm">{wf.conditions.length ? <ul className="flex flex-col gap-1">{wf.conditions.map((c, i) => <li key={i}>{describeCondition(c, t, cat.data)}</li>)}</ul> : 'Every time'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">Do</dt>
                <dd className="mt-1 text-sm">
                  <ol className="flex list-inside list-decimal flex-col gap-1">
                    {wf.actions.map((a, i) => (
                      <li key={i}>
                        {a.type === 'CREATE_TASK' ? (
                          <>Task “{a.title}” for {assigneeLabel(a.assignTo, cat.data)}{a.dueInDays === null ? '' : `, due ${a.dueInDays === 0 ? 'the same day' : `in ${a.dueInDays} day${a.dueInDays === 1 ? '' : 's'}`}`}</>
                        ) : a.type === 'SEND_EMAIL' ? (
                          <>Email “{a.subject}” to {emailToLabel(a.to, cat.data, `the ${contactWord}`)}</>
                        ) : (
                          <>Webhook to <span className="break-all font-mono text-xs">{a.url}</span></>
                        )}
                      </li>
                    ))}
                  </ol>
                </dd>
              </div>
            </dl>
          </Card>

          {testResult ? <TestResult result={testResult} onClose={() => setTestResult(null)} orgId={orgId} /> : null}

          <Card>
            <CardHeader
              title="Run log"
              description={scheduled ? 'Every time or record the workflow acted on, with what it found and what it did.' : 'Every event the workflow looked at, with what it found and what it did.'}
              actions={
                <Select aria-label="Show runs" className="w-48" value={filter} onChange={(e) => setFilter(e.target.value as RunStatus | '')}>
                  <option value="">Every run</option>
                  {(Object.keys(RUN_STATUS) as RunStatus[]).map((s) => <option key={s} value={s}>{RUN_STATUS[s].label}</option>)}
                </Select>
              }
            />
            <ErrorAlert title="Could not load runs" error={runs.error} />
            {runs.data && !runs.data.length ? <EmptyState title="No runs yet">{wf.enabled ? (scheduled ? 'Runs appear here when the schedule comes round, or a record reaches the date.' : 'The next matching event will appear here within a few seconds.') : 'Turn the workflow on, or test it.'}</EmptyState> : null}
            {runs.data?.length ? (
              <Table aria-label="Runs">
                <thead><tr><Th>When</Th><Th>About</Th><Th>Version</Th><Th>Result</Th><Th>Actions</Th><Th /></tr></thead>
                <tbody>
                  {runs.data.map((r) => (
                    <Tr key={r.id}>
                      <Td className="whitespace-nowrap">{dateTime(r.createdAt)}</Td>
                      <Td>{r.link ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${r.link.path}`}>{r.link.label}</Link> : r.trigger === 'SCHEDULE' ? `Schedule, ${r.facts.find((f) => f.key === 'date')?.value ?? ''}` : '—'}</Td>
                      <Td className="num">{r.version}</Td>
                      <Td><Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>{r.error ? <p className="mt-1 text-xs text-negative">{r.error}</p> : null}</Td>
                      <Td className="text-xs text-fg-muted">{r.actions.length ? r.actions.map((a) => `${ACTION_LABEL[a.type]}: ${ACTION_STATUS[a.status].label.toLowerCase()}`).join(' · ') : 'None'}</Td>
                      <Td><Button size="sm" variant="ghost" onClick={() => setOpenRun(r.id)}>Details</Button></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
          </Card>

          {hasWebhook ? (
            <Card>
              <CardHeader title="Webhook signing" description="Each webhook carries a t2t-signature header: t=<unix time>,v1=<HMAC-SHA256 of “<t>.<body>” with this secret, in hex>. Check it, and that t is recent, before trusting a delivery. t2t-delivery is the same on every retry of one delivery, so receivers can ignore repeats." actions={<Button size="sm" variant="secondary" onClick={() => setConfirmRotate(true)}>New secret</Button>} />
              <div className="flex flex-wrap items-center gap-3 p-5">
                <code className="break-all rounded bg-surface-hover px-2 py-1 text-xs" aria-label="Signing secret">{showSecret ? wf.signingSecret : `${wf.signingSecret.slice(0, 10)}${'•'.repeat(24)}`}</code>
                <Button size="sm" variant="ghost" onClick={() => setShowSecret((v) => !v)}>{showSecret ? 'Hide' : 'Show'}</Button>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Versions" description="A change to the trigger, conditions or actions makes a new version. Versions are never changed." />
            <Table aria-label="Versions">
              <thead><tr><Th>Version</Th><Th>When</Th><Th>Saved</Th><Th>By</Th><Th>Note</Th></tr></thead>
              <tbody>
                {wf.versions.map((v) => (
                  <Tr key={v.version}><Td className="num">{v.version}</Td><Td>{v.triggerLabel}</Td><Td>{dateTime(v.createdAt)}</Td><Td>{v.createdBy ?? '—'}</Td><Td>{v.note ?? (v.version === 1 ? 'Created' : '—')}</Td></Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : null}
      {openRun ? <RunDialog orgId={orgId} runId={openRun} onClose={() => setOpenRun(null)} onChanged={refresh} /> : null}
      <Dialog open={confirmRotate} onOpenChange={setConfirmRotate} title="Make a new signing secret?" description="The current secret stops working at once. Deliveries already waiting are signed with the new one. Update the receiving end straight after.">
        <ErrorAlert title="The secret was not changed" error={rotate.error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmRotate(false)}>Keep the current secret</Button>
          <Button variant="danger" loading={rotate.isPending} onClick={() => rotate.mutate()}>Make a new secret</Button>
        </div>
      </Dialog>
    </>
  );
}

function TestResult({ result, onClose, orgId }: { result: { matched: boolean; run: Run }; onClose: () => void; orgId: string }) {
  const r = result.run;
  return (
    <Card aria-label="Test result">
      <CardHeader
        title={result.matched ? 'Test: the conditions hold, so it would act' : 'Test: the conditions do not hold, so it would do nothing'}
        description={
          <>
            {r.trigger === 'SCHEDULE' ? (
              <>On the latest time the schedule came round, with today’s figures</>
            ) : r.eventId === null ? (
              <>On {r.link ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${r.link.path}`}>{r.link.label}</Link> : 'a record'}, {r.trigger === 'INVOICE_OVERDUE' ? 'the most recently overdue invoice still to be paid' : 'the next bill to fall due that is still to be paid'}</>
            ) : (
              <>On {r.link ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${r.link.path}`}>{r.link.label}</Link> : 'the latest event'}, the most recent {r.triggerLabel.toLowerCase().replace(/^an? /, '')}</>
            )}
            . Nothing was created{r.actions.some((a) => a.type === 'WEBHOOK' && a.status !== 'SKIPPED') ? '; test webhooks were sent, marked "test": true' : ''}
            {r.actions.some((a) => a.type === 'SEND_EMAIL' && a.status !== 'SKIPPED') ? '; each email was sent to you only, with [Test] in front of the subject' : ''}.
          </>
        }
        actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
      />
      <RunBody run={r} />
    </Card>
  );
}

function RunBody({ run, retry, narrow }: { run: Run; retry?: (position: number) => void; narrow?: boolean }) {
  return (
    <div className={cn('grid gap-5 p-5', !narrow && 'lg:grid-cols-3')}>
      <section aria-label="Facts">
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Facts</h3>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {run.facts.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-fg-muted">{f.label}</dt>
              <dd className={cn(f.type === 'money' && 'num')}>{f.display ?? f.value ?? '—'}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-label="Conditions">
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Conditions</h3>
        {run.conditions.length ? (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {run.conditions.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge tone={c.passed ? 'positive' : 'negative'}>{c.passed ? 'Holds' : 'Does not hold'}</Badge>
                <span>{c.label}<span className="text-fg-muted"> (was {c.actual ?? 'empty'})</span></span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-fg-muted">None: acts every time.</p>
        )}
      </section>
      <section aria-label="Actions">
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Actions</h3>
        {run.actions.length ? (
          <ol className="mt-2 flex flex-col gap-3 text-sm">
            {run.actions.map((a) => (
              <li key={a.position} className="rounded-[var(--t2t-radius-md)] border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{a.position + 1}. {ACTION_LABEL[a.type]}</span>
                  <Badge tone={ACTION_STATUS[a.status].tone}>{ACTION_STATUS[a.status].label}</Badge>
                </div>
                {a.type === 'CREATE_TASK' ? (
                  <p className="mt-1">“{a.input.title}” for {a.input.assigneeLabel}{a.input.dueDate ? `, due ${a.input.dueDate}` : ''}</p>
                ) : a.type === 'SEND_EMAIL' ? (
                  <div className="mt-1 flex flex-col gap-1" aria-label={`Email ${a.position + 1}`}>
                    <p>
                      To {a.input.recipientLabel}
                      {a.input.to?.length ? <span className="break-all text-fg-muted"> ({a.input.to.join(', ')})</span> : null}
                    </p>
                    {a.input.testSentTo ? <p className="text-xs text-fg-muted">Test sent to {a.input.testSentTo} only</p> : null}
                    <p className="font-medium">{a.input.subject}</p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-hover p-2 font-sans text-xs">{a.input.body}</pre>
                    {a.input.problem && !a.error ? <p className="text-xs text-negative">{a.input.problem}</p> : null}
                  </div>
                ) : (
                  <p className="mt-1 break-all font-mono text-xs">{a.input.url}</p>
                )}
                {a.error ? <p className="mt-1 text-xs text-negative">{a.error}</p> : null}
                {a.nextAttemptAt ? <p className="mt-1 text-xs text-fg-muted">Next try {dateTime(a.nextAttemptAt)}</p> : null}
                {a.history.length ? (
                  <ul className="mt-2 flex flex-col gap-0.5 text-xs text-fg-muted" aria-label="Attempts">
                    {a.history.map((h, i) => <li key={i}>{dateTime(h.at)}: {h.ok ? `answered ${h.status}` : (h.error ?? 'failed')} · {h.durationMs} ms</li>)}
                  </ul>
                ) : null}
                {retry && a.canRetry ? <Button className="mt-2" size="sm" variant="secondary" onClick={() => retry(a.position)}>Send again now</Button> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-fg-muted">Nothing: the conditions did not hold.</p>
        )}
      </section>
    </div>
  );
}

function RunDialog({ orgId, runId, onClose, onChanged }: { orgId: string; runId: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['workflow-run', orgId, runId], queryFn: () => api<Run>(`/v1/orgs/${orgId}/workflow-runs/${runId}`), refetchInterval: (x) => (x.state.data?.status === 'RUNNING' ? 3000 : false) });
  const retry = useMutation({
    mutationFn: (position: number) => api<Run>(`/v1/orgs/${orgId}/workflow-runs/${runId}/actions/${position}/retry`, { method: 'POST' }),
    onSuccess: (r) => (qc.setQueryData(['workflow-run', orgId, runId], r), onChanged()),
  });
  const r = q.data;
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())} title={r ? `${RUN_STATUS[r.status].label} · ${dateTime(r.createdAt)}` : 'Run'} description={r ? `${r.triggerLabel}${r.link ? `: ${r.link.label}` : ''} · version ${r.version}${r.testedBy ? ` · test by ${r.testedBy}` : ''}` : undefined}>
      <ErrorAlert title="Could not load the run" error={q.error} />
      <ErrorAlert title="Could not send again" error={retry.error} />
      {r ? (
        <>
          {r.error ? <Notice title="Why it failed">{r.error}</Notice> : null}
          <div className="-mx-5"><RunBody narrow run={r} retry={(p) => retry.mutate(p)} /></div>
          <p className="text-xs text-fg-faint">Failed deliveries are tried again after {[60, 300, 1800, 7200, 21600].map(seconds).join(', ')}.</p>
        </>
      ) : null}
    </Dialog>
  );
}
