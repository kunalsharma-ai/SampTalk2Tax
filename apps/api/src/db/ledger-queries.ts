import { D, type Dec } from '@talk2tax/accounting-engine';
import type { Prisma } from '@talk2tax/database';
import type { PrismaService, Tx } from '../common/prisma.service';
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
 * groups: each key is an output name and its value an entry field or `lines.<field>`. An entry's
 * own id is `_id` here (MongoDB's key), a line's is `lines.id`.
 */
export interface LineSumQuery {
  entry?: Document;
  line?: Document;
  /** Output name → an entry field, `lines.<field>`, or a MongoDB expression (such as `{ $dateTrunc: ... }`). */
  by: Record<string, string | Document>;
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
      _id: Object.fromEntries(Object.entries(q.by).map(([k, f]) => [k, typeof f === 'string' ? `$${f}` : f])),
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

/** Groups by the calendar month of the entry date (UTC midnight dates, so the first of the month). */
export const entryMonth: Document = { $dateTrunc: { date: '$date', unit: 'month' } };

/** Entry filter for a date range of posted entries (`from` and `to` inclusive, either open). */
export function postedBetween(from: Date | null, to: Date | null, opts: { excludeClosing?: boolean } = {}): Document {
  const date: Document = {};
  if (from) date.$gte = from;
  if (to) date.$lte = to;
  return { status: 'POSTED', ...(Object.keys(date).length ? { date } : {}), ...(opts.excludeClosing ? { type: { $ne: 'CLOSING' } } : {}) };
}

/** One journal line with its entry's fields, as the SQL joins of journal_lines and journal_entries returned them. */
export interface LedgerLine {
  id: string;
  entry_id: string;
  entry_number: number | null;
  date: Date;
  memo: string | null;
  reference: string | null;
  description: string | null;
  source: string;
  status: string;
  reverses_entry_id: string | null;
  account_id: string;
  /** Functional debit less credit. */
  net: Dec;
}

/** Journal lines matching `line` on entries matching `entry`, ordered by entry date and number (PostgreSQL's NULLs last). */
export async function ledgerLines(store: DocumentStoreService, orgId: string, q: { entry?: Document; line?: Document }): Promise<LedgerLine[]> {
  const pipeline: Document[] = [];
  const entryMatch: Document = { ...(q.entry ?? {}) };
  if (q.line && Object.keys(q.line).length) entryMatch.lines = { $elemMatch: q.line };
  if (Object.keys(entryMatch).length) pipeline.push({ $match: entryMatch });
  pipeline.push({ $unwind: '$lines' });
  if (q.line && Object.keys(q.line).length) pipeline.push({ $match: prefixed(q.line) });
  pipeline.push({
    $project: {
      _id: 0,
      id: '$lines.id',
      entry_id: '$_id',
      entry_number: '$entryNumber',
      date: 1,
      memo: 1,
      reference: 1,
      description: '$lines.description',
      source: 1,
      status: 1,
      reverses_entry_id: '$reversesEntryId',
      account_id: '$lines.accountId',
      debit: '$lines.functionalDebit',
      credit: '$lines.functionalCredit',
    },
  });
  const rows = await runInOrg(orgId, () => store.collection(journalEntries).aggregate<Omit<LedgerLine, 'net'> & { debit: string; credit: string }>(pipeline));
  return rows
    .map(({ debit, credit, ...r }) => ({ ...r, entry_number: r.entry_number ?? null, memo: r.memo ?? null, reference: r.reference ?? null, description: r.description ?? null, reverses_entry_id: r.reverses_entry_id ?? null, net: new D(String(debit)).minus(String(credit)) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime() || (a.entry_number ?? Infinity) - (b.entry_number ?? Infinity));
}

/**
 * Sums of the journal lines that documents posted, by document and account, limited to accounts
 * of one type (or to the accounts given). Replaces the SQL that joined documents to journal_lines on `journal_entry_id`.
 */
export async function documentEntrySums(
  db: Tx | PrismaService,
  store: DocumentStoreService,
  orgId: string,
  where: Prisma.DocumentWhereInput,
  accountType: 'REVENUE' | 'EXPENSE' | string[],
): Promise<{ documentId: string; contactId: string; issueDate: Date; accountId: string; debit: Dec; credit: Dec }[]> {
  const docs = await db.document.findMany({ where: { AND: [where, { orgId, journalEntryId: { not: null } }] }, select: { id: true, contactId: true, issueDate: true, journalEntryId: true } });
  const accounts = Array.isArray(accountType) ? accountType : (await db.account.findMany({ where: { orgId, type: accountType }, select: { id: true } })).map((a) => a.id);
  if (!docs.length || !accounts.length) return [];
  const sums = await lineSums(store, orgId, { entry: { _id: { $in: docs.map((d) => d.journalEntryId!) } }, line: { accountId: { $in: accounts } }, by: { entryId: '_id', accountId: 'lines.accountId' } });
  const byEntry = new Map<string, LineSum[]>();
  for (const s of sums) byEntry.set(s.key.entryId as string, [...(byEntry.get(s.key.entryId as string) ?? []), s]);
  return docs.flatMap((d) => (byEntry.get(d.journalEntryId!) ?? []).map((s) => ({ documentId: d.id, contactId: d.contactId, issueDate: d.issueDate, accountId: s.key.accountId as string, debit: s.debit, credit: s.credit })));
}

/** Contact names by id. */
export async function contactNames(db: Tx | PrismaService, orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  return new Map((await db.contact.findMany({ where: { orgId, id: { in: unique } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
}
