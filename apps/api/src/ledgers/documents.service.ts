import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  D,
  Dec,
  DocumentKind,
  DocumentLineInput,
  Ledger,
  TaxRateInfo,
  addDays,
  allocationIssues,
  buildDocumentJournal,
  buildPaymentJournal,
  computeDocument,
  dec,
  documentNumber,
  ledgerOf,
  minorUnits,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { ledgerKinds, SubledgerService } from './subledger.service';

export interface LedgerOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}

interface Actor {
  id: string;
}

export interface DocumentInput {
  kind: DocumentKind;
  contactId: string;
  issueDate: string;
  dueDate?: string;
  reference?: string | null;
  memo?: string | null;
  lines: DocumentLineInput[];
}

export interface PaymentInput {
  contactId: string;
  date: string;
  bankAccountId: string;
  amount: string;
  reference?: string | null;
  memo?: string | null;
  allocations: { documentId: string; amount: string }[];
}

const DOC_INCLUDE = {
  contact: { select: { id: true, name: true, email: true } },
  lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true, name: true } }, tax: { select: { name: true } } } },
  allocationsIn: {
    where: { removedOn: null },
    orderBy: { createdAt: 'asc' },
    include: { payment: { select: { id: true, number: true, date: true, kind: true } }, creditDocument: { select: { id: true, number: true, issueDate: true, kind: true } } },
  },
  allocationsOut: { where: { removedOn: null }, orderBy: { createdAt: 'asc' }, include: { target: { select: { id: true, number: true, kind: true } } } },
} satisfies Prisma.DocumentInclude;
type DocWithAll = Prisma.DocumentGetPayload<{ include: typeof DOC_INCLUDE }>;

const PAY_INCLUDE = {
  contact: { select: { id: true, name: true } },
  bankAccount: { select: { id: true, code: true, name: true } },
  allocations: { where: { removedOn: null }, orderBy: { createdAt: 'asc' }, include: { target: { select: { id: true, number: true, kind: true, total: true } } } },
} satisfies Prisma.PaymentInclude;
type PayWithAll = Prisma.PaymentGetPayload<{ include: typeof PAY_INCLUDE }>;

export type DocumentView = 'all' | 'draft' | 'open' | 'overdue' | 'paid' | 'void';

function requestHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * Invoices, credit notes, bills, vendor credits, receipts and payments.
 *
 * Every posting goes through JournalsService.postSystemEntry in the same database
 * transaction as the document change, so a document is never posted without its
 * journal (or the other way round). Corrections are made by voiding, which posts
 * an exact reversal; nothing posted is edited or deleted.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
    private readonly subledger: SubledgerService,
  ) {}

  // ------------------------------------------------------------------ reads

  async list(org: LedgerOrg, ledger: Ledger, q: { kind?: DocumentKind; view: DocumentView; contactId?: string; limit: number; offset: number }) {
    const k = ledgerKinds(ledger);
    const kinds = q.kind ? [q.kind] : [k.charge, k.credit];
    this.assertKinds(ledger, kinds);
    const today = toDbDate(todayIso());
    const view = {
      all: Prisma.empty,
      draft: Prisma.sql`AND d.status = 'DRAFT'`,
      void: Prisma.sql`AND d.status = 'VOID'`,
      open: Prisma.sql`AND d.status = 'POSTED' AND d.total > COALESCE(a.used, 0)`,
      overdue: Prisma.sql`AND d.status = 'POSTED' AND d.total > COALESCE(a.used, 0) AND d.due_date < ${today}::date AND d.kind IN ('INVOICE', 'BILL')`,
      paid: Prisma.sql`AND d.status = 'POSTED' AND d.total = COALESCE(a.used, 0)`,
    }[q.view];
    const contact = q.contactId ? Prisma.sql`AND d.contact_id = ${q.contactId}::uuid` : Prisma.empty;
    const kindList = Prisma.join(kinds.map((x) => Prisma.sql`${x}::"DocumentKind"`));
    const base = Prisma.sql`
      FROM documents d
      JOIN contacts c ON c.id = d.contact_id
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS used FROM allocations al
        WHERE al.removed_on IS NULL AND (al.target_id = d.id OR al.credit_document_id = d.id)
      ) a ON true
      WHERE d.org_id = ${org.id}::uuid AND d.kind IN (${kindList}) ${view} ${contact}`;
    const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count ${base}`;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        kind: DocumentKind;
        status: string;
        number: string | null;
        contact_id: string;
        contact_name: string;
        issue_date: Date;
        due_date: Date;
        reference: string | null;
        currency: string;
        subtotal: Prisma.Decimal;
        tax_total: Prisma.Decimal;
        total: Prisma.Decimal;
        used: Prisma.Decimal | null;
      }[]
    >`SELECT d.id, d.kind, d.status::text AS status, d.number, d.contact_id, c.name AS contact_name, d.issue_date, d.due_date, d.reference,
             d.currency, d.subtotal, d.tax_total, d.total, a.used
      ${base}
      ORDER BY d.issue_date DESC, d.number DESC NULLS FIRST, d.created_at DESC
      LIMIT ${q.limit} OFFSET ${q.offset}`;
    const scale = minorUnits(org.functionalCurrency);
    const todayIsoStr = todayIso();
    return {
      total: Number(count),
      items: rows.map((r) => {
        const total = new D(r.total.toFixed());
        const used = new D(r.used?.toFixed() ?? '0');
        const due = fromDbDate(r.due_date);
        const open = r.status === 'POSTED' ? total.minus(used) : new D(0);
        return {
          id: r.id,
          kind: r.kind,
          status: r.status,
          number: r.number,
          contact: { id: r.contact_id, name: r.contact_name },
          issueDate: fromDbDate(r.issue_date),
          dueDate: due,
          reference: r.reference,
          currency: r.currency,
          subtotal: r.subtotal.toFixed(scale),
          taxTotal: r.tax_total.toFixed(scale),
          total: total.toFixed(scale),
          allocated: used.toFixed(scale),
          amountDue: open.toFixed(scale),
          paymentStatus: paymentStatus(r.status, total, used),
          isOverdue: r.status === 'POSTED' && (r.kind === 'INVOICE' || r.kind === 'BILL') && open.gt(0) && due < todayIsoStr,
        };
      }),
    };
  }

  async get(org: LedgerOrg, ledger: Ledger, id: string) {
    const d = await this.prisma.document.findFirst({ where: { id, orgId: org.id }, include: DOC_INCLUDE });
    if (!d || ledgerOf(d.kind) !== ledger) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Document not found' });
    return this.serializeDoc(org, d);
  }

  async listPayments(org: LedgerOrg, ledger: Ledger, q: { contactId?: string; limit: number; offset: number }) {
    const where: Prisma.PaymentWhereInput = { orgId: org.id, kind: ledgerKinds(ledger).payment, contactId: q.contactId };
    const [total, rows] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({ where, include: PAY_INCLUDE, orderBy: [{ date: 'desc' }, { number: 'desc' }], take: q.limit, skip: q.offset }),
    ]);
    return { total, items: rows.map((p) => this.serializePayment(org, p)) };
  }

  async getPayment(org: LedgerOrg, ledger: Ledger, id: string) {
    const p = await this.prisma.payment.findFirst({ where: { id, orgId: org.id, kind: ledgerKinds(ledger).payment }, include: PAY_INCLUDE });
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment not found' });
    return this.serializePayment(org, p);
  }

  // ------------------------------------------------------------------ documents

  async create(org: LedgerOrg, actor: Actor, ledger: Ledger, input: DocumentInput, opts: { post: boolean; overrideCreditLimit?: boolean }) {
    this.assertKinds(ledger, [input.kind]);
    if (opts.post) this.requirePermission(org, 'journals.post', 'post documents');
    return this.retryOnNumberRace(() =>
      this.prisma.$transaction(async (tx) => {
        const prepared = await this.prepare(tx, org, ledger, input);
        const doc = await tx.document.create({
          data: {
            orgId: org.id,
            kind: input.kind,
            contactId: input.contactId,
            issueDate: toDbDate(input.issueDate),
            dueDate: toDbDate(prepared.dueDate),
            reference: input.reference || null,
            memo: input.memo || null,
            currency: org.functionalCurrency,
            subtotal: prepared.computed.subtotal.toFixed(),
            taxTotal: prepared.computed.taxTotal.toFixed(),
            total: prepared.computed.total.toFixed(),
            createdById: actor.id,
            lines: { create: lineRows(prepared.computed.lines) },
          },
        });
        await this.audit.append(tx, {
          orgId: org.id,
          actorId: actor.id,
          action: 'document.draft_created',
          entityType: 'document',
          entityId: doc.id,
          data: { kind: input.kind, total: prepared.computed.total.toFixed(), contactId: input.contactId },
        });
        if (opts.post) await this.postInTx(tx, org, actor, doc.id, opts.overrideCreditLimit ?? false);
        return this.serializeDoc(org, await tx.document.findUniqueOrThrow({ where: { id: doc.id }, include: DOC_INCLUDE }));
      }),
    );
  }

  async updateDraft(org: LedgerOrg, actor: Actor, ledger: Ledger, id: string, input: DocumentInput) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockDocument(tx, org.id, ledger, id);
      if (existing.status !== 'DRAFT') throw new DomainError('DOCUMENT_POSTED', 'Posted documents cannot be edited; void and re-issue instead', HttpStatus.CONFLICT);
      if (existing.kind !== input.kind) throw new DomainError('KIND_CHANGE', 'A draft cannot change its document type');
      const prepared = await this.prepare(tx, org, ledger, input, id);
      await tx.documentLine.deleteMany({ where: { documentId: id, orgId: org.id } });
      await tx.document.update({
        where: { id },
        data: {
          contactId: input.contactId,
          issueDate: toDbDate(input.issueDate),
          dueDate: toDbDate(prepared.dueDate),
          reference: input.reference || null,
          memo: input.memo || null,
          subtotal: prepared.computed.subtotal.toFixed(),
          taxTotal: prepared.computed.taxTotal.toFixed(),
          total: prepared.computed.total.toFixed(),
          lines: { create: lineRows(prepared.computed.lines) },
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'document.draft_updated', entityType: 'document', entityId: id, data: { total: prepared.computed.total.toFixed() } });
      return this.serializeDoc(org, await tx.document.findUniqueOrThrow({ where: { id }, include: DOC_INCLUDE }));
    });
  }

  async deleteDraft(org: LedgerOrg, actor: Actor, ledger: Ledger, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.lockDocument(tx, org.id, ledger, id);
      if (existing.status !== 'DRAFT') throw new DomainError('DOCUMENT_POSTED', 'Posted documents cannot be deleted; void them instead', HttpStatus.CONFLICT);
      await tx.documentLine.deleteMany({ where: { documentId: id, orgId: org.id } });
      await tx.document.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'document.draft_deleted', entityType: 'document', entityId: id, data: { kind: existing.kind } });
    });
  }

  async post(org: LedgerOrg, actor: Actor, ledger: Ledger, id: string, overrideCreditLimit: boolean) {
    this.requirePermission(org, 'journals.post', 'post documents');
    return this.retryOnNumberRace(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockDocument(tx, org.id, ledger, id);
        await this.postInTx(tx, org, actor, id, overrideCreditLimit);
        return this.serializeDoc(org, await tx.document.findUniqueOrThrow({ where: { id }, include: DOC_INCLUDE }));
      }),
    );
  }

  async void(org: LedgerOrg, actor: Actor, ledger: Ledger, id: string, input: { date: string; reason: string }) {
    this.requirePermission(org, 'journals.reverse', 'void documents');
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.lockDocument(tx, org.id, ledger, id);
      if (doc.status !== 'POSTED') throw new DomainError('NOT_POSTED', doc.status === 'VOID' ? 'Document is already void' : 'Drafts are deleted, not voided', HttpStatus.CONFLICT);
      const active = await tx.allocation.count({ where: { orgId: org.id, removedOn: null, OR: [{ targetId: id }, { creditDocumentId: id }] } });
      if (active > 0) throw new DomainError('HAS_ALLOCATIONS', 'Remove the payments and credits applied to this document before voiding it', HttpStatus.CONFLICT);
      if (input.date < fromDbDate(doc.issueDate)) throw new DomainError('INVALID_DATE', 'The void date cannot be before the document date');
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, doc.journalEntryId!, { date: input.date, memo: `Void ${doc.number}: ${input.reason}` });
      await tx.document.update({ where: { id }, data: { status: 'VOID', voidJournalEntryId: rev.id, voidDate: toDbDate(input.date), voidReason: input.reason } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'document.voided', entityType: 'document', entityId: id, data: { number: doc.number, date: input.date, reason: input.reason, reversalEntryId: rev.id } });
      return this.serializeDoc(org, await tx.document.findUniqueOrThrow({ where: { id }, include: DOC_INCLUDE }));
    });
  }

  /** Apply a posted credit note / vendor credit against a posted invoice / bill of the same contact. */
  async applyCredit(org: LedgerOrg, actor: Actor, ledger: Ledger, targetId: string, input: { creditDocumentId: string; amount: string }) {
    return this.prisma.$transaction(async (tx) => {
      const [first, second] = [targetId, input.creditDocumentId].sort();
      const a = await this.lockDocument(tx, org.id, ledger, first);
      const b = await this.lockDocument(tx, org.id, ledger, second);
      const target = a.id === targetId ? a : b;
      const credit = a.id === targetId ? b : a;
      const k = ledgerKinds(ledger);
      if (target.kind !== k.charge || credit.kind !== k.credit) throw new DomainError('INVALID_ALLOCATION', `Apply a ${k.credit.toLowerCase().replace('_', ' ')} to a ${k.charge.toLowerCase()}`);
      if (target.status !== 'POSTED' || credit.status !== 'POSTED') throw new DomainError('NOT_POSTED', 'Both documents must be posted', HttpStatus.CONFLICT);
      if (target.contactId !== credit.contactId) throw new DomainError('INVALID_ALLOCATION', 'The credit belongs to a different contact');
      const amount = dec(input.amount);
      const issues = allocationIssues(amount, await this.remainingOfCredit(tx, credit.id, credit.total), await this.outstandingOf(tx, target.id, target.total), org.functionalCurrency);
      if (issues.length) throw new DomainError('INVALID_ALLOCATION', issues.join('; '));
      const date = [fromDbDate(target.issueDate), fromDbDate(credit.issueDate)].sort()[1];
      const al = await tx.allocation.create({ data: { orgId: org.id, targetId: target.id, creditDocumentId: credit.id, amount: amount.toFixed(), date: toDbDate(date), createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'allocation.created', entityType: 'allocation', entityId: al.id, data: { targetId: target.id, creditDocumentId: credit.id, amount: amount.toFixed() } });
      return this.serializeDoc(org, await tx.document.findUniqueOrThrow({ where: { id: target.id }, include: DOC_INCLUDE }));
    });
  }

  // ------------------------------------------------------------------ payments

  async createPayment(org: LedgerOrg, actor: Actor, ledger: Ledger, input: PaymentInput, idempotencyKey?: string) {
    const hash = idempotencyKey ? requestHash({ ledger, input }) : undefined;
    if (idempotencyKey) {
      const replay = await this.findIdempotentPayment(org, idempotencyKey, hash!);
      if (replay) return { replayed: true, payment: replay };
    }
    try {
      const payment = await this.prisma.$transaction(async (tx) => {
        const p = await this.recordPaymentInTx(tx, org, actor, ledger, input, { idempotencyKey, hash });
        return this.serializePayment(org, await tx.payment.findUniqueOrThrow({ where: { id: p.id }, include: PAY_INCLUDE }));
      });
      return { replayed: false, payment };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        if (idempotencyKey) {
          const replay = await this.findIdempotentPayment(org, idempotencyKey, hash!);
          if (replay) return { replayed: true, payment: replay };
        }
        // Another payment took the same number concurrently; the caller can retry safely.
        throw new DomainError('CONCURRENT_NUMBERING', 'Another payment was recorded at the same moment; please retry', HttpStatus.CONFLICT);
      }
      throw e;
    }
  }

  /** Records a receipt or payment and its allocations inside the caller's transaction. */
  async recordPaymentInTx(tx: Tx, org: LedgerOrg, actor: Actor, ledger: Ledger, input: PaymentInput, opts: { idempotencyKey?: string; hash?: string } = {}) {
    const kind = ledgerKinds(ledger).payment;
    const { idempotencyKey, hash } = opts;
    await this.checkContact(tx, org.id, ledger, input.contactId);
    const bank = await tx.account.findFirst({ where: { id: input.bankAccountId, orgId: org.id } });
    if (!bank || !bank.isPostable || !bank.isActive || !['BANK', 'CASH'].includes(bank.subtype ?? '')) {
      throw new DomainError('INVALID_BANK_ACCOUNT', 'Choose an active bank or cash account');
    }
    const amount = dec(input.amount);
    const control = await this.controlAccount(tx, org.id, ledger);
    const lines = buildPaymentJournal(kind, amount, bank.id, control, org.functionalCurrency);
    const n = await this.nextNumber(tx, org.id, kind);
    const number = documentNumber(kind, n);
    const contact = await tx.contact.findUniqueOrThrow({ where: { id: input.contactId } });
    const je = await this.journals.postSystemEntry(tx, org, actor, {
      date: input.date,
      source: 'PAYMENT',
      memo: `${number} · ${contact.name}${input.memo ? ` · ${input.memo}` : ''}`,
      reference: number,
      lines,
    });
    const p = await tx.payment.create({
      data: {
        orgId: org.id,
        kind,
        number,
        contactId: input.contactId,
        date: toDbDate(input.date),
        bankAccountId: bank.id,
        currency: org.functionalCurrency,
        amount: amount.toFixed(),
        reference: input.reference || null,
        memo: input.memo || null,
        journalEntryId: je.id,
        idempotencyKey,
        idempotencyHash: hash,
        createdById: actor.id,
      },
    });
    await this.audit.append(tx, {
      orgId: org.id,
      actorId: actor.id,
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: p.id,
      data: { kind, number, amount: amount.toFixed(), contactId: input.contactId, journalEntryId: je.id },
    });
    await this.allocateInTx(tx, org, actor, ledger, p.id, input.allocations);
    return { id: p.id, number: p.number, journalEntryId: je.id };
  }

  async allocatePayment(org: LedgerOrg, actor: Actor, ledger: Ledger, paymentId: string, allocations: { documentId: string; amount: string }[]) {
    return this.prisma.$transaction(async (tx) => {
      await this.allocateInTx(tx, org, actor, ledger, paymentId, allocations);
      return this.serializePayment(org, await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: PAY_INCLUDE }));
    });
  }

  async voidPayment(org: LedgerOrg, actor: Actor, ledger: Ledger, id: string, input: { date: string; reason: string }) {
    this.requirePermission(org, 'journals.reverse', 'void payments');
    return this.prisma.$transaction(async (tx) => {
      const p = await this.lockPayment(tx, org.id, ledger, id);
      if (p.status !== 'POSTED') throw new DomainError('ALREADY_VOID', 'Payment is already void', HttpStatus.CONFLICT);
      const active = await tx.allocation.count({ where: { paymentId: id, removedOn: null } });
      if (active > 0) throw new DomainError('HAS_ALLOCATIONS', 'Remove this payment from the documents it settles before voiding it', HttpStatus.CONFLICT);
      if (input.date < fromDbDate(p.date)) throw new DomainError('INVALID_DATE', 'The void date cannot be before the payment date');
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, p.journalEntryId, { date: input.date, memo: `Void ${p.number}: ${input.reason}` });
      await tx.payment.update({ where: { id }, data: { status: 'VOID', voidJournalEntryId: rev.id, voidDate: toDbDate(input.date) } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment.voided', entityType: 'payment', entityId: id, data: { number: p.number, date: input.date, reason: input.reason, reversalEntryId: rev.id } });
      return this.serializePayment(org, await tx.payment.findUniqueOrThrow({ where: { id }, include: PAY_INCLUDE }));
    });
  }

  /** Take back an allocation. The row stays for history, stamped with the day it was removed. */
  async removeAllocation(org: LedgerOrg, actor: Actor, ledger: Ledger, allocationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM allocations WHERE id = ${allocationId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Allocation not found' });
      const al = await tx.allocation.findUniqueOrThrow({ where: { id: allocationId }, include: { target: true } });
      if (ledgerOf(al.target.kind) !== ledger) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Allocation not found' });
      if (al.removedOn) throw new DomainError('ALREADY_REMOVED', 'Allocation was already removed', HttpStatus.CONFLICT);
      const today = todayIso();
      const removedOn = today < fromDbDate(al.date) ? fromDbDate(al.date) : today;
      await tx.allocation.update({ where: { id: allocationId }, data: { removedOn: toDbDate(removedOn), removedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'allocation.removed', entityType: 'allocation', entityId: allocationId, data: { targetId: al.targetId, amount: al.amount.toFixed() } });
      return { id: allocationId, removedOn };
    });
  }

  // ------------------------------------------------------------------ internals

  private async postInTx(tx: Tx, org: LedgerOrg, actor: Actor, id: string, overrideCreditLimit: boolean) {
    const doc = await tx.document.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } }, contact: true } });
    if (doc.status !== 'DRAFT') throw new DomainError('ALREADY_POSTED', 'Document is already posted', HttpStatus.CONFLICT);
    const ledger = ledgerOf(doc.kind);
    if (!doc.contact.isActive) throw new DomainError('CONTACT_INACTIVE', `${doc.contact.name} is inactive`);
    // Recompute with the current tax rates and accounts, so what posts is exactly what is valid now.
    const input: DocumentInput = {
      kind: doc.kind,
      contactId: doc.contactId,
      issueDate: fromDbDate(doc.issueDate),
      dueDate: fromDbDate(doc.dueDate),
      lines: doc.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? undefined, quantity: l.quantity.toFixed(), unitPrice: l.unitPrice.toFixed(), taxRateId: l.taxRateId })),
    };
    const { computed } = await this.prepare(tx, org, ledger, { ...input, reference: doc.reference }, id);
    if (!computed.total.eq(doc.total.toFixed())) {
      throw new DomainError('TOTAL_CHANGED', 'A tax rate on this draft changed since it was saved. Open and save the draft again to review the new total.', HttpStatus.CONFLICT);
    }
    if (doc.kind === 'INVOICE' && doc.contact.creditLimit) {
      const bal = (await this.subledger.balances(tx, org.id, 'SALES', '9999-12-31', doc.contactId)).get(doc.contactId);
      const exposure = (bal ? bal.outstanding.minus(bal.unapplied) : new D(0)).plus(computed.total);
      const limit = new D(doc.contact.creditLimit.toFixed());
      if (exposure.gt(limit)) {
        if (!overrideCreditLimit) {
          throw new DomainError('CREDIT_LIMIT_EXCEEDED', `Posting brings ${doc.contact.name} to ${exposure.toFixed(2)}, above the credit limit of ${limit.toFixed(2)}`, HttpStatus.CONFLICT, {
            exposure: exposure.toFixed(2),
            creditLimit: limit.toFixed(2),
          });
        }
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'document.credit_limit_overridden', entityType: 'document', entityId: id, data: { exposure: exposure.toFixed(), creditLimit: limit.toFixed() } });
      }
    }
    const control = await this.controlAccount(tx, org.id, ledger);
    const n = await this.nextNumber(tx, org.id, doc.kind);
    const number = documentNumber(doc.kind, n);
    const je = await this.journals.postSystemEntry(tx, org, actor, {
      date: fromDbDate(doc.issueDate),
      source: 'DOCUMENT',
      memo: `${number} · ${doc.contact.name}${doc.reference ? ` · ${doc.reference}` : ''}`,
      reference: number,
      lines: buildDocumentJournal(doc.kind, computed, control, org.functionalCurrency),
    });
    await tx.document.update({ where: { id }, data: { status: 'POSTED', number, journalEntryId: je.id, postedById: actor.id, postedAt: new Date() } });
    await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'document.posted', entityType: 'document', entityId: id, data: { number, total: computed.total.toFixed(), journalEntryId: je.id } });
  }

  private async allocateInTx(tx: Tx, org: LedgerOrg, actor: Actor, ledger: Ledger, paymentId: string, allocations: { documentId: string; amount: string }[]) {
    if (!allocations.length) return;
    const ids = allocations.map((a) => a.documentId);
    if (new Set(ids).size !== ids.length) throw new DomainError('INVALID_ALLOCATION', 'Each document can appear only once');
    const p = await this.lockPayment(tx, org.id, ledger, paymentId);
    if (p.status !== 'POSTED') throw new DomainError('ALREADY_VOID', 'A void payment cannot be allocated', HttpStatus.CONFLICT);
    let remaining = await this.remainingOfPayment(tx, p.id, p.amount);
    const k = ledgerKinds(ledger);
    for (const id of [...ids].sort()) await this.lockDocument(tx, org.id, ledger, id);
    for (const a of allocations) {
      const doc = await tx.document.findUniqueOrThrow({ where: { id: a.documentId } });
      if (doc.kind !== k.charge) throw new DomainError('INVALID_ALLOCATION', `${k.payment === 'RECEIPT' ? 'Receipts' : 'Payments'} can only settle ${k.charge.toLowerCase()}s`);
      if (doc.status !== 'POSTED') throw new DomainError('NOT_POSTED', `${doc.number ?? 'Draft'} is not posted`, HttpStatus.CONFLICT);
      if (doc.contactId !== p.contactId) throw new DomainError('INVALID_ALLOCATION', `${doc.number} belongs to a different contact`);
      const amount = dec(a.amount);
      const issues = allocationIssues(amount, remaining, await this.outstandingOf(tx, doc.id, doc.total), org.functionalCurrency);
      if (issues.length) throw new DomainError('INVALID_ALLOCATION', `${doc.number}: ${issues.join('; ')}`);
      const date = [fromDbDate(p.date), fromDbDate(doc.issueDate)].sort()[1];
      const al = await tx.allocation.create({ data: { orgId: org.id, targetId: doc.id, paymentId: p.id, amount: amount.toFixed(), date: toDbDate(date), createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'allocation.created', entityType: 'allocation', entityId: al.id, data: { targetId: doc.id, paymentId: p.id, amount: amount.toFixed() } });
      remaining = remaining.minus(amount);
    }
  }

  private async prepare(tx: Tx, org: LedgerOrg, ledger: Ledger, input: DocumentInput, excludeId?: string) {
    const contact = await this.checkContact(tx, org.id, ledger, input.contactId);
    const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({ where: { orgId: org.id, id: { in: accountIds } } });
    const o = await tx.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true } });
    const issues: string[] = [];
    input.lines.forEach((l, i) => {
      const a = accounts.find((x) => x.id === l.accountId);
      if (!a) issues.push(`Line ${i + 1}: account not found`);
      else if (!a.isPostable || !a.isActive) issues.push(`Line ${i + 1}: account ${a.code} is a header or inactive account`);
      else if (a.id === o.arAccountId || a.id === o.apAccountId) issues.push(`Line ${i + 1}: ${a.code} is a control account and cannot be used on a document line`);
    });
    if (issues.length) throw new DomainError('DOCUMENT_INVALID', 'Document is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const taxIds = [...new Set(input.lines.map((l) => l.taxRateId).filter((x): x is string => !!x))];
    const taxes = await tx.taxRate.findMany({ where: { orgId: org.id, id: { in: taxIds }, isActive: true } });
    const taxMap = new Map<string, TaxRateInfo>(
      taxes.map((t) => [t.id, { id: t.id, name: t.name, rate: t.rate.toFixed(), accountId: ledger === 'SALES' ? t.salesAccountId : t.purchaseAccountId }]),
    );
    const computed = computeDocument(input.lines, org.functionalCurrency, taxMap);
    const isCharge = input.kind === 'INVOICE' || input.kind === 'BILL';
    const dueDate = !isCharge ? input.issueDate : (input.dueDate ?? addDays(input.issueDate, contact.paymentTermsDays));
    if (dueDate < input.issueDate) throw new DomainError('INVALID_DATE', 'The due date cannot be before the issue date');
    if (input.kind === 'BILL' && input.reference) {
      const dup = await tx.$queryRaw<{ number: string | null }[]>`
        SELECT number FROM documents WHERE org_id = ${org.id}::uuid AND contact_id = ${input.contactId}::uuid AND kind = 'BILL'
          AND status <> 'VOID' AND lower(reference) = lower(${input.reference})
          AND id <> ${excludeId ?? '00000000-0000-0000-0000-000000000000'}::uuid LIMIT 1`;
      if (dup[0]) {
        throw new DomainError('DUPLICATE_BILL', `This vendor's invoice "${input.reference}" is already entered${dup[0].number ? ` as ${dup[0].number}` : ' as a draft'}`, HttpStatus.CONFLICT);
      }
    }
    return { computed, dueDate };
  }

  private async checkContact(tx: Tx, orgId: string, ledger: Ledger, contactId: string) {
    const c = await tx.contact.findFirst({ where: { id: contactId, orgId } });
    if (!c) throw new DomainError('CONTACT_NOT_FOUND', 'Contact not found');
    if (ledger === 'SALES' && !c.isCustomer) throw new DomainError('NOT_A_CUSTOMER', `${c.name} is not set up as a customer`);
    if (ledger === 'PURCHASES' && !c.isVendor) throw new DomainError('NOT_A_VENDOR', `${c.name} is not set up as a vendor`);
    if (!c.isActive) throw new DomainError('CONTACT_INACTIVE', `${c.name} is inactive`);
    return c;
  }

  private async controlAccount(tx: Tx, orgId: string, ledger: Ledger) {
    const o = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { arAccountId: true, apAccountId: true } });
    const id = ledger === 'SALES' ? o.arAccountId : o.apAccountId;
    if (!id) throw new DomainError('NO_CONTROL_ACCOUNT', `This organisation has no ${ledger === 'SALES' ? 'receivables' : 'payables'} control account`, HttpStatus.CONFLICT);
    return id;
  }

  private async nextNumber(tx: Tx, orgId: string, kind: string) {
    const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO org_counters (org_id, key, value) VALUES (${orgId}::uuid, ${`doc:${kind}`}, 1)
      ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1
      RETURNING value`;
    return value;
  }

  private async lockDocument(tx: Tx, orgId: string, ledger: Ledger, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM documents WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Document not found' });
    const d = await tx.document.findUniqueOrThrow({ where: { id } });
    if (ledgerOf(d.kind) !== ledger) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Document not found' });
    return d;
  }

  private async lockPayment(tx: Tx, orgId: string, ledger: Ledger, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment not found' });
    const p = await tx.payment.findUniqueOrThrow({ where: { id } });
    if (p.kind !== ledgerKinds(ledger).payment) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment not found' });
    return p;
  }

  private async outstandingOf(tx: Tx, docId: string, total: Prisma.Decimal): Promise<Dec> {
    const agg = await tx.allocation.aggregate({ where: { targetId: docId, removedOn: null }, _sum: { amount: true } });
    return new D(total.toFixed()).minus(agg._sum.amount?.toFixed() ?? '0');
  }

  private async remainingOfCredit(tx: Tx, docId: string, total: Prisma.Decimal): Promise<Dec> {
    const agg = await tx.allocation.aggregate({ where: { creditDocumentId: docId, removedOn: null }, _sum: { amount: true } });
    return new D(total.toFixed()).minus(agg._sum.amount?.toFixed() ?? '0');
  }

  private async remainingOfPayment(tx: Tx, paymentId: string, amount: Prisma.Decimal): Promise<Dec> {
    const agg = await tx.allocation.aggregate({ where: { paymentId, removedOn: null }, _sum: { amount: true } });
    return new D(amount.toFixed()).minus(agg._sum.amount?.toFixed() ?? '0');
  }

  private async findIdempotentPayment(org: LedgerOrg, key: string, hash: string) {
    const p = await this.prisma.payment.findUnique({ where: { orgId_idempotencyKey: { orgId: org.id, idempotencyKey: key } }, include: PAY_INCLUDE });
    if (!p) return null;
    if (p.idempotencyHash !== hash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request', HttpStatus.UNPROCESSABLE_ENTITY);
    return this.serializePayment(org, p);
  }

  private assertKinds(ledger: Ledger, kinds: DocumentKind[]) {
    for (const k of kinds) if (ledgerOf(k) !== ledger) throw new DomainError('INVALID_KIND', `${k} does not belong to ${ledger.toLowerCase()}`);
  }

  private requirePermission(org: LedgerOrg, permission: 'journals.post' | 'journals.reverse', what: string) {
    if (!hasPermission(org.role, permission)) {
      throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${what}; it needs ${permission}`, HttpStatus.FORBIDDEN);
    }
  }

  /** Document numbers come from a counter row lock, so a P2002 here means a concurrent insert raced the unique index; retry once. */
  private async retryOnNumberRace<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String(e.meta?.target ?? '');
        if (target.includes('reference') || target.includes('bill')) {
          throw new DomainError('DUPLICATE_BILL', "This vendor's invoice number is already entered", HttpStatus.CONFLICT);
        }
        return fn();
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ serialisation

  private serializeDoc(org: LedgerOrg, d: DocWithAll) {
    const scale = minorUnits(d.currency);
    const total = new D(d.total.toFixed());
    const isCharge = d.kind === 'INVOICE' || d.kind === 'BILL';
    const used = (isCharge ? d.allocationsIn : d.allocationsOut).reduce((s, a) => s.plus(a.amount.toFixed()), new D(0));
    const open = d.status === 'POSTED' ? total.minus(used) : new D(0);
    const due = fromDbDate(d.dueDate);
    return {
      id: d.id,
      kind: d.kind,
      status: d.status,
      number: d.number,
      contact: d.contact,
      issueDate: fromDbDate(d.issueDate),
      dueDate: due,
      reference: d.reference,
      memo: d.memo,
      currency: d.currency,
      subtotal: d.subtotal.toFixed(scale),
      taxTotal: d.taxTotal.toFixed(scale),
      total: total.toFixed(scale),
      allocated: used.toFixed(scale),
      amountDue: open.toFixed(scale),
      paymentStatus: paymentStatus(d.status, total, used),
      isOverdue: d.status === 'POSTED' && isCharge && open.gt(0) && due < todayIso(),
      journalEntryId: d.journalEntryId,
      voidJournalEntryId: d.voidJournalEntryId,
      voidDate: d.voidDate ? fromDbDate(d.voidDate) : null,
      voidReason: d.voidReason,
      postedAt: d.postedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      lines: d.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        accountId: l.accountId,
        accountCode: l.account.code,
        accountName: l.account.name,
        quantity: l.quantity.toFixed(),
        unitPrice: l.unitPrice.toFixed(),
        taxRateId: l.taxRateId,
        taxName: l.tax?.name ?? null,
        taxRate: l.taxRate.toFixed(),
        netAmount: l.netAmount.toFixed(scale),
        taxAmount: l.taxAmount.toFixed(scale),
      })),
      allocations: isCharge
        ? d.allocationsIn.map((a) => ({
            id: a.id,
            amount: a.amount.toFixed(scale),
            date: fromDbDate(a.date),
            source: a.payment
              ? { type: 'payment' as const, id: a.payment.id, number: a.payment.number, kind: a.payment.kind }
              : { type: 'credit' as const, id: a.creditDocument!.id, number: a.creditDocument!.number, kind: a.creditDocument!.kind },
          }))
        : d.allocationsOut.map((a) => ({ id: a.id, amount: a.amount.toFixed(scale), date: fromDbDate(a.date), target: { id: a.target.id, number: a.target.number, kind: a.target.kind } })),
    };
  }

  private serializePayment(org: LedgerOrg, p: PayWithAll) {
    const scale = minorUnits(p.currency);
    const amount = new D(p.amount.toFixed());
    const used = p.allocations.reduce((s, a) => s.plus(a.amount.toFixed()), new D(0));
    return {
      id: p.id,
      kind: p.kind,
      status: p.status,
      number: p.number,
      contact: p.contact,
      date: fromDbDate(p.date),
      bankAccount: p.bankAccount,
      currency: p.currency,
      amount: amount.toFixed(scale),
      allocated: used.toFixed(scale),
      unallocated: (p.status === 'POSTED' ? amount.minus(used) : new D(0)).toFixed(scale),
      reference: p.reference,
      memo: p.memo,
      journalEntryId: p.journalEntryId,
      voidJournalEntryId: p.voidJournalEntryId,
      voidDate: p.voidDate ? fromDbDate(p.voidDate) : null,
      createdAt: p.createdAt.toISOString(),
      allocations: p.allocations.map((a) => ({ id: a.id, amount: a.amount.toFixed(scale), date: fromDbDate(a.date), target: { id: a.target.id, number: a.target.number, kind: a.target.kind } })),
    };
  }
}

function paymentStatus(status: string, total: Dec, used: Dec): 'UNPAID' | 'PARTIAL' | 'PAID' | null {
  if (status !== 'POSTED') return null;
  if (used.isZero()) return 'UNPAID';
  return used.gte(total) ? 'PAID' : 'PARTIAL';
}

function lineRows(lines: ReturnType<typeof computeDocument>['lines']) {
  return lines.map((l) => ({
    lineNo: l.lineNo,
    description: l.description ?? null,
    accountId: l.accountId,
    quantity: l.quantity.toFixed(),
    unitPrice: l.unitPrice.toFixed(),
    taxRateId: l.taxRateId,
    taxRate: l.taxRate.toFixed(),
    netAmount: l.netAmount.toFixed(),
    taxAmount: l.taxAmount.toFixed(),
  }));
}
