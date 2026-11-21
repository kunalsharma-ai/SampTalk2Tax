'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { FINDING_STATUS, SEVERITY, type Finding } from '@/components/controls/findings';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface List {
  findings: Finding[];
  summary: { open: number; overdue: number; high: number; readyForReview: number };
  members: { id: string; name: string }[];
  daysToFix: Record<string, number>;
}

/** Audit findings (AUDIT-011, AUDIT-012): what needs fixing, who fixes it, and by when. */
function Findings() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const testId = useSearchParams().get('testId');
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['audit-findings', orgId], queryFn: () => api<List>(`/v1/orgs/${orgId}/audit-findings`) });
  const [form, setForm] = useState({ title: '', description: '', severity: 'MEDIUM', ownerId: '', plan: '', dueDate: '' });
  const raise = useMutation({
    mutationFn: () =>
      api<Finding>(`/v1/orgs/${orgId}/audit-findings`, {
        method: 'POST',
        body: { ...(testId ? { testId } : { title: form.title, description: form.description }), severity: form.severity, ownerId: form.ownerId, plan: form.plan, ...(form.dueDate ? { dueDate: form.dueDate } : {}) },
      }),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ['audit-findings', orgId] });
      router.push(`/orgs/${orgId}/audit-findings/${f.id}`);
    },
  });
  if (!org) return null;
  const d = q.data;
  const shown = d ? d.findings.filter((f) => !status || f.status === status) : [];
  const ready = (testId || (form.title.trim() && form.description.trim())) && form.ownerId && form.plan.trim().length >= 10;
  return (
    <>
      <PageHeader title="Audit findings" description="Problems found by control tests or reviews, each with someone to fix it, a plan and a due date. Someone other than that person closes it." />
      <ErrorAlert title="Could not load" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-4">
            <Stat label="Open findings" value={d.summary.open} tone={d.summary.open ? 'warning' : 'positive'} />
            <Stat label="Overdue" value={d.summary.overdue} tone={d.summary.overdue ? 'negative' : 'neutral'} />
            <Stat label="High severity open" value={d.summary.high} tone={d.summary.high ? 'negative' : 'neutral'} />
            <Stat label="Ready for review" value={d.summary.readyForReview} sub="Waiting to be closed" />
          </div>
          <Card className="mb-4">
            <CardHeader
              title="Findings"
              description="Ready for review first, then in progress and open"
              actions={
                <Select aria-label="Show" className="w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">All findings</option>
                  {Object.entries(FINDING_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
              }
            />
            {!shown.length ? (
              <EmptyState title="No findings">Raise one below, or from a failed control test.</EmptyState>
            ) : (
              <Table aria-label="Audit findings">
                <thead><Tr><Th>Ref</Th><Th>Finding</Th><Th>Severity</Th><Th>Remediation owner</Th><Th>Due</Th><Th>Status</Th></Tr></thead>
                <tbody>
                  {shown.map((f) => (
                    <Tr key={f.id}>
                      <Td className="num">{f.reference}</Td>
                      <Td><Link className="hover:text-accent" href={`/orgs/${orgId}/audit-findings/${f.id}`}>{f.title}</Link>{f.control ? <div className="text-xs text-fg-muted">From {f.control.title}</div> : null}</Td>
                      <Td><Badge tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Badge></Td>
                      <Td>{f.owner.name}</Td>
                      <Td className="whitespace-nowrap">{date(f.dueDate)}{f.overdue ? <div><Badge tone="negative">Overdue</Badge></div> : null}</Td>
                      <Td><Badge tone={FINDING_STATUS[f.status].tone}>{FINDING_STATUS[f.status].label}</Badge></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title={testId ? 'Raise a finding from the failed test' : 'Raise a finding'} description={testId ? 'The title and what was found come from the test and its exceptions.' : 'Something that needs fixing, found in a review or day to day'} />
            <form
              className="flex flex-col gap-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                raise.mutate();
              }}
            >
              {!testId ? (
                <>
                  <Field label="Finding title">{(p) => <Input {...p} maxLength={140} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
                  <Field label="What was found">{(p) => <Textarea {...p} rows={3} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
                </>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Severity">
                  {(p) => (
                    <Select {...p} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                      {Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v.label} ({d.daysToFix[k]} days to fix)</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Remediation owner">
                  {(p) => (
                    <Select {...p} value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
                      <option value="">Choose a member…</option>
                      {d.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Due date" hint="Blank: worked out from the severity">{(p) => <Input {...p} type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />}</Field>
              </div>
              <Field label="Remediation plan">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} placeholder="How it will be fixed, in at least 10 characters" />}</Field>
              <div><Button type="submit" size="sm" disabled={!ready} loading={raise.isPending}>Raise finding</Button></div>
              <ErrorAlert title="The finding was not raised" error={raise.error} />
            </form>
          </Card>
        </>
      ) : null}
    </>
  );
}

export default function AuditFindingsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-fg-muted">Loading…</p>}>
      <Findings />
    </Suspense>
  );
}
