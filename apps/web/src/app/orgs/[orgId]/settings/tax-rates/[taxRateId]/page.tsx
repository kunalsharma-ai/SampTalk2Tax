'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Entry {
  version: number;
  rate: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  state: 'PAST' | 'CURRENT' | 'SCHEDULED';
  id: string | null;
  reason: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
  canWithdraw: boolean;
}
interface History {
  id: string;
  name: string;
  kind: 'SIMPLE' | 'GST';
  gstCategory: string | null;
  originalRate: string;
  createdAt: string;
  rateToday: string;
  next: { effectiveFrom: string; rate: string } | null;
  canChange: boolean;
  timeline: Entry[];
  withdrawn: { id: string; rate: string; effectiveFrom: string; reason: string; withdrawnReason: string; withdrawnBy: string | null; withdrawnAt: string }[];
}

const STATE = { PAST: { tone: 'neutral', label: 'Past' }, CURRENT: { tone: 'positive', label: 'In force' }, SCHEDULED: { tone: 'accent', label: 'Scheduled' } } as const;
const RATE = /^\d{1,3}(\.\d{1,6})?$/;

/** One tax rate's history and scheduled changes (TAX-003). */
export default function TaxRateHistoryPage() {
  const { org, orgId } = useOrg();
  const { taxRateId } = useParams<{ taxRateId: string }>();
  const qc = useQueryClient();
  const key = ['tax-rate-history', orgId, taxRateId];
  const q = useQuery({ queryKey: key, queryFn: () => api<History>(`/v1/orgs/${orgId}/tax-rates/${taxRateId}/versions`) });
  const [form, setForm] = useState({ rate: '', effectiveFrom: '', reason: '' });
  const [withdrawing, setWithdrawing] = useState<{ entry: Entry; reason: string } | null>(null);
  const done = async (h: History) => {
    qc.setQueryData(key, h);
    await qc.invalidateQueries({ queryKey: ['tax-rates', orgId] });
  };
  const add = useMutation({ mutationFn: () => api<History>(`/v1/orgs/${orgId}/tax-rates/${taxRateId}/versions`, { method: 'POST', body: form }), onSuccess: async (h) => { setForm({ rate: '', effectiveFrom: '', reason: '' }); await done(h); } });
  const withdraw = useMutation({ mutationFn: (w: { id: string; reason: string }) => api<History>(`/v1/orgs/${orgId}/tax-rates/${taxRateId}/versions/${w.id}/withdraw`, { method: 'POST', body: { reason: w.reason } }), onSuccess: async (h) => { setWithdrawing(null); await done(h); } });
  if (!org) return null;
  const h = q.data;
  const canManage = can(org.role, 'accounts.manage');
  const backdated = !!form.effectiveFrom && form.effectiveFrom <= today();
  return (
    <>
      <PageHeader
        title={h ? `Tax rate history: ${h.name}` : 'Tax rate history'}
        description="Every percentage this rate has had and will have, with the date each took effect and why. Documents use the rate in force on their date, and expense claim lines the rate on the line's date, so a change never alters what is already recorded."
        actions={<Link className="text-sm underline" href={`/orgs/${orgId}/settings/tax-rates`}>All tax rates</Link>}
      />
      <ErrorAlert title="Could not load the rate" error={q.error} />
      {h ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone="positive">{h.rateToday}% today</Badge>
            {h.next ? <span>Changes to {h.next.rate}% from {date(h.next.effectiveFrom)}.</span> : <span>No change scheduled.</span>}
            <span>Created {date(h.createdAt.slice(0, 10))} at {h.originalRate}%.</span>
          </div>
          <Card className="mb-4">
            <CardHeader title="Rate history" description="Versions in date order. A version applies from its date until the day before the next one." />
            <Table aria-label="Rate history" className="[&_td]:align-top">
              <thead><Tr><Th>Version</Th><Th numeric>Rate</Th><Th>From</Th><Th>To</Th><Th>State</Th><Th>Why</Th><Th><span className="sr-only">Actions</span></Th></Tr></thead>
              <tbody>
                {h.timeline.map((e) => (
                  <Tr key={e.version}>
                    <Td>{e.version}</Td>
                    <Td numeric className="num">{e.rate}%</Td>
                    <Td>{e.effectiveFrom ? date(e.effectiveFrom) : 'The start'}</Td>
                    <Td>{e.effectiveTo ? date(e.effectiveTo) : '—'}</Td>
                    <Td><Badge tone={STATE[e.state].tone}>{STATE[e.state].label}</Badge></Td>
                    <Td>{e.reason ? <><div>{e.reason}</div><div className="text-xs text-fg-muted">{e.recordedBy}, {dateTime(e.recordedAt!)}</div></> : <span className="text-fg-muted">The rate as created</span>}</Td>
                    <Td className="text-right">{canManage && e.canWithdraw ? <Button size="sm" variant="ghost" onClick={() => { withdraw.reset(); setWithdrawing({ entry: e, reason: '' }); }}>Withdraw</Button> : null}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {canManage ? (
            <Card className="mb-4">
              <CardHeader title="Schedule a rate change" description="The new percentage applies to documents dated from the day it takes effect. Changes are added in date order and cannot reach back past posted documents or approved claims that use the rate." />
              {!h.canChange ? (
                <div className="p-4"><Alert tone="neutral" title="This rate stays at 0%">Nil-rated, exempt and non-GST rates do not change; create a new rate instead.</Alert></div>
              ) : (
                <form className="grid gap-3 p-4 sm:grid-cols-[8rem_12rem_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
                  <div className="sm:col-span-4"><ErrorAlert title="Change not scheduled" error={add.error} /></div>
                  <Field label="New rate (%)">{(p) => <Input {...p} inputMode="decimal" value={form.rate} onChange={(e) => /^\d{0,3}(\.\d{0,6})?$/.test(e.target.value) && setForm({ ...form, rate: e.target.value })} />}</Field>
                  <Field label="Takes effect on">{(p) => <Input {...p} type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />}</Field>
                  <Field label="Why (notification or reason)">{(p) => <Input {...p} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>
                  <Button type="submit" loading={add.isPending} disabled={!RATE.test(form.rate) || !form.effectiveFrom || form.reason.trim().length < 3}>Schedule change</Button>
                  {backdated ? <p className="text-xs text-warning sm:col-span-4">This change takes effect today or earlier: documents you record from now on with earlier dates will use it too.</p> : null}
                </form>
              )}
            </Card>
          ) : null}

          {h.withdrawn.length ? (
            <Card>
              <CardHeader title="Withdrawn changes" description="Scheduled changes withdrawn before they took effect, kept as a record." />
              <Table aria-label="Withdrawn changes">
                <thead><Tr><Th numeric>Rate</Th><Th>Was to take effect</Th><Th>Why it was scheduled</Th><Th>Why it was withdrawn</Th></Tr></thead>
                <tbody>
                  {h.withdrawn.map((w) => (
                    <Tr key={w.id}>
                      <Td numeric className="num">{w.rate}%</Td>
                      <Td>{date(w.effectiveFrom)}</Td>
                      <Td>{w.reason}</Td>
                      <Td>{w.withdrawnReason}<div className="text-xs text-fg-muted">{w.withdrawnBy}, {dateTime(w.withdrawnAt)}</div></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}

          {withdrawing ? (
            <Dialog open onOpenChange={(o) => !o && setWithdrawing(null)} title={`Withdraw the change to ${withdrawing.entry.rate}%?`} description={`It was to take effect on ${date(withdrawing.entry.effectiveFrom!)}. It stays on record as withdrawn.`}>
              <ErrorAlert title="Not withdrawn" error={withdraw.error} />
              <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); withdraw.mutate({ id: withdrawing.entry.id!, reason: withdrawing.reason }); }}>
                <Field label="Why withdraw it">{(p) => <Input {...p} maxLength={500} value={withdrawing.reason} onChange={(e) => setWithdrawing({ ...withdrawing, reason: e.target.value })} />}</Field>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setWithdrawing(null)}>Cancel</Button>
                  <Button type="submit" loading={withdraw.isPending} disabled={withdrawing.reason.trim().length < 3}>Withdraw change</Button>
                </div>
              </form>
            </Dialog>
          ) : null}
        </>
      ) : null}
    </>
  );
}
