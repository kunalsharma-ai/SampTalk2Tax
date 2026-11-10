import { D, type Dec } from '@talk2tax/accounting-engine';
type Document = Record<string, unknown>;
import type { DocumentStoreService } from '../common/document-store.service';
import { runInOrg } from '../common/tenant-context';
import { journalEntries } from './collections/ledger';

/**
 * Sums of journal lines, read from MongoDB, where the entries keep their lines inside them.
 * They replace the SQL reports that joined journal_lines to journal_entries.
 *
 * `entry` filters the entries (their own fields: `status`, `date`, `type`, `periodId`, ...),
 * `line` filters the lines (`accountId`, `departmentId`, `projectId`, ...), and `by` names the
 * groups: each key is an output name and its value an entry field or `lines.<field>`.
 */
export interface LineSumQuery {
  entry?: Document;
  line?: Document;
  by: Record<string, string>;
}

export interface LineSum {
  key: Record<string, unknown>;
  /** Functional-currency sums. */
  debit: Dec;
  credit: Dec;
  /** Transaction-currency sums. */
  txDebit: Dec;
  txCredit: Dec;
  lines: number;
}

const prefixed = (d: Document) => Object.fromEntries(Object.entries(d).map(([k, v]) => [`lines.${k}`, v]));

export async function lineSums(store: DocumentStoreService, orgId: string, q: LineSumQuery): Promise<LineSum[]> {
  const pipeline: Document[] = [];
  const entryMatch: Document = { ...(q.entry ?? {}) };
  // Narrow to entries with a matching line before unwinding, so the index on lines.accountId serves.
  if (q.line && Object.keys(q.line).length) entryMatch.lines = { $elemMatch: q.line };
  if (Object.keys(entryMatch).length) pipeline.push({ $match: entryMatch });
  pipeline.push({ $unwind: '$lines' });
  if (q.line && Object.keys(q.line).length) pipeline.push({ $match: prefixed(q.line) });
  pipeline.push({
    $group: {
      _id: Object.fromEntries(Object.entries(q.by).map(([k, f]) => [k, `$${f}`])),
      debit: { $sum: '$lines.functionalDebit' },
      credit: { $sum: '$lines.functionalCredit' },
      txDebit: { $sum: '$lines.debit' },
      txCredit: { $sum: '$lines.credit' },
      lines: { $sum: 1 },
    },
  });
  const rows = await runInOrg(orgId, () => store.collection(journalEntries).aggregate<{ _id: Record<string, unknown>; debit: string; credit: string; txDebit: string; txCredit: string; lines: number }>(pipeline));
  return rows.map((r) => ({
    key: Object.fromEntries(Object.keys(q.by).map((k) => [k, r._id?.[k] ?? null])),
    debit: new D(String(r.debit ?? '0')),
    credit: new D(String(r.credit ?? '0')),
    txDebit: new D(String(r.txDebit ?? '0')),
    txCredit: new D(String(r.txCredit ?? '0')),
    lines: r.lines,
  }));
}

/** Entry filter for a date range of posted entries (`from` and `to` inclusive, either open). */
export function postedBetween(from: Date | null, to: Date | null, opts: { excludeClosing?: boolean } = {}): Document {
  const date: Document = {};
  if (from) date.$gte = from;
  if (to) date.$lte = to;
  return { status: 'POSTED', ...(Object.keys(date).length ? { date } : {}), ...(opts.excludeClosing ? { type: { $ne: 'CLOSING' } } : {}) };
}
