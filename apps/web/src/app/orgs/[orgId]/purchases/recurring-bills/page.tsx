'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dec } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { recurringBillStatus, type RecurringBillList } from '@/lib/recurring-bills';

type View = 'active' | 'paused' | 'ended' | 'all';
const VIEWS: Record<View, string> = { active: 'Active', paused: 'Paused', ended: 'Ended', all: 'All recurring bills' };

export default function RecurringBillsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [view, setView] = useState<View>('active');
  const list = useQuery({ queryKey: ['recurring-bills', orgId, view], queryFn: () => api<RecurringBillList>(`/v1/orgs/${orgId}/purchases/recurring-bills?view=${view}`) });
  const run = useMutation({
    mutationFn: () => api<{ recurringBills: number; made: number; errors: { id: string; error: string }[] }>(`/v1/orgs/${orgId}/purchases/recurring-bills/run-due`, { method: 'POST' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['recurring-bills', orgId] });
      await qc.invalidateQueries({ queryKey: ['documents', orgId] });
    },
  });
  if (!org) return null;
  const r = list.data;
  const problems = r?.items.filter((t) => t.schedule.lastError).length ?? 0;
  const due = r?.items.reduce((n, t) => n + t.schedule.dueNow, 0) ?? 0;
  const monthly = r?.items.filter((t) => t.schedule.status === 'ACTIVE' && t.schedule.frequency === 'MONTHLY').reduce((n, t) => n.plus(dec(t.subtotal)), dec('0')).toFixed(2) ?? '0.00';
  return (
    <>
      <PageHeader
        title="Recurring bills"
        description="Vendor bills that come every month, quarter or year, such as rent, maintenance contracts and subscriptions. Each run becomes a bill by itself, as a draft to check or posted, with the same GST, TDS and approval checks as a bill entered by hand."
        actions={
          r?.can.manage ? (
            <>
              <Button variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>Make due bills now</Button>
              <Link href={`/orgs/${orgId}/purchases/recurring-bills/new`}><Button>New recurring bill</Button></Link>
            </>
          ) : null
        }
      />
      <ErrorAlert title="Could not load recurring bills" error={list.error} />
      <ErrorAlert title="Could not make the due bills" error={run.error} />
      {run.data ? (
        <Alert tone={run.data.errors.length ? 'warning' : 'positive'} title={run.data.made ? `${run.data.made} ${run.data.made === 1 ? 'bill' : 'bills'} made` : 'Nothing was due'}>
          Checked {run.data.recurringBills} active recurring {run.data.recurringBills === 1 ? 'bill' : 'bills'}.{run.data.errors.length ? ` ${run.data.errors.length} could not run; open them to see why.` : ''}
        </Alert>
      ) : null}
      {r ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Active" value={String(r.counts.active)} tone="accent" sub={`${r.counts.paused} paused, ${r.counts.ended} ended`} />
            <Stat label="Monthly bills, before tax" value={<Money value={monthly} currency={org.functionalCurrency} />} tone="violet" sub="Active monthly recurring bills" />
            <Stat label="Bills due now" value={String(due)} tone={due ? 'warning' : 'positive'} sub="Made at the next hourly check" />
            <Stat label="Run problems" value={String(problems)} tone={problems ? 'negative' : 'positive'} sub="A bill that could not be made" />
          </div>
          <Card>
            <div className="flex items-center justify-end gap-2 border-b border-line px-5 py-3">
              <label htmlFor="rb-view" className="text-xs text-fg-muted">Show</label>
              <Select id="rb-view" className="w-52" value={view} onChange={(e) => setView(e.target.value as View)}>
                {(Object.keys(VIEWS) as View[]).map((v) => <option key={v} value={v}>{VIEWS[v]} ({r.counts[v]})</option>)}
              </Select>
            </div>
            {r.items.length === 0 ? (
              <EmptyState title="No recurring bills here">Set one up for a bill you enter every month, or open a bill and choose Make recurring.</EmptyState>
            ) : (
              <Table aria-label="Recurring bills">
                <thead>
                  <tr><Th>Recurring bill</Th><Th>Vendor</Th><Th>Schedule</Th><Th>Next bill</Th><Th>Status</Th><Th numeric>Bills made</Th><Th numeric>Before tax</Th></tr>
                </thead>
                <tbody>
                  {r.items.map((t) => {
                    const st = recurringBillStatus(t.schedule);
                    return (
                      <Tr key={t.id}>
                        <Td>
                          <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/purchases/recurring-bills/${t.id}`}>{t.reference}</Link>
                          <span className="block text-xs text-fg-muted">{t.name}</span>
                        </Td>
                        <Td>{t.contact.name}</Td>
                        <Td className="text-sm">{t.schedule.description}</Td>
                        <Td>{t.schedule.nextRun && t.schedule.status === 'ACTIVE' ? date(t.schedule.nextRun.date) : '—'}</Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={st.tone}>{st.label}</Badge>
                            {t.schedule.lastError ? <span className="text-xs text-negative">Run problem</span> : null}
                          </div>
                        </Td>
                        <Td numeric>{t.runs}</Td>
                        <Td numeric><Money value={t.subtotal} currency={t.currency} /></Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
