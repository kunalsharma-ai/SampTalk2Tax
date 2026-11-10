'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addMonth, monthLabel } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import type { ScheduleProgress } from '@/components/revenue-recognition/recognition-card';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useAccounts, useOrg } from '@/lib/org';

interface Settings {
  deferredAccount: { id: string; code: string; name: string } | null;
  chosen: boolean;
  can: { manage: boolean; settings: boolean };
}
interface Overview {
  from: string;
  functionalCurrency: string;
  lines: {
    documentId: string;
    invoice: string;
    invoiceStatus: string;
    issueDate: string;
    customer: { id: string; name: string };
    lineNo: number;
    startDate: string;
    endDate: string;
    months: number;
    method: 'EVEN' | 'DAILY';
    schedule: ScheduleProgress;
  }[];
  totals: { lines: number; deferredNow: string; recognised: string };
  waterfall: { months: { month: string; amount: string }[]; before: string; after: string; total: string };
  settings: Settings;
}
const DEFERRED_SUBTYPES = ['OTHER_CURRENT_LIABILITY', 'OTHER_NON_CURRENT_LIABILITY', 'ACCRUED_LIABILITY'];

/** Sales → Revenue recognition (AR-028): the deferred revenue account, invoice lines recognised over time, and the revenue waterfall. */
export default function RevenueRecognitionPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [from, setFrom] = useState(today().slice(0, 7));
  const q = useQuery({ queryKey: ['revenue-recognition', orgId, from], queryFn: () => api<Overview>(`/v1/orgs/${orgId}/sales/revenue-recognition?from=${from}`) });
  if (!org) return null;
  const o = q.data;
  const cur = o?.functionalCurrency ?? org.functionalCurrency;
  const max = o ? Math.max(...o.waterfall.months.map((m) => Number(m.amount)), 0) : 0;
  return (
    <>
      <PageHeader
        title="Revenue recognition"
        description="Invoice lines for services delivered over time go to deferred revenue when the invoice posts and are recognised month by month. Set the service period on a draft invoice's lines; the monthly release run under Prepaid and deferred moves each month to revenue."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/deferrals/releases`}>Monthly release run</Link>}
      />
      <ErrorAlert title="Could not load revenue recognition" error={q.error} />
      {o ? <SettingsCard orgId={orgId} s={o.settings} onDone={() => qc.invalidateQueries({ queryKey: ['revenue-recognition', orgId] })} /> : null}

      {o ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Card className="p-4"><p className="text-sm text-fg-muted">Invoice lines recognised over time</p><p className="mt-1 text-2xl font-semibold">{o.totals.lines}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Recognised so far</p><p className="mt-1 text-2xl font-semibold"><Money value={o.totals.recognised} currency={cur} /></p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Still deferred</p><p className="mt-1 text-2xl font-semibold"><Money value={o.totals.deferredNow} currency={cur} /></p></Card>
        </div>
      ) : null}

      {o ? (
        <Card className="mt-6" role="region" aria-label="Revenue waterfall">
          <CardHeader
            title="Revenue waterfall"
            description="What every deferred revenue schedule recognises each month: posted months as posted, later months as scheduled. It includes schedules entered by hand under Prepaid and deferred."
            actions={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" aria-label="Earlier months" onClick={() => setFrom(addMonth(from, -12))}>←</Button>
                <Input aria-label="From month" type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
                <Button size="sm" variant="ghost" aria-label="Later months" onClick={() => setFrom(addMonth(from, 12))}>→</Button>
              </div>
            }
          />
          <Table aria-label="Waterfall">
            <thead><Tr><Th>Month</Th><Th numeric>Revenue recognised</Th><Th><span className="sr-only">Bar</span></Th></Tr></thead>
            <tbody>
              <Tr><Td className="text-fg-muted">Before {monthLabel(from)}</Td><Td numeric className="text-fg-muted"><Money value={o.waterfall.before} currency={cur} /></Td><Td /></Tr>
              {o.waterfall.months.map((m) => (
                <Tr key={m.month}>
                  <Td>{monthLabel(m.month)}{m.month < today().slice(0, 7) ? null : <span className="ml-2 text-xs text-fg-muted">scheduled</span>}</Td>
                  <Td numeric><Money value={m.amount} currency={cur} /></Td>
                  <Td className="w-1/2"><div className="h-2 rounded bg-[var(--t2t-accent)]" style={{ width: max ? `${(Number(m.amount) / max) * 100}%` : 0 }} /></Td>
                </Tr>
              ))}
              <Tr><Td className="text-fg-muted">After {monthLabel(o.waterfall.months.at(-1)!.month)}</Td><Td numeric className="text-fg-muted"><Money value={o.waterfall.after} currency={cur} /></Td><Td /></Tr>
            </tbody>
            <tfoot><tr><Td className="font-semibold">All schedules</Td><Td numeric className="font-semibold"><Money value={o.waterfall.total} currency={cur} /></Td><Td /></tr></tfoot>
          </Table>
        </Card>
      ) : null}

      {o ? (
        <Card className="mt-6" role="region" aria-label="Invoice lines">
          <CardHeader title="Invoice lines recognised over time" description="Each posted invoice line with a service period, its deferred revenue schedule and how much of it is recognised. Voiding an invoice takes back what its lines recognised and ends their schedules." />
          {o.lines.length ? (
            <Table>
              <thead><Tr><Th>Invoice</Th><Th>Customer</Th><Th>Service period</Th><Th>Schedule</Th><Th numeric>Amount</Th><Th numeric>Recognised</Th><Th numeric>Still deferred</Th></Tr></thead>
              <tbody>
                {o.lines.map((l) => (
                  <Tr key={`${l.documentId}-${l.lineNo}`}>
                    <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${l.documentId}`}>{l.invoice}</Link><span className="block text-xs text-fg-muted">line {l.lineNo} · {date(l.issueDate)}</span>{l.invoiceStatus === 'VOID' ? <Badge tone="negative">Void</Badge> : null}</Td>
                    <Td>{l.customer.name}</Td>
                    <Td className="text-sm">{date(l.startDate)} to {date(l.endDate)}<span className="block text-xs text-fg-muted">{l.months} months, {l.method === 'DAILY' ? 'by days' : 'evenly'}</span></Td>
                    <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/deferrals/${l.schedule.id}`}>{l.schedule.reference}</Link>{l.schedule.status === 'ENDED' ? <> <Badge tone="neutral">Ended</Badge></> : null}</Td>
                    <Td numeric><Money value={l.schedule.amount} currency={cur} /></Td>
                    <Td numeric><Money value={l.schedule.recognised} currency={cur} /></Td>
                    <Td numeric><Money value={l.schedule.deferred} currency={cur} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="Nothing recognised over time yet">Open a draft invoice, tick the lines for a service delivered over time under Revenue recognition, set when the service starts and for how many months, then post it.</EmptyState>
          )}
        </Card>
      ) : null}
    </>
  );
}

function SettingsCard({ orgId, s, onDone }: { orgId: string; s: Settings; onDone: () => Promise<void> }) {
  const accounts = useAccounts();
  const [acc, setAcc] = useState(s.deferredAccount?.id ?? '');
  const save = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/sales/revenue-recognition/settings`, { method: 'PUT', body: { deferredAccountId: acc } }), onSuccess: onDone });
  const options = (accounts.data ?? []).filter((a) => a.type === 'LIABILITY' && a.isPostable && a.isActive && DEFERRED_SUBTYPES.includes(a.subtype ?? ''));
  return (
    <Card role="region" aria-label="Deferred revenue account">
      <CardHeader title="Deferred revenue account" description="The liability account that holds revenue invoiced but not yet earned. Lines recognised over time are credited here when their invoice posts." />
      <div className="flex flex-col gap-3 px-5 pb-5">
        {!s.deferredAccount ? <Alert tone="warning" title="No deferred revenue account">Choose one before recognising invoice lines over time.</Alert> : null}
        {s.deferredAccount && !s.chosen ? <p className="text-sm text-fg-muted">Using the standard account {s.deferredAccount.code} {s.deferredAccount.name} until you choose another.</p> : null}
        {save.error ? <Alert title="Could not save">{save.error.message}</Alert> : null}
        {s.can.settings ? (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Account">{(p) => <Select {...p} value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">Choose…</option>{options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>}</Field>
            <Button type="submit" size="sm" disabled={!acc || (s.chosen && acc === s.deferredAccount?.id)} loading={save.isPending}>Save</Button>
          </form>
        ) : s.deferredAccount ? <p className="text-sm">{s.deferredAccount.code} {s.deferredAccount.name}</p> : null}
      </div>
    </Card>
  );
}
