'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Stat, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Status = 'READY' | 'ATTENTION' | 'MISSING' | 'NOT_APPLICABLE';
interface Check {
  key: string;
  title: string;
  reference: string | null;
  status: Status;
  detail: string;
  items: string[];
  note: { text: string; by: string | null; at: string } | null;
  statusWhenReady: Status | null;
}
interface Preparation {
  taxYear: string;
  from: string;
  to: string;
  yearEnded: boolean;
  status: 'OPEN' | 'READY';
  checks: Check[];
  summary: { ready: number; attention: number; missing: number; notApplicable: number };
  blockers: string[];
  ready: { by: string | null; at: string; summary: Preparation['summary']; changedSince: string[] } | null;
  reopened: { by: string | null; at: string; reason: string | null } | null;
}

const TONE: Record<Status, 'positive' | 'warning' | 'negative' | 'neutral'> = { READY: 'positive', ATTENTION: 'warning', MISSING: 'negative', NOT_APPLICABLE: 'neutral' };
const LABEL: Record<Status, string> = { READY: 'Ready', ATTENTION: 'Needs attention', MISSING: 'Missing', NOT_APPLICABLE: 'Does not apply' };
/** Where each check is fixed. */
const FIX: Record<string, { href: string; label: string }> = {
  PERIODS_LOCKED: { href: '/periods', label: 'Periods' },
  YEAR_CLOSED: { href: '/year-end', label: 'Year-end close' },
  NO_DRAFTS: { href: '/journals', label: 'Journals' },
  BANK_RECONCILED: { href: '/banking', label: 'Banking' },
  RETURNS_FILED: { href: '/tax/compliance', label: 'Compliance calendar' },
  FILING_PROOF: { href: '/tax/compliance-documents', label: 'Compliance documents' },
  CASH_PAYMENTS: { href: '/tax/tax-audit', label: 'Tax audit' },
  CASH_RECEIPTS: { href: '/tax/tax-audit', label: 'Tax audit' },
  TDS_ON_TIME: { href: '/tax/tax-audit', label: 'Tax audit' },
  DEPRECIATION: { href: '/fixed-assets', label: 'Fixed assets' },
  INCOME_COMPUTATION: { href: '/tax/income-computation', label: 'Income tax computation' },
};
const yearsBack = (n: number) => {
  const t = new Date(Date.now() + 5.5 * 3_600_000); // not money
  const start = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
  return Array.from({ length: n }, (_, i) => `${start - i}-${String((start - i + 1) % 100).padStart(2, '0')}`); // not money
};

/** Tax audit preparation (TAX-051): what is left before the year's books go to the tax auditor. */
export default function AuditPreparationPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const years = yearsBack(4);
  const [year, setYear] = useState(years[1]!);
  const key = ['audit-preparation', orgId, year];
  const q = useQuery({ queryKey: key, queryFn: () => api<Preparation>(`/v1/orgs/${orgId}/tax/audit-preparation?year=${year}`) });
  const base = `/v1/orgs/${orgId}/tax/audit-preparation/${year}`;
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reopening, setReopening] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const done = (r: Preparation) => qc.setQueryData(key, r);
  const note = useMutation({ mutationFn: (n: { key: string; text: string }) => api<Preparation>(`${base}/notes/${n.key}`, { method: 'PUT', body: { note: n.text } }), onSuccess: (r) => { setEditing(null); done(r); } });
  const ready = useMutation({ mutationFn: () => api<Preparation>(`${base}/ready`, { method: 'POST' }), onSuccess: (r) => { setConfirming(false); done(r); } });
  const reopen = useMutation({ mutationFn: (reason: string) => api<Preparation>(`${base}/reopen`, { method: 'POST', body: { reason } }), onSuccess: (r) => { setReopening(null); done(r); } });
  if (!org) return null;
  const r = q.data?.taxYear === year ? q.data : undefined;
  const canManage = can(org.role, 'accounts.manage');
  const isReady = r?.status === 'READY';
  const download = async () => {
    setBusy(true);
    try {
      const x = await api<{ fileName: string; csv: string }>(`/v1/orgs/${orgId}/tax/audit-preparation/export?year=${year}`);
      const url = URL.createObjectURL(new Blob([x.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = x.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Tax audit preparation"
        description="What is left before the year's books go to the tax auditor: months locked, drafts posted, banks reconciled, returns filed with proof, the Form 3CD points the auditor will ask about, and the income tax computation. Fix what is missing, explain the rest in a note for the auditor, then mark the year ready."
        actions={
          <span className="flex items-center gap-2">
            <Button variant="secondary" size="sm" loading={busy} disabled={!r} onClick={() => void download()}>Download checklist (CSV)</Button>
            {canManage && r && !isReady ? <Button size="sm" disabled={r.blockers.length > 0} onClick={() => setConfirming(true)}>Mark ready for the auditor</Button> : null}
            {canManage && isReady ? <Button variant="ghost" size="sm" onClick={() => setReopening('')}>Reopen</Button> : null}
          </span>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Financial year">
          {(p) => (
            <Select {...p} className="w-40" value={year} onChange={(e) => { setYear(e.target.value); setEditing(null); }}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          )}
        </Field>
      </div>
      <ErrorAlert title="Could not load the checks" error={q.error} />
      {r ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {isReady ? <Badge tone="positive">Ready for the auditor</Badge> : r.yearEnded ? <Badge>Being prepared</Badge> : <Badge tone="warning">Year in progress</Badge>}
            <span>{date(r.from)} to {date(r.to)}.</span>
            {r.ready ? <span>Marked ready by {r.ready.by} on {date(r.ready.at.slice(0, 10))}.</span> : <span>Checks are worked out from the books each time you open this page.</span>}
          </div>
          {r.ready && r.ready.changedSince.length ? (
            <div className="mb-4"><Alert tone="warning" title="The books changed after marking ready">These checks are not as they were then: {r.ready.changedSince.join(', ')}.</Alert></div>
          ) : null}
          {r.reopened && !isReady ? (
            <div className="mb-4"><Alert tone="neutral" title="Reopened">Reopened by {r.reopened.by} on {date(r.reopened.at.slice(0, 10))}: {r.reopened.reason}</Alert></div>
          ) : null}

          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Ready" value={String(r.summary.ready)} tone="positive" />
            <Stat label="Needs attention" value={String(r.summary.attention)} tone={r.summary.attention ? 'warning' : 'positive'} sub="Fix or explain in a note" />
            <Stat label="Missing" value={String(r.summary.missing)} tone={r.summary.missing ? 'negative' : 'positive'} sub="Fix before the audit" />
            <Stat label="Does not apply" value={String(r.summary.notApplicable)} />
          </div>

          <Card className="mb-4">
            <CardHeader title="Readiness checks" description="Each check from the books for the year, with your note for the auditor. A note goes into the checklist the auditor gets." />
            <ErrorAlert title="Note not saved" error={note.error} />
            <Table aria-label="Readiness checks" className="[&_td]:align-top">
              <thead><Tr><Th>Check</Th><Th>Status</Th><Th>What the books show</Th><Th>Note for the auditor</Th></Tr></thead>
              <tbody>
                {r.checks.map((c) => (
                  <Tr key={c.key}>
                    <Td>
                      <div className="font-medium">{c.title}</div>
                      {c.reference ? <div className="text-xs text-fg-muted">{c.reference}</div> : null}
                    </Td>
                    <Td><Badge className="whitespace-nowrap" tone={TONE[c.status]}>{LABEL[c.status]}</Badge></Td>
                    <Td>
                      <div>{c.detail}</div>
                      {c.items.length ? <ul className="mt-1 list-disc pl-5 text-xs text-fg-muted">{c.items.map((i) => <li key={i}>{i}</li>)}</ul> : null}
                      {c.status === 'MISSING' || c.status === 'ATTENTION' ? <Link className="text-xs underline" href={`/orgs/${orgId}${FIX[c.key]!.href}`}>Open {FIX[c.key]!.label}</Link> : null}
                    </Td>
                    <Td className="min-w-64">
                      {editing?.key === c.key ? (
                        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); note.mutate(editing); }}>
                          <Textarea aria-label={`Note on ${c.title}`} rows={3} maxLength={2000} value={editing.text} onChange={(e) => setEditing({ key: c.key, text: e.target.value })} />
                          <span className="flex gap-2">
                            <Button type="submit" size="sm" variant="secondary" loading={note.isPending}>Save note</Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                          </span>
                        </form>
                      ) : (
                        <>
                          {c.note ? <div><div className="whitespace-pre-wrap">{c.note.text}</div><div className="text-xs text-fg-muted">{c.note.by}, {date(c.note.at.slice(0, 10))}</div></div> : <span className="text-fg-muted">{c.status === 'ATTENTION' ? 'Needs a note or a fix' : '—'}</span>}
                          {canManage && !isReady && c.status !== 'NOT_APPLICABLE' ? (
                            <Button size="sm" variant="ghost" aria-label={`${c.note ? 'Edit' : 'Add'} note on ${c.title}`} onClick={() => setEditing({ key: c.key, text: c.note?.text ?? '' })}>{c.note ? 'Edit note' : 'Add note'}</Button>
                          ) : null}
                        </>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {!isReady ? (
            <Card>
              <CardHeader title="Before it goes to the auditor" description="Nothing may be missing, and everything needing attention needs a note or a fix, before the year can be marked ready." />
              {r.blockers.length ? (
                <ul aria-label="What stops the year being ready" className="list-disc px-8 py-4 text-sm">{r.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              ) : (
                <p className="px-4 py-4 text-sm">Nothing stops it: the year can be marked ready for the auditor.</p>
              )}
            </Card>
          ) : null}

          {confirming ? (
            <Dialog open onOpenChange={(o) => !o && setConfirming(false)} title={`Mark ${r.taxYear} ready for the auditor?`} description="The checks are kept as they are now and the notes are frozen. If the books change later the page shows which checks moved; reopen to change notes.">
              <ErrorAlert title="Not marked ready" error={ready.error} />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                <Button loading={ready.isPending} onClick={() => ready.mutate()}>Mark ready</Button>
              </div>
            </Dialog>
          ) : null}
          {reopening !== null ? (
            <Dialog open onOpenChange={(o) => !o && setReopening(null)} title={`Reopen ${r.taxYear}?`} description="The year goes back to being prepared and the notes can be changed. Say why for the record.">
              <ErrorAlert title="Not reopened" error={reopen.error} />
              <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); reopen.mutate(reopening); }}>
                <Field label="Why reopen">{(p) => <Input {...p} maxLength={500} value={reopening} onChange={(e) => setReopening(e.target.value)} />}</Field>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setReopening(null)}>Cancel</Button>
                  <Button type="submit" disabled={reopening.trim().length < 3} loading={reopen.isPending}>Reopen</Button>
                </div>
              </form>
            </Dialog>
          ) : null}
        </>
      ) : null}
    </>
  );
}
