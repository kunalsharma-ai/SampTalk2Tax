'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { LineDimensionTags } from '@/components/dimensions/line-dimensions';
import { ScheduleBadge } from '@/components/journal-templates/badges';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useDimensions } from '@/lib/dimensions';
import { date, dateTime, today } from '@/lib/format';
import type { TemplateDetail } from '@/lib/journal-templates';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function JournalTemplatePage() {
  const { org, orgId } = useOrg();
  const dims = useDimensions();
  const { templateId } = useParams<{ templateId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [useOpen, setUseOpen] = useState(false);
  const [useDate, setUseDate] = useState(today());
  const [resumeOpen, setResumeOpen] = useState(false);
  const key = ['journal-template', orgId, templateId];
  const q = useQuery({ queryKey: key, queryFn: () => api<TemplateDetail>(`/v1/orgs/${orgId}/journal-templates/${templateId}`) });
  const base = `/v1/orgs/${orgId}/journal-templates/${templateId}`;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['journal-template', orgId] });
    await qc.invalidateQueries({ queryKey: ['journal-templates', orgId] });
    await qc.invalidateQueries({ queryKey: ['journals', orgId] });
  };
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: { skipMissed: boolean } }) => api<TemplateDetail | { made: number; error: string | null; template: TemplateDetail }>(`${base}/${path}`, { method: 'POST', body }),
    onSuccess: async () => {
      setResumeOpen(false);
      await refresh();
    },
  });
  const use = useMutation({
    mutationFn: (post: boolean) => api<{ journalEntryId: string }>(`${base}/use`, { method: 'POST', body: { date: useDate, post } }),
    onSuccess: async (r) => {
      await refresh();
      router.push(`/orgs/${orgId}/journals/${r.journalEntryId}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(base, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      router.replace(`/orgs/${orgId}/journal-templates`);
    },
  });

  if (!org) return null;
  if (q.error) return <Alert title="Template not found">{(q.error as Error).message}</Alert>;
  const t = q.data;
  if (!t) return <p className="text-sm text-fg-muted">Loading…</p>;
  const c = org.functionalCurrency;
  const manage = can(org.role, 'journals.create');
  const mayPost = can(org.role, 'journals.post');
  const s = t.schedule;
  const ran = action.data && 'made' in action.data ? action.data : null;
  const archived = t.status === 'ARCHIVED';

  return (
    <>
      <PageHeader
        title={`${t.reference} · ${t.name}`}
        description={t.description ?? (s ? s.description : 'A journal template used by hand.')}
        actions={
          manage ? (
            <>
              {!archived ? <Button onClick={() => setUseOpen(true)}>Use template…</Button> : null}
              {s?.status === 'ACTIVE' && !archived && (s.postMode === 'DRAFT' || mayPost) ? (
                <Button variant="secondary" loading={action.isPending && action.variables?.path === 'run-due'} onClick={() => action.mutate({ path: 'run-due' })}>Run due now</Button>
              ) : null}
              {s?.status === 'ACTIVE' ? <Button variant="secondary" onClick={() => action.mutate({ path: 'pause' })}>Pause schedule</Button> : null}
              {s?.status === 'PAUSED' && !archived && (s.postMode === 'DRAFT' || mayPost) ? <Button variant="secondary" onClick={() => setResumeOpen(true)}>Resume…</Button> : null}
              {s && s.status !== 'ENDED' ? <Button variant="ghost" onClick={() => confirm('End this schedule? No more journals will be made from it. Journals already made stay as they are.') && action.mutate({ path: 'end' })}>End schedule</Button> : null}
              {!archived ? <Link href={`/orgs/${orgId}/journal-templates/${t.id}/edit`}><Button variant="secondary">Edit</Button></Link> : null}
              {archived ? (
                <Button variant="secondary" onClick={() => action.mutate({ path: 'restore' })}>Restore</Button>
              ) : t.runs.length ? (
                <Button variant="ghost" onClick={() => action.mutate({ path: 'archive' })}>Archive</Button>
              ) : (
                <Button variant="danger" loading={remove.isPending} onClick={() => confirm('Delete this template? It has not made any journals.') && remove.mutate()}>Delete</Button>
              )}
            </>
          ) : null
        }
      />
      <ErrorAlert title="That did not work" error={action.error ?? remove.error} />
      {ran ? (
        <Alert tone={ran.error ? 'warning' : 'positive'} title={ran.made ? `${ran.made} ${ran.made === 1 ? 'journal' : 'journals'} made` : ran.error ? 'No journal was made' : 'Nothing was due'}>
          {ran.error ?? (ran.made ? 'They are listed under Journals made below.' : 'Every run up to today has been made.')}
        </Alert>
      ) : null}
      {s?.lastError && !ran ? (
        <Alert tone="negative" title="The last scheduled run could not be made">
          {s.lastError} ({s.lastErrorAt ? dateTime(s.lastErrorAt) : ''}). Nothing was posted for it. Fix the cause (for example, open the period or reactivate the account) and it is tried again at the next check, or press Run due now.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Status</p>
          <div className="mt-2 flex flex-wrap gap-1">{archived ? <Badge>Archived</Badge> : <Badge tone="positive">In use</Badge>}{s ? <ScheduleBadge schedule={s} /> : null}</div>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Each journal</p>
          <p className="mt-2 text-sm">{t.totals.map((x) => <Money key={x.currency} value={x.amount} currency={x.currency} />)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Memo and reference</p>
          <p className="mt-2 text-sm">{t.memo ?? '—'}<span className="block text-xs text-fg-muted">ref {t.journalReference ?? t.reference}</span></p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Next run</p>
          <p className="mt-2 text-sm">{s?.nextRun && s.status !== 'ENDED' ? `${date(s.nextRun.date)} (run ${s.nextRun.no}${s.runsTotal ? ` of ${s.runsTotal}` : ''})` : s ? 'None left' : 'No schedule'}</p>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Lines" description={`Every journal made from this template posts these lines. Amounts in ${c} unless shown otherwise.`} />
        <Table aria-label="Template lines">
          <thead>
            <tr><Th>Account</Th><Th>Description</Th><Th numeric>Debit</Th><Th numeric>Credit</Th></tr>
          </thead>
          <tbody>
            {t.lines.map((l) => (
              <Tr key={l.lineNo}>
                <Td>
                  <Link className="text-accent hover:underline" href={`/orgs/${orgId}/accounts/${l.accountId}`}>{l.account.code} · {l.account.name}</Link>
                  <LineDimensionTags values={dims.data?.values} departmentId={l.departmentId} projectId={l.projectId} />
                </Td>
                <Td>{l.description ?? ''}</Td>
                <Td numeric>{l.debit ? <Money value={l.debit} currency={l.currency} /> : ''}</Td>
                <Td numeric>{l.credit ? <Money value={l.credit} currency={l.currency} /> : ''}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {s ? (
        <Card className="mt-6">
          <CardHeader title="Upcoming runs" description={`${s.description}. Each run ${s.postMode === 'POST' ? 'posts its journal' : 'makes a draft journal for someone to check and post'}.`} />
          {t.upcoming.length ? (
            <Table aria-label="Upcoming runs">
              <thead>
                <tr><Th>Run</Th><Th>Journal date</Th><Th>Memo</Th></tr>
              </thead>
              <tbody>
                {t.upcoming.map((r) => (
                  <Tr key={r.no}>
                    <Td>{r.no}</Td>
                    <Td>{date(r.date)}{r.date <= today() && s.status === 'ACTIVE' ? <Badge tone="warning" className="ml-2">Due</Badge> : null}</Td>
                    <Td>{r.memo ?? '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="px-5 pb-5 text-sm text-fg-muted">{s.status === 'ENDED' ? 'This schedule has ended.' : 'No run is left before the last date.'}</p>
          )}
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader title="Journals made" description="Every journal this template made, newest first, by the schedule or by a member." />
        {t.runs.length ? (
          <Table aria-label="Journals made">
            <thead>
              <tr><Th>Journal date</Th><Th>Made by</Th><Th>Journal</Th><Th>Memo</Th><Th numeric>Amount</Th></tr>
            </thead>
            <tbody>
              {t.runs.map((r) => (
                <Tr key={r.id}>
                  <Td>{date(r.date)}<span className="block text-xs text-fg-muted">{r.scheduled ? `Run ${r.runNo}` : 'By hand'}</span></Td>
                  <Td>{r.by}<span className="block text-xs text-fg-muted">{dateTime(r.createdAt)}</span></Td>
                  <Td>
                    {r.entry ? (
                      <>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${r.entry.id}`}>{r.entry.entryNumber ? `JE-${String(r.entry.entryNumber).padStart(6, '0')}` : 'Draft'}</Link>{' '}
                        {r.entry.status === 'DRAFT' ? <Badge tone="warning">Draft</Badge> : r.entry.reversed ? <Badge tone="negative">Reversed</Badge> : <Badge tone="positive">Posted</Badge>}
                      </>
                    ) : (
                      <span className="text-xs text-fg-muted">Draft deleted</span>
                    )}
                  </Td>
                  <Td>{r.entry?.memo ?? '—'}</Td>
                  <Td numeric>{r.entry ? <Money value={r.entry.total} currency={c} /> : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-5 pb-5 text-sm text-fg-muted">No journal has been made from this template yet.</p>
        )}
      </Card>

      <Dialog open={useOpen} onOpenChange={setUseOpen} title="Use this template" description="Make one journal from the template, dated as you choose. Placeholders in the memo take that date.">
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          Journal date
          <Input type="date" value={useDate} onChange={(e) => setUseDate(e.target.value)} />
        </label>
        <ErrorAlert title="The journal was not made" error={use.error} />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" loading={use.isPending && use.variables === false} disabled={use.isPending || !useDate} onClick={() => use.mutate(false)}>Make a draft</Button>
          {mayPost ? <Button loading={use.isPending && use.variables === true} disabled={use.isPending || !useDate} onClick={() => use.mutate(true)}>Post journal</Button> : null}
        </div>
      </Dialog>
      <Dialog open={resumeOpen} onOpenChange={setResumeOpen} title="Resume the schedule" description="Runs that fell due while the schedule was paused can be made now, or passed over.">
        <div className="flex flex-col gap-2">
          <Button loading={action.isPending && action.variables?.path === 'resume' && !(action.variables.body as { skipMissed?: boolean })?.skipMissed} onClick={() => action.mutate({ path: 'resume', body: { skipMissed: false } })}>Resume and make the missed runs</Button>
          <Button variant="secondary" loading={action.isPending && action.variables?.path === 'resume' && !!(action.variables.body as { skipMissed?: boolean })?.skipMissed} onClick={() => action.mutate({ path: 'resume', body: { skipMissed: true } })}>Resume from today, skipping missed runs</Button>
        </div>
      </Dialog>
    </>
  );
}
