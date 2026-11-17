'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UNBILLED_CONFIDENCE_LABEL, UNBILLED_SOURCE_LABEL, UNBILLED_SOURCES, type UnbilledConfidence, type UnbilledSource } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Finding {
  fingerprint: string;
  source: UnbilledSource;
  refId: string;
  contactId: string;
  customer: string;
  currency: string;
  amount: string | null;
  since: string;
  ageDays: number;
  confidence: UnbilledConfidence;
  label: string;
  path: string;
  detail: string;
  dismissed: { reason: string; by: string | null; at: string; amount: string | null } | null;
}
interface Report {
  asOf: string;
  currency: string;
  totals: { currency: string; amount: string; count: number; bySource: Partial<Record<UnbilledSource, string>> }[];
  counts: { open: number; dismissed: number };
  findings: Finding[];
}
const CONFIDENCE_TONE = { CERTAIN: 'negative', LIKELY: 'warning', POSSIBLE: 'neutral' } as const;

/** Sales → Unbilled revenue (AR-042): revenue earned or agreed but not yet invoiced. */
export default function UnbilledRevenuePage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const key = ['unbilled-revenue', orgId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Report>(`/v1/orgs/${orgId}/sales/unbilled-revenue`) });
  const [view, setView] = useState<'open' | 'dismissed'>('open');
  const [source, setSource] = useState<UnbilledSource | ''>('');
  const [acting, setActing] = useState<Finding | null>(null);
  if (!org) return null;
  const r = q.data;
  const canManage = can(org.role, 'sales.manage');
  const rows = r ? r.findings.filter((f) => (view === 'open' ? !f.dismissed : !!f.dismissed) && (!source || f.source === source)) : [];
  const main = r?.totals.find((t) => t.currency === r.currency) ?? r?.totals[0];
  const sum = (s: UnbilledSource[]) => (main ? s.reduce((t, x) => t + Number(main.bySource[x] ?? 0), 0).toFixed(2) : '0');
  return (
    <>
      <PageHeader title="Unbilled revenue" description="Revenue that was earned or agreed but not yet invoiced: milestones completed, contract periods due, draft invoices waiting, orders left unbilled, pro forma invoices that ran out, and regular customers not billed last month. Each finding says what it rests on; amounts are before tax." />
      <ErrorAlert title="Could not look for unbilled revenue" error={q.error} />
      {r ? (
        <div className="grid gap-4 sm:grid-cols-4">
          <Card className="p-4"><p className="text-sm text-fg-muted">Not yet billed</p><p className="mt-1 text-2xl font-semibold"><Money value={main?.amount ?? '0'} currency={main?.currency ?? r.currency} /></p><p className="text-xs text-fg-muted">{r.counts.open} finding{r.counts.open === 1 ? '' : 's'}{r.totals.length > 1 ? `, plus ${r.totals.length - 1} other currenc${r.totals.length === 2 ? 'y' : 'ies'}` : ''}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Due now</p><p className="mt-1 text-2xl font-semibold text-negative"><Money value={sum(['MILESTONE', 'CONTRACT_PERIOD', 'DRAFT_INVOICE'])} currency={main?.currency ?? r.currency} /></p><p className="text-xs text-fg-muted">Milestones, contract periods, drafts</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Likely</p><p className="mt-1 text-2xl font-semibold"><Money value={sum(['ORDER', 'PRO_FORMA'])} currency={main?.currency ?? r.currency} /></p><p className="text-xs text-fg-muted">Orders and pro formas</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Possible</p><p className="mt-1 text-2xl font-semibold"><Money value={sum(['REGULAR_CUSTOMER'])} currency={main?.currency ?? r.currency} /></p><p className="text-xs text-fg-muted">Regular customers missed</p></Card>
        </div>
      ) : null}
      {r ? (
        <Card className="mt-6" role="region" aria-label="Findings">
          <CardHeader
            title="Revenue not yet billed"
            description={`As of ${date(r.asOf)}. Open each one to bill it, or dismiss it with the reason it should not be billed.`}
            actions={
              <div className="flex flex-wrap gap-2">
                <div className="w-56"><Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as UnbilledSource | '')}><option value="">Every source</option>{UNBILLED_SOURCES.map((s) => <option key={s} value={s}>{UNBILLED_SOURCE_LABEL[s]}</option>)}</Select></div>
                <div className="w-40"><Select aria-label="Show" value={view} onChange={(e) => setView(e.target.value as 'open' | 'dismissed')}><option value="open">To bill ({r.counts.open})</option><option value="dismissed">Dismissed ({r.counts.dismissed})</option></Select></div>
              </div>
            }
          />
          {rows.length ? (
            <Table>
              <thead><Tr><Th>What</Th><Th>Customer</Th><Th>Since</Th><Th numeric>Amount</Th><Th><span className="sr-only">Actions</span></Th></Tr></thead>
              <tbody>
                {rows.map((f) => (
                  <Tr key={f.fingerprint}>
                    <Td className="align-top">
                      <span className="flex flex-wrap items-center gap-2"><Badge tone={CONFIDENCE_TONE[f.confidence]}>{UNBILLED_CONFIDENCE_LABEL[f.confidence]}</Badge><span className="text-xs text-fg-muted">{UNBILLED_SOURCE_LABEL[f.source]}</span></span>
                      <Link className="mt-1 block text-accent hover:underline" href={`/orgs/${orgId}${f.path}`}>{f.label}</Link>
                      <span className="block max-w-2xl text-sm text-fg-muted">{f.detail}</span>
                      {f.dismissed ? <span className="mt-1 block text-xs">Dismissed {date(f.dismissed.at)}{f.dismissed.by ? ` by ${f.dismissed.by}` : ''}: {f.dismissed.reason}</span> : null}
                    </Td>
                    <Td className="align-top"><Link className="hover:underline" href={`/orgs/${orgId}/sales/customers/${f.contactId}`}>{f.customer}</Link></Td>
                    <Td className="align-top whitespace-nowrap">{date(f.since)}<span className="block text-xs text-fg-muted">{f.ageDays} day{f.ageDays === 1 ? '' : 's'}</span></Td>
                    <Td numeric className="align-top">{f.amount === null ? '—' : <Money value={f.amount} currency={f.currency} />}</Td>
                    <Td className="align-top">{canManage ? <Button size="sm" variant="ghost" onClick={() => setActing(f)}>{f.dismissed ? 'Bring back' : 'Dismiss'}</Button> : null}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title={view === 'open' ? 'Nothing waiting to be billed' : 'Nothing dismissed'}>{view === 'open' ? 'Every completed milestone, due contract period, order and pro forma is invoiced.' : 'Dismissed findings show here with the reason.'}</EmptyState>
          )}
        </Card>
      ) : null}
      {acting ? <ActDialog orgId={orgId} finding={acting} onClose={() => setActing(null)} onDone={(x) => { qc.setQueryData(key, x); setActing(null); }} /> : null}
    </>
  );
}

function ActDialog({ orgId, finding, onClose, onDone }: { orgId: string; finding: Finding; onClose: () => void; onDone: (r: Report) => void }) {
  const restore = !!finding.dismissed;
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api<Report>(`/v1/orgs/${orgId}/sales/unbilled-revenue/dismissals`, { method: 'POST', body: { fingerprint: finding.fingerprint, action: restore ? 'RESTORE' : 'DISMISS', reason } }),
    onSuccess: onDone,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={restore ? `Bring back ${finding.label}` : `Dismiss ${finding.label}`} description={restore ? 'It goes back on the list to bill.' : 'Say why it should not be billed. If the amount grows later, it comes back by itself.'}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {save.error ? <Alert title="Could not save">{save.error.message}</Alert> : null}
        <Field label="Reason">{(p) => <Textarea {...p} rows={2} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>{restore ? 'Bring back' : 'Dismiss'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
