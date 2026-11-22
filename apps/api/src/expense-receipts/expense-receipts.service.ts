import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, D, RECEIPT_MATCH_MAX_DAYS, scoreReceiptMatch, suggestReceiptMatches, type ReceiptFact, type ReceiptMatchSuggestion, type SpendLine } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { expenseReceipts, type ExpenseReceiptDoc } from '../db/collections/expense-receipts';
import { users } from '../db/collections/identity';
import { attachments } from '../db/collections/sales';

export interface ReceiptInput {
  merchant: string;
  date: string;
  amount: string;
  note?: string | null;
}

const ref = (n: number) => `RC-${String(n).padStart(3, '0')}`;
type BankLine = SpendLine & { accountId: string; accountName: string };

/**
 * Receipt-to-transaction matching (EXP-019). Anyone who can submit expenses uploads receipts for
 * spending paid from a company bank or card account: merchant, date, amount and the file. Finance
 * (banking.manage) matches each receipt to the money-out line of an imported bank statement it
 * paid, from suggestions scored on amount, date and the merchant's name in the narration
 * (`suggestReceiptMatches`), one at a time or all the sure ones together; and sees the money-out
 * lines that still have no receipt. People without banking.read see only their own receipts.
 * Nothing is posted; the statement line itself is not changed.
 */
@Injectable()
export class ExpenseReceiptsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async receipt(org: OrgContext, user: AuthUser, id: string) {
    const r = await this.store.collection(expenseReceipts).findById(id);
    if (!r || (r.createdById !== user.id && !hasPermission(org.role, 'banking.read'))) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Receipt not found' });
    return r;
  }

  private async files(ids: string[]) {
    const list = ids.length ? await this.store.collection(attachments).find({ entityType: 'EXPENSE_RECEIPT', entityId: { $in: ids }, removedAt: null, replacedById: null }, { projection: { content: 0 }, sort: { createdAt: 1 } }) : [];
    const out = new Map<string, { id: string; fileName: string }[]>();
    for (const a of list) out.set(a.entityId, [...(out.get(a.entityId) ?? []), { id: a.id, fileName: a.fileName }]);
    return out;
  }

  private async names(ids: string[]) {
    const list = ids.length ? await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } }) : [];
    return new Map(list.map((u) => [u.id, u.name ?? u.email]));
  }

  /** Money-out statement lines between two dates, with their account and currency. */
  private async spendLines(org: OrgContext, from: string, to: string, ids?: string[]): Promise<BankLine[]> {
    const rows = await this.prisma.bankStatementLine.findMany({
      where: { orgId: org.id, ...(ids ? { id: { in: ids } } : { date: { gte: toDbDate(from), lte: toDbDate(to) } }) },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      select: { id: true, accountId: true, date: true, amount: true, description: true, reference: true },
    });
    const accounts = rows.length ? await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.map((r) => r.accountId))] } }, select: { id: true, name: true, currency: true } }) : [];
    const acc = new Map(accounts.map((a) => [a.id, a]));
    return rows
      .filter((r) => new D(r.amount.toString()).isNegative())
      .map((r) => ({ id: r.id, accountId: r.accountId, accountName: acc.get(r.accountId)?.name ?? 'Bank account', date: fromDbDate(r.date), amount: new D(r.amount.toString()).toFixed(2), currency: acc.get(r.accountId)?.currency ?? org.functionalCurrency, description: r.description, reference: r.reference }));
  }

  /** Statement lines that already have a receipt: a matched one, or a file attached to the line. */
  private async linesWithReceipts(lineIds: string[]) {
    if (!lineIds.length) return new Set<string>();
    const [matched, files] = await Promise.all([
      this.store.collection(expenseReceipts).find({ statementLineId: { $in: lineIds } }),
      this.store.collection(attachments).find({ entityType: 'BANK_STATEMENT_LINE', entityId: { $in: lineIds }, removedAt: null }, { projection: { content: 0 } }),
    ]);
    return new Set([...matched.map((m) => m.statementLineId!), ...files.map((f) => f.entityId)]);
  }

  /** Suggestions for unmatched receipts among the money-out lines without a receipt. */
  private async suggestions(org: OrgContext, open: ExpenseReceiptDoc[]) {
    if (!open.length) return { suggestions: [] as ReceiptMatchSuggestion[], lines: new Map<string, BankLine>() };
    const dates = open.map((r) => r.date).sort();
    const all = await this.spendLines(org, addDays(dates[0]!, -RECEIPT_MATCH_MAX_DAYS), addDays(dates.at(-1)!, RECEIPT_MATCH_MAX_DAYS));
    const taken = await this.linesWithReceipts(all.map((l) => l.id));
    const free = all.filter((l) => !taken.has(l.id));
    const facts: ReceiptFact[] = open.map((r) => ({ id: r.id, date: r.date, amount: r.amount, currency: r.currency, merchant: r.merchant }));
    return { suggestions: suggestReceiptMatches(facts, free), lines: new Map(free.map((l) => [l.id, l])) };
  }

  private lineView(l: BankLine) {
    return { id: l.id, account: { id: l.accountId, name: l.accountName }, date: l.date, amount: l.amount, currency: l.currency, description: l.description, reference: l.reference ?? null };
  }

  async list(org: OrgContext, user: AuthUser, status?: ExpenseReceiptDoc['status']) {
    const finance = hasPermission(org.role, 'banking.read');
    const list = await this.store.collection(expenseReceipts).find({ ...(finance ? {} : { createdById: user.id }), ...(status ? { status } : {}) }, { sort: { date: -1, number: -1 } });
    const [files, names] = await Promise.all([this.files(list.map((r) => r.id)), this.names(list.flatMap((r) => [r.createdById, ...(r.matchedById ? [r.matchedById] : [])]))]);
    const { suggestions, lines } = finance ? await this.suggestions(org, list.filter((r) => r.status === 'UNMATCHED')) : { suggestions: [], lines: new Map<string, BankLine>() };
    const sug = new Map(suggestions.map((s) => [s.receiptId, s]));
    const matchedLines = finance ? await this.spendLines(org, '', '', list.flatMap((r) => (r.statementLineId ? [r.statementLineId] : []))) : [];
    const ml = new Map(matchedLines.map((l) => [l.id, l]));
    const items = list.map((r) => {
      const s = sug.get(r.id);
      const line = r.statementLineId ? ml.get(r.statementLineId) : undefined;
      return {
        id: r.id,
        reference: ref(r.number),
        merchant: r.merchant,
        date: r.date,
        amount: r.amount,
        currency: r.currency,
        note: r.note,
        status: r.status,
        files: files.get(r.id) ?? [],
        mine: r.createdById === user.id,
        uploadedBy: { id: r.createdById, name: names.get(r.createdById) ?? 'A former member' },
        uploadedAt: r.createdAt.toISOString(),
        matchedLine: line ? this.lineView(line) : null,
        matchedBy: r.matchedById ? { id: r.matchedById, name: names.get(r.matchedById) ?? 'A former member' } : null,
        matchedAt: r.matchedAt?.toISOString() ?? null,
        suggestion: s ? { line: this.lineView(lines.get(s.lineId)!), score: s.score, confidence: s.confidence, reasons: s.reasons, alternatives: s.alternatives } : null,
        history: r.history.map((h) => ({ at: h.at.toISOString(), by: names.get(h.byId) ?? 'A former member', action: h.action, note: h.note })),
      };
    });
    const count = (st: ExpenseReceiptDoc['status']) => list.filter((r) => r.status === st).length;
    return { canMatch: hasPermission(org.role, 'banking.manage'), summary: { unmatched: count('UNMATCHED'), matched: count('MATCHED'), discarded: count('DISCARDED'), sure: suggestions.filter((s) => s.confidence === 'HIGH' && (files.get(s.receiptId)?.length ?? 0) > 0).length }, items };
  }

  async create(org: OrgContext, user: AuthUser, input: ReceiptInput, today = todayIso()) {
    if (input.date > today) throw new DomainError('FUTURE_DATE', 'A receipt cannot be dated in the future', HttpStatus.UNPROCESSABLE_ENTITY);
    const amount = new D(input.amount);
    if (amount.lte(0)) throw new DomainError('INVALID_AMOUNT', 'The amount must be more than zero', HttpStatus.UNPROCESSABLE_ENTITY);
    const number = await this.store.nextTenantSequence('expense_receipt');
    const doc = await this.store.collection(expenseReceipts).insertOne({
      number,
      merchant: input.merchant.trim(),
      date: input.date,
      amount: amount.toFixed(2),
      currency: org.functionalCurrency,
      note: input.note?.trim() || null,
      status: 'UNMATCHED',
      statementLineId: null,
      matchedById: null,
      matchedAt: null,
      history: [{ at: new Date(), byId: user.id, action: 'UPLOADED', note: '' }],
      createdById: user.id,
      createdAt: new Date(),
    });
    await this.log(org, user, 'expense_receipt.created', doc.id, { reference: ref(number), merchant: doc.merchant, date: doc.date, amount: doc.amount });
    return this.one(org, user, doc.id);
  }

  async one(org: OrgContext, user: AuthUser, id: string) {
    const r = await this.receipt(org, user, id);
    const all = await this.list(org, user);
    return all.items.find((i) => i.id === r.id)!;
  }

  async match(org: OrgContext, user: AuthUser, id: string, lineId: string) {
    const r = await this.receipt(org, user, id);
    if (r.status !== 'UNMATCHED') throw new DomainError('NOT_UNMATCHED', `Receipt ${ref(r.number)} is ${r.status.toLowerCase()}`, HttpStatus.CONFLICT);
    if (!(await this.files([id])).get(id)?.length) throw new DomainError('NO_FILE', 'Attach the receipt file before matching it', HttpStatus.CONFLICT);
    const [line] = await this.spendLines(org, '', '', [lineId]);
    if (!line) {
      const any = await this.prisma.bankStatementLine.findFirst({ where: { orgId: org.id, id: lineId }, select: { id: true } });
      if (!any) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Statement line not found' });
      throw new DomainError('NOT_MONEY_OUT', 'A receipt matches money paid out, not money received', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (line.currency !== r.currency) throw new DomainError('CURRENCY_MISMATCH', `The receipt is in ${r.currency} and the bank line in ${line.currency}`, HttpStatus.UNPROCESSABLE_ENTITY);
    if ((await this.linesWithReceipts([lineId])).has(lineId)) throw new DomainError('LINE_HAS_RECEIPT', 'That bank line already has a receipt', HttpStatus.CONFLICT);
    const s = scoreReceiptMatch({ id, date: r.date, amount: r.amount, currency: r.currency, merchant: r.merchant }, line);
    const note = s ? `${line.description} (${s.score}/100: ${s.reasons.join('; ')})` : `${line.description} (chosen by hand; amount or date does not fit)`;
    const res = await this.store.collection(expenseReceipts).updateOne({ id, status: 'UNMATCHED' }, { $set: { status: 'MATCHED', statementLineId: lineId, matchedById: user.id, matchedAt: new Date() }, $push: { history: { at: new Date(), byId: user.id, action: 'MATCHED', note } } });
    if (!res.matched) throw new DomainError('CHANGED', 'The receipt changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'expense_receipt.matched', id, { reference: ref(r.number), statementLineId: lineId, score: s?.score ?? null });
    return this.one(org, user, id);
  }

  /** Matches every receipt whose suggestion is sure (HIGH) and that has its file. */
  async matchSure(org: OrgContext, user: AuthUser) {
    const open = await this.store.collection(expenseReceipts).find({ status: 'UNMATCHED' });
    const files = await this.files(open.map((r) => r.id));
    const { suggestions } = await this.suggestions(org, open.filter((r) => files.get(r.id)?.length));
    let matched = 0;
    for (const s of suggestions.filter((x) => x.confidence === 'HIGH')) {
      try {
        await this.match(org, user, s.receiptId, s.lineId);
        matched++;
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
      }
    }
    return { matched };
  }

  async unmatch(org: OrgContext, user: AuthUser, id: string, reason: string) {
    const r = await this.receipt(org, user, id);
    if (r.status !== 'MATCHED') throw new DomainError('NOT_MATCHED', `Receipt ${ref(r.number)} is not matched`, HttpStatus.CONFLICT);
    const res = await this.store.collection(expenseReceipts).updateOne({ id, status: 'MATCHED' }, { $set: { status: 'UNMATCHED', statementLineId: null, matchedById: null, matchedAt: null }, $push: { history: { at: new Date(), byId: user.id, action: 'UNMATCHED', note: reason.trim() } } });
    if (!res.matched) throw new DomainError('CHANGED', 'The receipt changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'expense_receipt.unmatched', id, { reference: ref(r.number), statementLineId: r.statementLineId, reason: reason.trim() });
    return this.one(org, user, id);
  }

  async discard(org: OrgContext, user: AuthUser, id: string, reason: string) {
    const r = await this.receipt(org, user, id);
    if (r.status !== 'UNMATCHED') throw new DomainError('NOT_UNMATCHED', r.status === 'MATCHED' ? 'Unmatch the receipt before discarding it' : 'The receipt is already discarded', HttpStatus.CONFLICT);
    if (r.createdById !== user.id && !hasPermission(org.role, 'banking.manage')) throw new DomainError('FORBIDDEN', 'Only the person who uploaded the receipt, or finance, discards it', HttpStatus.FORBIDDEN);
    const res = await this.store.collection(expenseReceipts).updateOne({ id, status: 'UNMATCHED' }, { $set: { status: 'DISCARDED' }, $push: { history: { at: new Date(), byId: user.id, action: 'DISCARDED', note: reason.trim() } } });
    if (!res.matched) throw new DomainError('CHANGED', 'The receipt changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'expense_receipt.discarded', id, { reference: ref(r.number), reason: reason.trim() });
    return this.one(org, user, id);
  }

  /** Money paid out in the last `days` days with no receipt, each with the best unmatched receipt for it. */
  async missing(org: OrgContext, days: number, today = todayIso()) {
    const from = addDays(today, -days);
    const lines = await this.spendLines(org, from, today);
    const taken = await this.linesWithReceipts(lines.map((l) => l.id));
    const open = lines.filter((l) => !taken.has(l.id));
    const receipts = await this.store.collection(expenseReceipts).find({ status: 'UNMATCHED' });
    const facts: ReceiptFact[] = receipts.map((r) => ({ id: r.id, date: r.date, amount: r.amount, currency: r.currency, merchant: r.merchant }));
    const sug = new Map(suggestReceiptMatches(facts, open).map((s) => [s.lineId, s]));
    const byId = new Map(receipts.map((r) => [r.id, r]));
    const totals = new Map<string, InstanceType<typeof D>>();
    for (const l of open) totals.set(l.currency, (totals.get(l.currency) ?? new D(0)).plus(new D(l.amount).abs()));
    return {
      from,
      to: today,
      days,
      lines: lines.length,
      withReceipt: lines.length - open.length,
      totals: [...totals].map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) })),
      items: open
        .sort((a, b) => b.date.localeCompare(a.date) || a.description.localeCompare(b.description) || a.id.localeCompare(b.id))
        .map((l) => {
          const s = sug.get(l.id);
          const r = s ? byId.get(s.receiptId)! : null;
          return { ...this.lineView(l), suggestion: s && r ? { receipt: { id: r.id, reference: ref(r.number), merchant: r.merchant, date: r.date, amount: r.amount }, score: s.score, confidence: s.confidence, reasons: s.reasons } : null };
        }),
    };
  }

  /** Who may see or change the files on a receipt; see AttachmentsService. */
  async attachmentAccess(org: OrgContext, actorId: string, id: string, access: 'read' | 'manage') {
    const r = await this.store.collection(expenseReceipts).findById(id);
    const own = r?.createdById === actorId;
    if (!r || (!own && !hasPermission(org.role, 'banking.read'))) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Receipt not found' });
    if (access === 'read') return;
    if (r.status !== 'UNMATCHED') throw new DomainError('RECEIPT_NOT_OPEN', 'Files can be added or removed only while the receipt is unmatched', HttpStatus.CONFLICT);
    if (own ? !hasPermission(org.role, 'expenses.submit') : !hasPermission(org.role, 'banking.manage')) throw new DomainError('FORBIDDEN', 'Only the person who uploaded the receipt, or finance, changes its files', HttpStatus.FORBIDDEN);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'expense_receipt', entityId, data }));
  }
}
