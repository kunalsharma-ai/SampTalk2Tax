import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { type BookItem, dec, reconcileSupplierStatement, type SupplierStatementLine } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { type SupplierStatementDoc, supplierStatements } from '../db/collections/supplier-statements';
import { SubledgerService } from '../ledgers/subledger.service';

export interface SupplierStatementInput {
  contactId: string;
  currency?: string;
  from: string;
  to: string;
  theirOpening: string;
  theirClosing: string;
  lines: (SupplierStatementLine & { description?: string | null })[];
}

const LIST_LIMIT = 100; // not money

/**
 * Supplier statement reconciliation (AP-011): a supplier's statement of account for a period,
 * matched line by line to the bills, vendor credits and payments in the books, with the
 * difference between their closing balance and ours explained. The matching is in
 * packages/accounting-engine (supplier-statements.ts); the books side comes from the vendor's
 * statement in the purchases ledger. purchases.read to read; purchases.manage to enter, change
 * and mark reconciled (only when the statement adds up, and with a note while differences remain).
 * Every change is audited.
 */
@Injectable()
export class SupplierStatementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly subledger: SubledgerService,
    private readonly audit: AuditService,
  ) {}

  private async vendor(orgId: string, contactId: string) {
    const c = await this.prisma.contact.findFirst({ where: { id: contactId, orgId } });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Supplier not found' });
    return c;
  }

  private async statement(id: string) {
    const s = await this.store.collection(supplierStatements).findById(id);
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Supplier statement not found' });
    return s;
  }

  /** The books side for the period: opening and closing balance, and each bill, credit and payment with its reference. */
  private async books(org: OrgContext, s: Pick<SupplierStatementDoc, 'contactId' | 'from' | 'to' | 'currency'>) {
    const st = await this.subledger.statement(org, s.contactId, 'PURCHASES', s.from, s.to, s.currency);
    const docIds = st.lines.filter((l) => l.kind.startsWith('BILL') || l.kind.startsWith('VENDOR_CREDIT')).map((l) => l.id);
    const payIds = st.lines.filter((l) => l.kind.startsWith('PAYMENT')).map((l) => l.id);
    const [docs, pays] = await Promise.all([
      docIds.length ? this.prisma.document.findMany({ where: { orgId: org.id, id: { in: docIds } } }) : [],
      payIds.length ? this.prisma.payment.findMany({ where: { orgId: org.id, id: { in: payIds } } }) : [],
    ]);
    const ref = new Map<string, string | null>([...docs.map((d) => [d.id, d.reference ?? null] as const), ...pays.map((p) => [p.id, p.reference ?? null] as const)]);
    const items: BookItem[] = st.lines.map((l) => ({ id: l.id, kind: l.kind as BookItem['kind'], number: l.number, date: l.date, reference: ref.get(l.id) ?? null, amount: (l.charge ? dec(l.charge) : dec(l.credit!).negated()).toFixed(2) }));
    return { opening: st.openingBalance, closing: st.closingBalance, items };
  }

  private async view(org: OrgContext, s: SupplierStatementDoc) {
    const contact = await this.vendor(org.id, s.contactId);
    const b = await this.books(org, s);
    const r = reconcileSupplierStatement({ theirOpening: s.theirOpening, theirClosing: s.theirClosing, ourOpening: b.opening, ourClosing: b.closing, lines: s.lines, items: b.items });
    const ids = [s.createdById, s.updatedById, s.reconciledById].filter((x): x is string => !!x);
    const who = new Map((await this.store.collection(users).find({ id: { $in: ids } })).map((u) => [u.id, u.name]));
    return {
      id: s.id,
      contact: { id: contact.id, name: contact.name },
      currency: s.currency,
      from: s.from,
      to: s.to,
      status: s.status,
      note: s.note,
      lines: s.lines,
      books: b.items,
      ...r,
      canReconcile: s.status === 'OPEN' && r.statementAddsUp,
      createdBy: who.get(s.createdById) ?? 'Former member',
      updatedBy: who.get(s.updatedById) ?? 'Former member',
      updatedAt: s.updatedAt.toISOString(),
      reconciledBy: s.reconciledById ? (who.get(s.reconciledById) ?? 'Former member') : null,
      reconciledAt: s.reconciledAt?.toISOString() ?? null,
    };
  }

  async list(org: OrgContext, contactId?: string) {
    const rows = await this.store.collection(supplierStatements).find(contactId ? { contactId } : {}, { sort: { to: -1, createdAt: -1 }, limit: LIST_LIMIT });
    return Promise.all(
      rows.map(async (s) => {
        const v = await this.view(org, s);
        return { id: v.id, contact: v.contact, currency: v.currency, from: v.from, to: v.to, status: v.status, theirClosing: v.balances.theirClosing, ourClosing: v.balances.ourClosing, difference: v.balances.difference, statementAddsUp: v.statementAddsUp, agrees: v.agrees, lines: v.lines.length };
      }),
    );
  }

  async get(org: OrgContext, id: string) {
    return this.view(org, await this.statement(id));
  }

  private async check(org: OrgContext, input: SupplierStatementInput, today: string) {
    const contact = await this.vendor(org.id, input.contactId);
    const issues: string[] = [];
    if (!contact.isVendor) issues.push(`${contact.name} is not a vendor`);
    if (input.from > input.to) issues.push('The period must start on or before it ends');
    if (input.to > today) issues.push('A statement cannot end in the future');
    input.lines.forEach((l, i) => {
      if (l.date < input.from || l.date > input.to) issues.push(`Line ${i + 1} (${l.reference}) is dated ${l.date}, outside the statement's period`);
    });
    if (issues.length) throw new DomainError('STATEMENT_INVALID', issues.join(' '), HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return contact;
  }

  private clean(input: SupplierStatementInput, currency: string) {
    return {
      currency,
      from: input.from,
      to: input.to,
      theirOpening: dec(input.theirOpening).toFixed(2),
      theirClosing: dec(input.theirClosing).toFixed(2),
      lines: input.lines.map((l) => ({ date: l.date, reference: l.reference.trim(), kind: l.kind, amount: dec(l.amount).toFixed(2), description: l.description?.trim() || null })),
    };
  }

  async create(org: OrgContext, user: AuthUser, input: SupplierStatementInput, today = todayIso()) {
    const contact = await this.check(org, input, today);
    const now = new Date();
    const s = await this.store.collection(supplierStatements).insertOne({ contactId: contact.id, ...this.clean(input, (input.currency ?? org.functionalCurrency).toUpperCase()), status: 'OPEN', note: null, reconciledById: null, reconciledAt: null, createdById: user.id, createdAt: now, updatedById: user.id, updatedAt: now });
    const v = await this.view(org, s);
    await this.log(org, user, 'supplier_statement.created', s.id, { supplier: contact.name, from: s.from, to: s.to, lines: s.lines.length, theirClosing: s.theirClosing, difference: v.balances.difference, addsUp: v.statementAddsUp });
    return v;
  }

  async update(org: OrgContext, user: AuthUser, id: string, input: SupplierStatementInput, today = todayIso()) {
    const s = await this.statement(id);
    if (s.status === 'RECONCILED') throw new DomainError('STATEMENT_RECONCILED', 'This statement is reconciled and cannot be changed', HttpStatus.CONFLICT);
    if (input.contactId !== s.contactId) throw new DomainError('STATEMENT_INVALID', 'A statement stays with its supplier', HttpStatus.UNPROCESSABLE_ENTITY, { issues: ['A statement stays with its supplier'] });
    const contact = await this.check(org, input, today);
    const r = await this.store.collection(supplierStatements).updateOne({ id, status: 'OPEN', updatedAt: s.updatedAt }, { $set: { ...this.clean(input, s.currency), updatedById: user.id, updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The statement changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    const v = await this.get(org, id);
    await this.log(org, user, 'supplier_statement.updated', id, { supplier: contact.name, lines: v.lines.length, theirClosing: v.balances.theirClosing, difference: v.balances.difference, addsUp: v.statementAddsUp });
    return v;
  }

  async reconcile(org: OrgContext, user: AuthUser, id: string, note: string) {
    const s = await this.statement(id);
    if (s.status === 'RECONCILED') throw new DomainError('STATEMENT_RECONCILED', 'This statement is already reconciled', HttpStatus.CONFLICT);
    const v = await this.view(org, s);
    if (!v.statementAddsUp) throw new DomainError('STATEMENT_DOES_NOT_ADD_UP', `The statement's lines do not add up from its opening to its closing balance (off by ${v.currency} ${v.explained.statementArithmetic}); check the lines and balances as entered`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (!v.agrees && !note.trim()) throw new DomainError('NOTE_REQUIRED', 'The statement and the books still differ; say how the differences will be settled', HttpStatus.UNPROCESSABLE_ENTITY);
    const r = await this.store.collection(supplierStatements).updateOne({ id, status: 'OPEN', updatedAt: s.updatedAt }, { $set: { status: 'RECONCILED', note: note.trim() || null, reconciledById: user.id, reconciledAt: new Date(), updatedById: user.id, updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The statement changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'supplier_statement.reconciled', id, { supplier: v.contact.name, from: s.from, to: s.to, difference: v.balances.difference, onlyOnStatement: v.onlyOnStatement.length, onlyInBooks: v.onlyInBooks.length, note: note.trim() || null });
    return this.get(org, id);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'supplier_statement', entityId, data }));
  }
}
