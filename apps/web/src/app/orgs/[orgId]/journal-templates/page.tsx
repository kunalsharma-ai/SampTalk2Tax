'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ScheduleBadge } from '@/components/journal-templates/badges';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { TemplateList } from '@/lib/journal-templates';
import { useOrg } from '@/lib/org';

type View = 'active' | 'scheduled' | 'archived' | 'all';
const VIEWS: Record<View, string> = { active: 'In use', scheduled: 'With a schedule', archived: 'Archived', all: 'All templates' };

export default function JournalTemplatesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [view, setView] = useState<View>('active');
  const list = useQuery({ queryKey: ['journal-templates', orgId, view], queryFn: () => api<TemplateList>(`/v1/orgs/${orgId}/journal-templates?view=${view}`) });
  const run = useMutation({
    mutationFn: () => api<{ templates: number; made: number; errors: { id: string; error: string }[] }>(`/v1/orgs/${orgId}/journal-templates/run-due`, { method: 'POST' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['journal-templates', orgId] });
      await qc.invalidateQueries({ queryKey: ['journals', orgId] });
    },
  });
  if (!org) return null;
  const r = list.data;
  const problems = r?.items.filter((t) => t.schedule?.lastError).length ?? 0;
  const due = r?.items.reduce((n, t) => n + (t.schedule?.dueNow ?? 0), 0) ?? 0;
  return (
    <>
      <PageHeader
        title="Journal templates"
        description="Journals you enter again and again, such as rent, accruals or management charges. Use a template to start a journal, or give it a schedule and each run becomes a journal by itself, checked like any other."
        actions={
          r?.can.manage ? (
            <>
              <Button variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>Run due now</Button>
              <Link href={`/orgs/${orgId}/journal-templates/new`}><Button>New template</Button></Link>
            </>
          ) : null
        }
      />
      <ErrorAlert title="Could not load templates" error={list.error} />
      <ErrorAlert title="Could not run the schedules" error={run.error} />
      {run.data ? (
        <Alert tone={run.data.errors.length ? 'warning' : 'positive'} title={run.data.made ? `${run.data.made} ${run.data.made === 1 ? 'journal' : 'journals'} made` : 'Nothing was due'}>
          Checked {run.data.templates} active {run.data.templates === 1 ? 'schedule' : 'schedules'}.{run.data.errors.length ? ` ${run.data.errors.length} could not run; open them to see why.` : ''}
        </Alert>
      ) : null}
      {r ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Templates in use" value={String(r.counts.active)} tone="accent" sub={`${r.counts.archived} archived`} />
            <Stat label="Recurring journals" value={String(r.counts.scheduled)} tone="violet" sub="Templates with a schedule" />
            <Stat label="Runs due now" value={String(due)} tone={due ? 'warning' : 'positive'} sub="Made at the next hourly check" />
            <Stat label="Schedule problems" value={String(problems)} tone={problems ? 'negative' : 'positive'} sub="A run that could not be made" />
          </div>
          <Card>
            <div className="flex items-center justify-end gap-2 border-b border-line px-5 py-3">
              <label htmlFor="jt-view" className="text-xs text-fg-muted">Show</label>
              <Select id="jt-view" className="w-52" value={view} onChange={(e) => setView(e.target.value as View)}>
                {(Object.keys(VIEWS) as View[]).map((v) => <option key={v} value={v}>{VIEWS[v]} ({r.counts[v]})</option>)}
              </Select>
            </div>
            {r.items.length === 0 ? (
              <EmptyState title="No templates here">Save a journal you post every month as a template, or open a posted journal and choose Save as template.</EmptyState>
            ) : (
              <Table aria-label="Journal templates">
                <thead>
                  <tr><Th>Template</Th><Th>Accounts</Th><Th>Schedule</Th><Th>Next run</Th><Th>Status</Th><Th numeric>Journals made</Th><Th numeric>Amount</Th></tr>
                </thead>
                <tbody>
                  {r.items.map((t) => (
                    <Tr key={t.id}>
                      <Td>
                        <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/journal-templates/${t.id}`}>{t.reference}</Link>
                        <span className="block text-xs text-fg-muted">{t.name}</span>
                      </Td>
                      <Td className="text-xs text-fg-muted">{t.lines.map((l) => l.account.code).join(', ')}</Td>
                      <Td className="text-sm">{t.schedule ? t.schedule.description : <span className="text-fg-muted">Used by hand</span>}</Td>
                      <Td>{t.schedule?.nextRun && t.schedule.status === 'ACTIVE' ? date(t.schedule.nextRun.date) : '—'}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {t.status === 'ARCHIVED' ? <Badge>Archived</Badge> : null}
                          {t.schedule ? <ScheduleBadge schedule={t.schedule} /> : null}
                          {t.schedule?.lastError ? <span className="text-xs text-negative">Run problem</span> : null}
                        </div>
                      </Td>
                      <Td numeric>{t.runs}</Td>
                      <Td numeric>{t.totals.map((x) => <Money key={x.currency} value={x.amount} currency={x.currency} />)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
