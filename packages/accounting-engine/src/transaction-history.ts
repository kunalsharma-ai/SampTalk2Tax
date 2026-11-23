/**
 * Transaction history (AUDIT-005). One transaction's life as the audit trail recorded it: the
 * events on the record itself and on what hangs off it (allocations of money to or from it, files
 * attached to it, journal entries it posted), oldest first, each in words, with the fields an
 * event changed and whether the event is still exactly as it was written.
 */
export const TRANSACTION_KINDS = ['document', 'payment', 'journal_entry', 'expense_claim'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** How an event is related to the transaction asked about. */
export type HistoryRelation = 'RECORD' | 'ALLOCATION' | 'FILE' | 'JOURNAL';
export const HISTORY_RELATION_LABEL: Record<HistoryRelation, string> = { RECORD: 'This record', ALLOCATION: 'Money applied', FILE: 'Files', JOURNAL: 'Journal entry' };

const TITLES: Record<string, string> = {
  'document.draft_created': 'Draft created',
  'document.draft_updated': 'Draft changed',
  'document.draft_deleted': 'Draft deleted',
  'document.posted': 'Posted to the books',
  'document.voided': 'Voided',
  'document.credit_limit_overridden': 'Credit limit overridden',
  'document.template_set': 'Invoice template changed',
  'document.signed': 'Signed',
  'document.signature_withdrawn': 'Signature withdrawn',
  'payment.recorded': 'Payment recorded',
  'payment.voided': 'Payment voided',
  'allocation.created': 'Money applied',
  'allocation.removed': 'Money unapplied',
  'attachment.added': 'File attached',
  'attachment.removed': 'File removed',
  'attachment.new_version': 'New file version',
  'journal.system_posted': 'Journal entry posted',
  'journal.system_reversed': 'Journal entry reversed',
  'journal.draft_updated': 'Journal draft changed',
  'journal.posted': 'Journal posted',
  'journal.reversed': 'Journal reversed',
  'expense_claim.created': 'Claim created',
  'expense_claim.updated': 'Claim changed',
  'expense_claim.submitted': 'Submitted for approval',
  'expense_claim.withdrawn': 'Withdrawn',
  'expense_claim.approved': 'Approved',
  'expense_claim.rejected': 'Rejected',
  'expense_claim.reimbursed': 'Paid back',
  'expense_claim.voided': 'Voided',
  'expense_claim.deleted': 'Draft deleted',
  'expense_claim.receipt_requested': 'Receipt asked for',
};

/** A readable title for an audit action: known ones by name, others from the action itself. */
export function historyTitle(action: string): string {
  const known = TITLES[action];
  if (known) return known;
  const last = action.split('.').pop() ?? action;
  const words = last.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : action;
}

const SHOWN = ['number', 'amount', 'total', 'reason', 'note', 'date', 'fileName', 'outcome', 'percent', 'entryNumber', 'reference'] as const;

/** The plain facts an event carries worth showing in a line ("amount 1500.00, reason ..."). */
export function historyFacts(data: unknown): { key: string; value: string }[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const d = data as Record<string, unknown>;
  return SHOWN.filter((k) => d[k] != null && (typeof d[k] === 'string' || typeof d[k] === 'number')).map((k) => ({ key: k, value: String(d[k]) }));
}

/** The fields an event changed, where it recorded them as { from, to } (or { before, after }). */
export function historyChanges(data: unknown): { field: string; from: string | null; to: string | null }[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: { field: string; from: string | null; to: string | null }[] = [];
  const show = (v: unknown) => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      if ('from' in o && 'to' in o) out.push({ field: prefix + k, from: show(o.from), to: show(o.to) });
      else if ('before' in o && 'after' in o) out.push({ field: prefix + k, from: show(o.before), to: show(o.after) });
      else if (!prefix) walk(o, `${k}.`);
    }
  };
  walk(data as Record<string, unknown>, '');
  return out;
}

export interface HistoryEventInput {
  id: string;
  at: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  data: unknown;
  relation: HistoryRelation;
  /** Whether the event's hash still matches what it records. */
  intact: boolean;
}

/** The timeline: oldest first (by the audit trail's own order), each event described, with a summary. */
export function transactionTimeline(events: readonly HistoryEventInput[]) {
  const seen = new Set<string>();
  const list = events
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
    .map((e) => ({ ...e, title: historyTitle(e.action), facts: historyFacts(e.data), changes: historyChanges(e.data) }));
  const people = new Set(list.map((e) => e.actorId).filter((x): x is string => !!x));
  return {
    events: list,
    summary: {
      events: list.length,
      people: people.size,
      first: list[0]?.at ?? null,
      last: list[list.length - 1]?.at ?? null,
      tampered: list.filter((e) => !e.intact).map((e) => e.id),
    },
  };
}
