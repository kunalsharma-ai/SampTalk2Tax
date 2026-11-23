'use client';
import { useQuery } from '@tanstack/react-query';
import { HISTORY_RELATION_LABEL, type HistoryRelation, type TransactionKind } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader } from '@talk2tax/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface HistoryEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  title: string;
  relation: HistoryRelation;
  facts: { key: string; value: string }[];
  changes: { field: string; from: string | null; to: string | null }[];
  intact: boolean;
}
interface History {
  label: string;
  truncated: boolean;
  summary: { events: number; people: number; first: string | null; last: string | null; tampered: string[] };
  events: HistoryEvent[];
}
const FACT_LABEL: Record<string, string> = { number: 'Number', amount: 'Amount', total: 'Total', reason: 'Reason', note: 'Note', date: 'Date', fileName: 'File', outcome: 'Outcome', percent: 'Percent', entryNumber: 'Entry', reference: 'Reference' };
const TONE: Record<HistoryRelation, 'neutral' | 'accent' | 'positive' | 'warning'> = { RECORD: 'accent', ALLOCATION: 'positive', FILE: 'neutral', JOURNAL: 'warning' };
const SHOW_FIRST = 8;

/**
 * Transaction history (AUDIT-005): the record's audit trail with its allocations, files and journal
 * entries, oldest first. For those who can read the audit trail; an altered event is flagged.
 */
export function TransactionHistoryCard({ kind, id }: { kind: TransactionKind; id: string }) {
  const { org, orgId } = useOrg();
  const allowed = can(org?.role, 'audit.read');
  const [all, setAll] = useState(false);
  const q = useQuery({ enabled: allowed, queryKey: ['transaction-history', orgId, kind, id], queryFn: () => api<History>(`/v1/orgs/${orgId}/transaction-history/${kind}/${id}`) });
  if (!allowed) return null;
  const h = q.data;
  const events = h ? (all ? h.events : h.events.slice(-SHOW_FIRST)) : [];
  return (
    <Card className="mt-6" role="region" aria-label="Transaction history">
      <CardHeader
        title="Transaction history"
        description={h ? `${h.summary.events} ${h.summary.events === 1 ? 'event' : 'events'} by ${h.summary.people} ${h.summary.people === 1 ? 'person' : 'people'}, from the audit trail: this record, money applied to it, its files and its journal entries.` : 'Every change to this record and what hangs off it, from the audit trail.'}
        actions={h && h.events.length > SHOW_FIRST ? <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? 'Show latest only' : `Show all ${h.events.length}`}</Button> : undefined}
      />
      {q.error ? <div className="px-5 pb-4"><Alert title="Could not load the history">{(q.error as Error).message}</Alert></div> : null}
      {h?.summary.tampered.length ? (
        <div className="px-5 pt-4">
          <Alert tone="negative" title="Altered events">{h.summary.tampered.length === 1 ? 'One event' : `${h.summary.tampered.length} events`} no longer match what was recorded. Verify the audit trail and investigate.</Alert>
        </div>
      ) : null}
      {h ? (
        <ol className="divide-y divide-line px-5 pb-4 text-sm" aria-label="History events">
          {!all && h.events.length > SHOW_FIRST ? <li className="py-2 text-xs text-fg-muted">{h.events.length - SHOW_FIRST} earlier events hidden.</li> : null}
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start gap-3 py-2.5">
              <span className="w-40 shrink-0 text-xs text-fg-muted">{new Date(e.at).toLocaleString()}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{e.title}</span> <span className="text-fg-muted">by {e.actor}</span>{' '}
                <Badge tone={TONE[e.relation]}>{HISTORY_RELATION_LABEL[e.relation]}</Badge>
                {!e.intact ? <> <Badge tone="negative">Altered</Badge></> : null}
                {e.facts.length ? <span className="block text-xs text-fg-muted">{e.facts.map((f) => `${FACT_LABEL[f.key] ?? f.key}: ${f.value}`).join(' · ')}</span> : null}
                {e.changes.length ? (
                  <span className="block text-xs text-fg-muted">{e.changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join(' · ')}</span>
                ) : null}
              </span>
            </li>
          ))}
          {!h.events.length ? <li className="py-2 text-fg-muted">Nothing recorded yet.</li> : null}
          {h.truncated ? <li className="py-2 text-xs text-fg-muted">Only the first 2,000 events are shown.</li> : null}
        </ol>
      ) : null}
    </Card>
  );
}
