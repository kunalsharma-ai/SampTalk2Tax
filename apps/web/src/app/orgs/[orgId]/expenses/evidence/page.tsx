'use client';
import { useQuery } from '@tanstack/react-query';
import { EXPENSE_EVIDENCE_KINDS, EXPENSE_EVIDENCE_LABEL, type EvidenceState, type ExpenseEvidenceKind } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

export interface EvidenceItemView {
  kind: ExpenseEvidenceKind;
  label: string;
  state: EvidenceState;
  detail: string;
}
interface Row {
  id: string;
  number: string;
  title: string;
  claimant: string;
  status: string;
  total: string;
  approvedOn: string | null;
  complete: boolean;
  gaps: ExpenseEvidenceKind[];
  items: EvidenceItemView[];
  files: number;
  events: number;
}
interface Evidence {
  from: string;
  to: string;
  currency: string;
  summary: { claims: number; complete: number; withGaps: number; gaps: Record<ExpenseEvidenceKind, number>; files: number };
  claims: Row[];
}

const STATE_TONE: Record<EvidenceState, 'positive' | 'accent' | 'negative' | 'warning' | 'neutral'> = { OK: 'positive', NOTED: 'accent', GAP: 'negative', PENDING: 'warning', NA: 'neutral' };
const STATE_LABEL: Record<EvidenceState, string> = { OK: 'OK', NOTED: 'Noted', GAP: 'Gap', PENDING: 'Pending', NA: 'n/a' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Automated audit evidence for expense claims (EXP-027). */
export default function ExpenseEvidencePage() {
  const { orgId } = useOrg();
  const [form, setForm] = useState({ from: '', to: '' });
  const [asked, setAsked] = useState({ from: '', to: '' });
  const [gapsOnly, setGapsOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const qs = [asked.from ? `from=${asked.from}` : '', asked.to ? `to=${asked.to}` : ''].filter(Boolean).join('&');
  const q = useQuery({ queryKey: ['expense-evidence', orgId, qs, gapsOnly], queryFn: () => api<Evidence>(`/v1/orgs/${orgId}/expense-evidence?${[qs, gapsOnly ? 'gapsOnly=true' : ''].filter(Boolean).join('&')}`) });
  const d = q.data;
  const download = async () => {
    setBusy(true);
    try {
      const x = await api<{ fileName: string; csv: string }>(`/v1/orgs/${orgId}/expense-evidence/export?${qs}`);
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
        title="Expense audit evidence"
        description="For every expense claim approved, paid or voided in the period, the evidence an auditor asks for, collected from the records: receipts with their checksums, the approval, policy exceptions and their notes, the journal entries, the reimbursement, its bank statement match and the audit trail. Gaps are what is missing."
        actions={<Button variant="secondary" size="sm" loading={busy} disabled={!d} onClick={() => void download()}>Download evidence index (CSV)</Button>}
      />
      <Card className="mb-4">
        <CardHeader title="Claims to collect" description="Claims whose journal date falls in the period; the 90 days to today when left blank." />
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(form);
          }}
        >
          <Field label="From">{(p) => <Input {...p} type="date" className="w-44" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
          <Field label="To">{(p) => <Input {...p} type="date" className="w-44" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
          <Button type="submit" size="sm" disabled={(!!form.from && !ISO.test(form.from)) || (!!form.to && !ISO.test(form.to))} loading={q.isFetching}>Collect evidence</Button>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={gapsOnly} onChange={(e) => setGapsOnly(e.target.checked)} /> Only claims with gaps</label>
        </form>
      </Card>
      <ErrorAlert title="Could not collect the evidence" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Claims" value={d.summary.claims} sub={`${date(d.from)} to ${date(d.to)}`} />
            <Stat label="Complete" value={d.summary.complete} tone="positive" />
            <Stat label="With gaps" value={d.summary.withGaps} tone={d.summary.withGaps ? 'negative' : 'positive'} sub={EXPENSE_EVIDENCE_KINDS.filter((k) => d.summary.gaps[k]).map((k) => `${EXPENSE_EVIDENCE_LABEL[k]} ${d.summary.gaps[k]}`).join(', ') || 'None'} />
            <Stat label="Receipt files" value={d.summary.files} sub="Each with its SHA-256" />
          </div>
          <Card>
            <CardHeader title="Evidence by claim" description="One column per kind of evidence. Open a claim for its evidence pack." />
            {!d.claims.length ? (
              <EmptyState title={gapsOnly ? 'No gaps' : 'No claims'}>{gapsOnly ? 'Every claim in the period has its evidence.' : 'No expense claim was approved, paid or voided in the period.'}</EmptyState>
            ) : (
              <Table aria-label="Evidence by claim">
                <thead><Tr><Th>Claim</Th><Th>Claimant</Th><Th numeric>Total</Th>{EXPENSE_EVIDENCE_KINDS.map((k) => <Th key={k}>{EXPENSE_EVIDENCE_LABEL[k]}</Th>)}</Tr></thead>
                <tbody>
                  {d.claims.map((c) => (
                    <Tr key={c.id}>
                      <Td className="whitespace-nowrap">
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/evidence/${c.id}`}>{c.number}</Link>
                        <div className="text-xs text-fg-muted">{c.status === 'VOID' ? 'Void' : c.status === 'REIMBURSED' ? 'Reimbursed' : 'Approved'}{c.approvedOn ? ` · ${date(c.approvedOn)}` : ''}</div>
                      </Td>
                      <Td>{c.claimant}</Td>
                      <Td numeric><Money value={c.total} currency={d.currency} /></Td>
                      {c.items.map((i) => (
                        <Td key={i.kind}><span title={i.detail}><Badge tone={STATE_TONE[i.state]}>{STATE_LABEL[i.state]}</Badge></span></Td>
                      ))}
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
