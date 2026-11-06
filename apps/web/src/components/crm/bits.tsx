'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEAL_STAGE_LABEL, LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, Field, Select, Textarea } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import type { Activity, DealStage, LeadStatus } from '@/lib/crm';
import { dateTime, money } from '@/lib/format';

const STAGE_TONE: Record<DealStage, 'neutral' | 'accent' | 'violet' | 'warning' | 'positive' | 'negative'> = { PROSPECTING: 'neutral', QUALIFICATION: 'accent', PROPOSAL: 'violet', NEGOTIATION: 'warning', WON: 'positive', LOST: 'negative' };
const STATUS_TONE: Record<LeadStatus, 'neutral' | 'accent' | 'positive' | 'negative' | 'violet'> = { NEW: 'accent', CONTACTED: 'neutral', QUALIFIED: 'violet', DISQUALIFIED: 'negative', CONVERTED: 'positive' };

export const StageBadge = ({ stage }: { stage: DealStage }) => <Badge tone={STAGE_TONE[stage]}>{DEAL_STAGE_LABEL[stage]}</Badge>;
export const LeadStatusBadge = ({ status }: { status: LeadStatus }) => <Badge tone={STATUS_TONE[status]}>{LEAD_STATUS_LABEL[status]}</Badge>;

const KIND_LABEL: Record<Activity['kind'], string> = { CREATED: 'Created', NOTE: 'Note', CALL: 'Call', EMAIL: 'Email', MEETING: 'Meeting', STATUS_CHANGED: 'Status changed', STAGE_CHANGED: 'Stage changed', CONVERTED: 'Converted', UPDATED: 'Edited' };
const FIELD_LABEL: Record<string, string> = { name: 'name', company: 'company', email: 'email', phone: 'phone', source: 'source', ownerId: 'owner', estimatedValue: 'estimated value', notes: 'notes', contactId: 'customer', amount: 'amount', expectedCloseDate: 'expected close date' };

/** One line saying what a recorded change did. */
function describe(a: Activity, currency: string): string | null {
  const d = (a.data ?? {}) as Record<string, unknown>;
  switch (a.kind) {
    case 'CREATED':
      return d.fromLead ? `Opened from lead ${String(d.fromLead)}` : d.source ? `Source: ${LEAD_SOURCE_LABEL[d.source as keyof typeof LEAD_SOURCE_LABEL] ?? String(d.source)}` : d.stage ? `At ${DEAL_STAGE_LABEL[d.stage as DealStage]}, ${String(d.probability ?? '')}%` : null;
    case 'STATUS_CHANGED':
      return `${LEAD_STATUS_LABEL[d.from as LeadStatus]} → ${LEAD_STATUS_LABEL[d.to as LeadStatus]}`;
    case 'STAGE_CHANGED': {
      const from = DEAL_STAGE_LABEL[d.from as DealStage];
      const to = DEAL_STAGE_LABEL[d.to as DealStage];
      return `${d.reopened ? 'Reopened: ' : ''}${from === to ? `${to}, probability ${String(d.probabilityFrom)}% → ${String(d.probability)}%` : `${from} → ${to} (${String(d.probability)}%)`}`;
    }
    case 'CONVERTED':
      return `${d.createdContact ? 'Created a new customer' : 'Attached to an existing contact'}${d.dealId ? ' and opened a deal' : ''}`;
    case 'UPDATED': {
      const fields = (d.fields as string[] | undefined) ?? [];
      const amt = d.amount as { from: string; to: string } | undefined;
      return `Changed ${fields.map((f) => FIELD_LABEL[f] ?? f).join(', ')}${amt ? ` (${money(amt.from, currency)} → ${money(amt.to, currency)})` : ''}`;
    }
    default:
      return null;
  }
}

/** The timeline of a lead or deal, with a form to log a note, call, email or meeting. */
export function Timeline({ orgId, target, activities, canLog, currency, queryKey }: { orgId: string; target: { leadId: string } | { dealId: string }; activities: Activity[]; canLog: boolean; currency: string; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'NOTE' | 'CALL' | 'EMAIL' | 'MEETING'>('CALL');
  const [body, setBody] = useState('');
  const log = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/crm/activities`, { method: 'POST', body: { ...target, kind, body } }),
    onSuccess: async () => {
      setBody('');
      await qc.invalidateQueries({ queryKey });
    },
  });
  return (
    <Card>
      <CardHeader title="Activity" description="Calls, emails, meetings and notes, and every change to this record. Nothing here can be edited or removed." />
      {canLog ? (
        <form
          className="grid gap-3 border-b border-line px-5 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            log.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <Field label="Kind">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="CALL">Call</option><option value="EMAIL">Email</option><option value="MEETING">Meeting</option><option value="NOTE">Note</option></Select>}</Field>
            <Field label="What happened">{(p) => <Textarea {...p} rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Spoke to the finance head; wants a proposal by Friday." />}</Field>
          </div>
          <ErrorAlert title="Could not log it" error={log.error} />
          <div><Button type="submit" size="sm" loading={log.isPending} disabled={!body.trim()}>Log activity</Button></div>
        </form>
      ) : null}
      <ol className="divide-y divide-line" aria-label="Activity timeline">
        {activities.map((a) => {
          const line = describe(a, currency);
          return (
            <li key={a.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-fg">{KIND_LABEL[a.kind]}</span>
                <span className="text-xs text-fg-faint">{a.actor?.name ?? 'Someone'} · {dateTime(a.createdAt)}</span>
              </div>
              {line ? <p className="text-fg-muted">{line}</p> : null}
              {a.body ? <p className="mt-0.5 whitespace-pre-wrap text-fg">{a.body}</p> : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
