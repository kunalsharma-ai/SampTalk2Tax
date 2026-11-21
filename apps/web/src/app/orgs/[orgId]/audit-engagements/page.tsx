'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ENGAGEMENT_STATUS, type Engagement, type EngagementSummary } from '@/components/controls/engagements';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface List {
  engagements: EngagementSummary[];
  members: { id: string; name: string }[];
  reviewers: { id: string; name: string }[];
}

/** Internal audit workspace (AUDIT-001): audit engagements, each with a lead, a reviewer and a work programme. */
export default function AuditEngagementsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({ queryKey: ['audit-engagements', orgId], queryFn: () => api<List>(`/v1/orgs/${orgId}/audit-engagements`) });
  const t = today();
  const [form, setForm] = useState({ name: '', objective: '', scopeFrom: `${t.slice(0, 7)}-01`, scopeTo: t, leadId: '', reviewerId: '' });
  const start = useMutation({
    mutationFn: () => api<Engagement>(`/v1/orgs/${orgId}/audit-engagements`, { method: 'POST', body: form }),
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: ['audit-engagements', orgId] });
      router.push(`/orgs/${orgId}/audit-engagements/${e.id}`);
    },
  });
  if (!org) return null;
  const d = q.data;
  const ready = form.name.trim() && form.objective.trim().length >= 10 && form.scopeFrom && form.scopeTo && form.leadId && form.reviewerId && form.leadId !== form.reviewerId;
  return (
    <>
      <PageHeader title="Internal audit" description="Plan and run internal audits: a scope, a lead who does the work with the team, and a reviewer who signs it off. Samples and findings are linked to the audit that uses them." />
      <ErrorAlert title="Could not load" error={q.error} />
      {d ? (
        <>
          <Card className="mb-4">
            <CardHeader title="Audit engagements" description="Newest first. Yours are the ones you lead, review or have steps to do on." />
            {!d.engagements.length ? (
              <EmptyState title="No internal audits yet">Start one below.</EmptyState>
            ) : (
              <Table aria-label="Audit engagements">
                <thead><Tr><Th>Ref</Th><Th>Engagement</Th><Th>Lead and reviewer</Th><Th>Steps</Th><Th>Status</Th></Tr></thead>
                <tbody>
                  {d.engagements.map((e) => (
                    <Tr key={e.id}>
                      <Td className="num">{e.reference}</Td>
                      <Td>
                        <Link className="hover:text-accent" href={`/orgs/${orgId}/audit-engagements/${e.id}`}>{e.name}</Link>
                        <div className="text-xs text-fg-muted">{date(e.scopeFrom)} to {date(e.scopeTo)}{e.mine ? ' · yours' : ''}</div>
                      </Td>
                      <Td className="text-sm">{e.lead.name}<div className="text-xs text-fg-muted">Reviewed by {e.reviewer.name}</div></Td>
                      <Td className="text-sm">{e.progress.signedOff} of {e.progress.steps} signed off</Td>
                      <Td><Badge tone={ENGAGEMENT_STATUS[e.status].tone}>{ENGAGEMENT_STATUS[e.status].label}</Badge></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Start an engagement" description="The reviewer must be someone who can approve, and not the lead." />
            <form
              className="flex flex-col gap-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                start.mutate();
              }}
            >
              <Field label="Engagement name">{(p) => <Input {...p} maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Such as Q2 payments audit" />}</Field>
              <Field label="Objective" hint="What the audit sets out to check">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} />}</Field>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Scope from">{(p) => <Input {...p} type="date" value={form.scopeFrom} onChange={(e) => setForm({ ...form, scopeFrom: e.target.value })} />}</Field>
                <Field label="Scope to">{(p) => <Input {...p} type="date" value={form.scopeTo} onChange={(e) => setForm({ ...form, scopeTo: e.target.value })} />}</Field>
                <Field label="Lead">{(p) => <Select {...p} value={form.leadId} onChange={(e) => setForm({ ...form, leadId: e.target.value })}><option value="">Choose…</option>{d.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
                <Field label="Reviewer">{(p) => <Select {...p} value={form.reviewerId} onChange={(e) => setForm({ ...form, reviewerId: e.target.value })}><option value="">Choose…</option>{d.reviewers.filter((m) => m.id !== form.leadId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
              </div>
              <div><Button type="submit" size="sm" disabled={!ready} loading={start.isPending}>Start engagement</Button></div>
              <ErrorAlert title="The engagement was not started" error={start.error} />
            </form>
          </Card>
        </>
      ) : null}
    </>
  );
}
