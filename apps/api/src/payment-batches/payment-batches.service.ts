import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { bankDetailIssues, batchItemIssues, D, dec, internationalBankIssues, maskAccountNumber, minorUnits, normaliseAccountNumber, paymentFileCsv, paymentsByVendor, type InternationalBankInput } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { DocumentsService } from '../ledgers/documents.service';
import { nextCounter } from '../db/counters';
import { holdLock, lockRow } from '../db/locks';
import { allowInTx } from '../db/guards/allow';

type Actor = { id: string };
export interface BatchOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}

export const batchRef = (n: number) => `PB-${String(n).padStart(4, '0')}`;

const BATCH_INCLUDE = { items: true } satisfies Prisma.PaymentBatchInclude;
type BatchRow = Prisma.PaymentBatchGetPayload<{ include: typeof BATCH_INCLUDE }>;

/**
 * Payment batches (AP-014) with vendor bank-detail control (AP-027). A batch of bills is prepared,
 * approved by someone other than who prepared it, sent to the bank as a payment file, and recorded
 * as paid: one payment per vendor through DocumentsService.recordPaymentInTx, so journals, bills,
 * ageing and statements behave exactly as for a payment entered by hand. The app never moves money.
 */
@Injectable()
export class PaymentBatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  can(org: BatchOrg) {
    return {
      prepare: hasPermission(org.role, 'purchases.manage'),
      approve: hasPermission(org.role, 'approvals.decide'),
      pay: hasPermission(org.role, 'purchases.manage') && hasPermission(org.role, 'journals.post'),
      editBankDetails: hasPermission(org.role, 'contacts.manage'),
      verifyBankDetails: hasPermission(org.role, 'approvals.decide'),
    };
  }

  // ------------------------------------------------------------------ vendor bank details

  async bankDetails(org: BatchOrg, contactId: string) {
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, orgId: org.id } });
    if (!contact) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contact not found' });
    const [d, history] = await Promise.all([
      this.prisma.vendorBankDetails.findUnique({ where: { contactId } }),
      this.prisma.vendorBankDetailChange.findMany({ where: { orgId: org.id, contactId }, orderBy: { changedAt: 'desc' }, take: 20 }),
    ]);
    const names = await this.names([d?.changedById, d?.verifiedById, ...history.map((h) => h.changedById)]);
    return {
      details: d ? this.serializeDetails(d, names) : null,
      history: history.map((h) => ({ before: h.beforeMasked, after: h.afterMasked, changedBy: names.get(h.changedById) ?? null, changedAt: h.changedAt.toISOString() })),
      can: this.can(org),
    };
  }

  /** Save a vendor's bank details. A change clears the verification and is kept in the history. */
  async saveBankDetails(org: BatchOrg, actor: Actor, contactId: string, input: { accountName: string; accountNumber: string; ifsc: string; bankName?: string | null }) {
    if (!this.can(org).editBankDetails) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Changing bank details needs contacts.manage' });
    const issues = bankDetailIssues(input);
    if (issues.length) throw new DomainError('BANK_DETAILS_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const next = { kind: 'DOMESTIC', accountName: input.accountName.trim(), accountNumber: normaliseAccountNumber(input.accountNumber), ifsc: input.ifsc.trim().toUpperCase(), bankName: input.bankName?.trim() || null, swiftBic: null, bankCountry: null, bankAddress: null, routingCode: null, intermediarySwift: null };
    return this.writeDetails(org, actor, contactId, next);
  }

  /** Save a vendor's bank account abroad (AP-023): SWIFT/BIC, IBAN or account number, bank country. */
  async saveInternationalBankDetails(org: BatchOrg, actor: Actor, contactId: string, input: InternationalBankInput) {
    if (!this.can(org).editBankDetails) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Changing bank details needs contacts.manage' });
    const home = (await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } })).countryCode;
    const issues = internationalBankIssues(input, home);
    if (issues.length) throw new DomainError('BANK_DETAILS_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
    const next = {
      kind: 'INTERNATIONAL',
      accountName: input.accountName.trim(),
      accountNumber: normaliseAccountNumber(input.accountNumber),
      ifsc: null,
      bankName: clean(input.bankName),
      swiftBic: input.swiftBic.replace(/\s/g, '').toUpperCase(),
      bankCountry: input.bankCountry.trim().toUpperCase(),
      bankAddress: clean(input.bankAddress),
      routingCode: clean(input.routingCode)?.replace(/[\s-]/g, '') ?? null,
      intermediarySwift: clean(input.intermediarySwift)?.replace(/\s/g, '').toUpperCase() ?? null,
    };
    return this.writeDetails(org, actor, contactId, next);
  }

  private async writeDetails(org: BatchOrg, actor: Actor, contactId: string, next: { kind: string; accountName: string; accountNumber: string; ifsc: string | null; bankName: string | null; swiftBic: string | null; bankCountry: string | null; bankAddress: string | null; routingCode: string | null; intermediarySwift: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const contact = await tx.contact.findFirst({ where: { id: contactId, orgId: org.id } });
      if (!contact) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contact not found' });
      if (!contact.isVendor) throw new DomainError('NOT_A_VENDOR', `${contact.name} is not a vendor`);
      const before = await tx.vendorBankDetails.findUnique({ where: { contactId } });
      if (before && (Object.keys(next) as (keyof typeof next)[]).every((k) => before[k] === next[k])) return;
      const describe = (d: { accountName: string; accountNumber: string; ifsc: string | null; swiftBic: string | null; bankCountry: string | null }) => `${d.accountName} · ${maskAccountNumber(d.accountNumber)} · ${d.ifsc ?? `${d.swiftBic} (${d.bankCountry})`}`;
      if (before) {
        await tx.vendorBankDetails.update({ where: { contactId }, data: { ...next, changedById: actor.id, changedAt: new Date(), verifiedById: null, verifiedAt: null, verificationNote: null } });
      } else {
        await tx.vendorBankDetails.create({ data: { contactId, orgId: org.id, ...next, changedById: actor.id } });
      }
      await tx.vendorBankDetailChange.create({ data: { orgId: org.id, contactId, beforeMasked: before ? describe(before) : null, afterMasked: describe(next), changedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'vendor_bank_details.changed', entityType: 'contact', entityId: contactId, data: { before: before ? describe(before) : null, after: describe(next) } });
    });
    return this.bankDetails(org, contactId);
  }

  /** Confirm the details with the vendor (for example by calling a known number), by someone other than who changed them. */
  async verifyBankDetails(org: BatchOrg, actor: Actor, contactId: string, input: { note: string }) {
    if (!this.can(org).verifyBankDetails) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Verifying bank details needs approvals.decide' });
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT contact_id FROM vendor_bank_details WHERE contact_id = ${contactId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      await holdLock(`vendor_bank_details:${contactId}`);
      const d = await tx.vendorBankDetails.findFirst({ where: { contactId, orgId: org.id } });
      if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'This vendor has no bank details' });
      if (d.verifiedAt) throw new DomainError('ALREADY_VERIFIED', 'These bank details are already verified', HttpStatus.CONFLICT);
      const self = d.changedById === actor.id;
      if (self) {
        if (await this.otherApprover(tx, org.id, actor.id)) throw new DomainError('SAME_PERSON', 'Bank details must be verified by someone other than the person who changed them', HttpStatus.CONFLICT);
        await tx.$executeRaw`SELECT set_config('t2t.allow_self_verify', 'on', true)`;
      }
      const verify = () => tx.vendorBankDetails.update({ where: { contactId }, data: { verifiedById: actor.id, verifiedAt: new Date(), verificationNote: input.note.trim() } });
      await (self ? allowInTx('allow_self_verify', async () => await verify()) : verify());
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'vendor_bank_details.verified', entityType: 'contact', entityId: contactId, data: { note: input.note.trim(), selfVerified: self } });
    });
    return this.bankDetails(org, contactId);
  }

  // ------------------------------------------------------------------ batches

  async list(org: BatchOrg) {
    const rows = await this.prisma.paymentBatch.findMany({ where: { orgId: org.id }, include: BATCH_INCLUDE, orderBy: { number: 'desc' }, take: 200 });
    const banks = await this.accounts(org.id, rows.map((r) => r.bankAccountId));
    return {
      batches: rows.map((b) => ({
        id: b.id,
        reference: batchRef(b.number),
        status: b.status,
        paymentDate: fromDbDate(b.paymentDate),
        currency: b.currency,
        bankAccount: banks.get(b.bankAccountId) ?? null,
        bills: b.items.length,
        vendors: new Set(b.items.map((i) => i.contactId)).size,
        total: b.items.reduce((s, i) => s.plus(i.amount.toFixed()), new D(0)).toFixed(minorUnits(b.currency)),
        memo: b.memo,
      })),
      can: this.can(org),
    };
  }

  /** Posted bills with something left to pay and not in another open batch, for adding to a batch. */
  async payableBills(org: BatchOrg, currency?: string) {
    const ccy = currency ?? org.functionalCurrency;
    const bills = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: 'BILL', status: 'POSTED', currency: ccy },
      include: { contact: { select: { id: true, name: true } } },
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    });
    const due = await this.dueOf(this.prisma, bills);
    const inOpen = new Map((await this.prisma.paymentBatchItem.findMany({ where: { orgId: org.id, open: true, documentId: { in: bills.map((b) => b.id) } } })).map((i) => [i.documentId, i.batchId]));
    const batchNumbers = new Map((await this.prisma.paymentBatch.findMany({ where: { id: { in: [...new Set(inOpen.values())] } }, select: { id: true, number: true } })).map((b) => [b.id, batchRef(b.number)]));
    const bank = await this.bankState(this.prisma, org.id, bills.map((b) => b.contactId));
    return bills
      .filter((b) => due.get(b.id)!.gt(0))
      .map((b) => ({
        id: b.id,
        number: b.number,
        vendor: b.contact,
        issueDate: fromDbDate(b.issueDate),
        dueDate: b.dueDate ? fromDbDate(b.dueDate) : null,
        currency: b.currency,
        due: due.get(b.id)!.toFixed(minorUnits(b.currency)),
        inBatch: inOpen.has(b.id) ? batchNumbers.get(inOpen.get(b.id)!) ?? null : null,
        bank: bank.get(b.contactId) ?? null,
      }));
  }

  async get(org: BatchOrg, id: string) {
    const b = await this.prisma.paymentBatch.findFirst({ where: { id, orgId: org.id }, include: BATCH_INCLUDE });
    if (!b) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment batch not found' });
    return this.serialize(this.prisma, org, b);
  }

  async create(org: BatchOrg, actor: Actor, input: { bankAccountId: string; paymentDate: string; memo?: string | null; items: { documentId: string; amount?: string | null }[] }) {
    this.assert(this.can(org).prepare, 'Preparing a payment batch needs purchases.manage');
    const id = await this.prisma.$transaction(async (tx) => {
      const bank = await this.checkBank(tx, org.id, input.bankAccountId);
      const [{ value: number }] = [{ value: await nextCounter(tx, org.id, 'payment_batch') }];
      const b = await tx.paymentBatch.create({ data: { orgId: org.id, number, bankAccountId: bank.id, paymentDate: toDbDate(input.paymentDate), currency: org.functionalCurrency, memo: input.memo?.trim() || null, createdById: actor.id } });
      await this.setItems(tx, org, b.id, b.currency, input.items);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_batch.created', entityType: 'payment_batch', entityId: b.id, data: { reference: batchRef(number), items: input.items.length } });
      return b.id;
    });
    return this.get(org, id);
  }

  async update(org: BatchOrg, actor: Actor, id: string, input: { bankAccountId?: string; paymentDate?: string; memo?: string | null; items?: { documentId: string; amount?: string | null }[] }) {
    this.assert(this.can(org).prepare, 'Changing a payment batch needs purchases.manage');
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, org.id, id);
      if (b.status !== 'DRAFT') throw new DomainError('NOT_DRAFT', 'Only a draft batch can be changed; cancel it and prepare a new one', HttpStatus.CONFLICT);
      if (input.bankAccountId) await this.checkBank(tx, org.id, input.bankAccountId);
      await tx.paymentBatch.update({ where: { id }, data: { bankAccountId: input.bankAccountId, paymentDate: input.paymentDate ? toDbDate(input.paymentDate) : undefined, memo: input.memo === undefined ? undefined : input.memo?.trim() || null } });
      if (input.items) {
        await tx.paymentBatchItem.deleteMany({ where: { batchId: id } });
        await this.setItems(tx, org, id, b.currency, input.items);
      }
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_batch.updated', entityType: 'payment_batch', entityId: id, data: { reference: batchRef(b.number), items: input.items?.length } });
    });
    return this.get(org, id);
  }

  async remove(org: BatchOrg, actor: Actor, id: string) {
    this.assert(this.can(org).prepare, 'Deleting a payment batch needs purchases.manage');
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, org.id, id);
      if (b.status !== 'DRAFT') throw new DomainError('NOT_DRAFT', 'Only a draft batch can be deleted; cancel it instead', HttpStatus.CONFLICT);
      await tx.paymentBatch.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_batch.deleted', entityType: 'payment_batch', entityId: id, data: { reference: batchRef(b.number) } });
    });
  }

  /** Approve a draft: by someone other than who prepared it, with every item payable and every vendor's bank details verified. */
  async approve(org: BatchOrg, actor: Actor, id: string) {
    this.assert(this.can(org).approve, 'Approving a payment batch needs approvals.decide');
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, org.id, id);
      if (b.status !== 'DRAFT') throw new DomainError('NOT_DRAFT', `This batch is ${b.status.toLowerCase()}`, HttpStatus.CONFLICT);
      if (b.items.length === 0) throw new DomainError('EMPTY_BATCH', 'Add at least one bill before approving', HttpStatus.CONFLICT);
      let self = false;
      if (b.createdById === actor.id) {
        if (await this.otherApprover(tx, org.id, actor.id)) throw new DomainError('SAME_PERSON', 'A payment batch must be approved by someone other than the person who prepared it', HttpStatus.CONFLICT);
        self = true;
      }
      await this.assertPayable(tx, org, b);
      await tx.paymentBatch.update({ where: { id }, data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date(), selfApproved: self } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_batch.approved', entityType: 'payment_batch', entityId: id, data: { reference: batchRef(b.number), selfApproved: self } });
    });
    return this.get(org, id);
  }

  /** The bank's bulk payment file for an approved batch: one row per vendor. */
  async paymentFile(org: BatchOrg, actor: Actor, id: string) {
    this.assert(this.can(org).pay, 'Downloading the payment file needs purchases.manage and journals.post');
    return this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, org.id, id);
      if (b.status !== 'APPROVED' && b.status !== 'PAID') throw new DomainError('NOT_APPROVED', 'The payment file is ready once the batch is approved', HttpStatus.CONFLICT);
      // Details are read now; any change since approval must have been verified again.
      await this.assertPayable(tx, org, b, b.status === 'PAID');
      const groups = paymentsByVendor(b.items.map((i) => ({ contactId: i.contactId, amount: i.amount.toFixed(), documentId: i.documentId })), b.currency);
      const [contacts, details, docs, bank] = await Promise.all([
        tx.contact.findMany({ where: { orgId: org.id, id: { in: groups.map((g) => g.contactId) } } }),
        tx.vendorBankDetails.findMany({ where: { orgId: org.id, contactId: { in: groups.map((g) => g.contactId) } } }),
        tx.document.findMany({ where: { orgId: org.id, id: { in: b.items.map((i) => i.documentId) } }, select: { id: true, number: true } }),
        tx.account.findUniqueOrThrow({ where: { id: b.bankAccountId } }),
      ]);
      const c = new Map(contacts.map((x) => [x.id, x]));
      const d = new Map(details.map((x) => [x.contactId, x]));
      const n = new Map(docs.map((x) => [x.id, x.number]));
      const csv = paymentFileCsv(
        { reference: batchRef(b.number), date: fromDbDate(b.paymentDate), debitAccount: `${bank.code} ${bank.name}`, currency: b.currency },
        groups.map((g) => ({
          vendor: c.get(g.contactId)!.name,
          accountName: d.get(g.contactId)!.accountName,
          accountNumber: d.get(g.contactId)!.accountNumber,
          ifsc: d.get(g.contactId)!.ifsc ?? '',
          amount: g.amount,
          // Banks keep about 30 characters of a reference: the bill numbers when they fit, else a count.
          reference: ((full) => (full.length <= 30 ? full : `${batchRef(b.number)} ${g.items.length} bills`))(`${batchRef(b.number)} ${g.items.map((i) => n.get(i.documentId)).join(' ')}`),
          email: c.get(g.contactId)!.email,
        })),
      );
      await tx.paymentBatch.update({ where: { id }, data: { fileDownloadedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_batch.file_downloaded', entityType: 'payment_batch', entityId: id, data: { reference: batchRef(b.number), vendors: groups.length } });
      return { filename: `${batchRef(b.number)}-${fromDbDate(b.paymentDate)}.csv`, csv };
    });
  }

  /** Once the bank has made the transfers: one payment per vendor, applied to its bills, on the batch's date. */
  async markPaid(org: BatchOrg, actor: Actor, id: string) {
    this.assert(this.can(org).pay, 'Recording the payments needs purchases.manage and journals.post');
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, org.id, id);
      if (b.status !== 'APPROVED') throw new DomainError('NOT_APPROVED', b.status === 'PAID' ? 'This batch is already paid' : 'Approve the batch first', HttpStatus.CONFLICT);
      await this.assertPayable(tx, org, b);
      const groups = paymentsByVendor(b.items.map((i) => ({ id: i.id, contactId: i.contactId, documentId: i.documentId, amount: i.amount.toFixed() })), b.currency);
      for (const g of groups) {
        const p = await this.documents.recordPaymentInTx(tx, org, actor, 'PURCHASES', {
          contactId: g.contactId,
          date: fromDbDate(b.paymentDate),
          bankAccountId: b.bankAccountId,
          amount: g.amount,
          currency: b.currency,
          reference: batchRef(b.number),
          memo: `Payment batch ${batchRef(b.number)}`,
          allocations: g.items.map((i) => ({ documentId: i.documentId, amount: i.amount })),
        });
        await tx.paymentBatchItem.updateMany({ where: { id: { in: g.items.map((i) => i.id) } }, data: { paymentId: p.id, open: false } });
      }
      await tx.paymentBatch.update({ where: { id }, data: { status: 'PAID', paidById: actor.id, paidAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_batch.paid', entityType: 'payment_batch', entityId: id, data: { reference: batchRef(b.number), payments: groups.length } });
    });
    return this.get(org, id);
  }

  async cancel(org: BatchOrg, actor: Actor, id: string, input: { reason: string }) {
    this.assert(this.can(org).prepare, 'Cancelling a payment batch needs purchases.manage');
    await this.prisma.$transaction(async (tx) => {
      const b = await this.lock(tx, org.id, id);
      if (b.status === 'PAID' || b.status === 'CANCELLED') throw new DomainError('FINAL', `This batch is ${b.status.toLowerCase()}`, HttpStatus.CONFLICT);
      await tx.paymentBatchItem.updateMany({ where: { batchId: id }, data: { open: false } });
      await tx.paymentBatch.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: actor.id, cancelledAt: new Date(), cancelReason: input.reason.trim() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'payment_batch.cancelled', entityType: 'payment_batch', entityId: id, data: { reference: batchRef(b.number), reason: input.reason.trim(), wasApproved: b.status === 'APPROVED' } });
    });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ helpers

  private async setItems(tx: Tx, org: BatchOrg, batchId: string, currency: string, items: { documentId: string; amount?: string | null }[]) {
    const ids = items.map((i) => i.documentId);
    if (new Set(ids).size !== ids.length) throw new DomainError('DUPLICATE_BILL', 'A bill is listed twice');
    const bills = await tx.document.findMany({ where: { orgId: org.id, id: { in: ids } } });
    const byId = new Map(bills.map((b) => [b.id, b]));
    const due = await this.dueOf(tx, bills);
    const taken = await tx.paymentBatchItem.findMany({ where: { orgId: org.id, open: true, documentId: { in: ids }, batchId: { not: batchId } } });
    const takenBatches = new Map((await tx.paymentBatch.findMany({ where: { id: { in: taken.map((t) => t.batchId) } }, select: { id: true, number: true } })).map((b) => [b.id, b.number]));
    for (const i of items) {
      const b = byId.get(i.documentId);
      if (!b || b.kind !== 'BILL') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bill not found' });
      if (b.status !== 'POSTED') throw new DomainError('NOT_POSTED', `${b.number} is not posted`, HttpStatus.CONFLICT);
      if (b.currency !== currency) throw new DomainError('CURRENCY_MISMATCH', `${b.number} is in ${b.currency}; this batch pays ${currency}`);
      const t = taken.find((x) => x.documentId === b.id);
      if (t) throw new DomainError('IN_ANOTHER_BATCH', `${b.number} is already in ${batchRef(takenBatches.get(t.batchId)!)}`, HttpStatus.CONFLICT);
      const left = due.get(b.id)!;
      const amount = i.amount ? dec(i.amount) : left;
      if (amount.lte(0)) throw new DomainError('NOTHING_DUE', `${b.number} has nothing left to pay`, HttpStatus.CONFLICT);
      if (amount.gt(left)) throw new DomainError('MORE_THAN_DUE', `${b.number} has ${left.toFixed(minorUnits(currency))} ${currency} left to pay`, HttpStatus.UNPROCESSABLE_ENTITY);
      await tx.paymentBatchItem.create({ data: { orgId: org.id, batchId, documentId: b.id, contactId: b.contactId, amount: amount.toFixed() } });
    }
  }

  private async assertPayable(tx: Tx, org: BatchOrg, b: BatchRow, paid = false) {
    const docs = await tx.document.findMany({ where: { orgId: org.id, id: { in: b.items.map((i) => i.documentId) } }, include: { contact: { select: { name: true } } } });
    const due = await this.dueOf(tx, docs);
    const bank = await this.bankState(tx, org.id, docs.map((d) => d.contactId));
    const byId = new Map(docs.map((d) => [d.id, d]));
    const issues = batchItemIssues(
      b.items.map((i) => {
        const d = byId.get(i.documentId)!;
        return { documentId: d.id, number: d.number ?? 'Draft bill', vendor: d.contact.name, amount: i.amount.toFixed(), due: paid ? i.amount.toFixed() : due.get(d.id)!.toFixed(), billStatus: paid ? 'POSTED' : d.status, bank: bank.get(d.contactId) ?? null };
      }),
      b.currency,
    );
    if (issues.length) throw new DomainError('BATCH_NOT_PAYABLE', issues[0]!.issue, HttpStatus.CONFLICT, { issues });
  }

  private async serialize(db: Tx | PrismaService, org: BatchOrg, b: BatchRow) {
    const scale = minorUnits(b.currency);
    const docs = await db.document.findMany({ where: { orgId: org.id, id: { in: b.items.map((i) => i.documentId) } }, include: { contact: { select: { id: true, name: true, email: true } } } });
    const byId = new Map(docs.map((d) => [d.id, d]));
    const due = await this.dueOf(db, docs);
    const bank = await this.bankState(db, org.id, docs.map((d) => d.contactId));
    const payments = await db.payment.findMany({ where: { orgId: org.id, id: { in: b.items.map((i) => i.paymentId).filter((x): x is string => !!x) } }, select: { id: true, number: true } });
    const pay = new Map(payments.map((p) => [p.id, p.number]));
    const banks = await this.accounts(org.id, [b.bankAccountId]);
    const names = await this.names([b.createdById, b.approvedById, b.paidById, b.cancelledById]);
    const items = b.items
      .map((i) => {
        const d = byId.get(i.documentId)!;
        return {
          id: i.id,
          documentId: d.id,
          number: d.number ?? 'Draft bill',
          vendor: d.contact,
          dueDate: d.dueDate ? fromDbDate(d.dueDate) : null,
          amount: i.amount.toFixed(scale),
          due: due.get(d.id)!.toFixed(scale),
          billStatus: d.status,
          bank: bank.get(d.contactId) ?? null,
          payment: i.paymentId ? { id: i.paymentId, number: pay.get(i.paymentId) ?? null } : null,
        };
      })
      .sort((x, y) => x.vendor.name.localeCompare(y.vendor.name) || x.number.localeCompare(y.number));
    const issues = b.status === 'DRAFT' || b.status === 'APPROVED'
      ? batchItemIssues(items.map((i) => ({ documentId: i.documentId, number: i.number, vendor: i.vendor.name, amount: i.amount, due: i.due, billStatus: i.billStatus, bank: i.bank })), b.currency)
      : [];
    return {
      id: b.id,
      reference: batchRef(b.number),
      status: b.status,
      paymentDate: fromDbDate(b.paymentDate),
      currency: b.currency,
      bankAccount: banks.get(b.bankAccountId) ?? null,
      memo: b.memo,
      items,
      total: b.items.reduce((s, i) => s.plus(i.amount.toFixed()), new D(0)).toFixed(scale),
      vendors: paymentsByVendor(items.map((i) => ({ contactId: i.vendor.id, amount: i.amount, name: i.vendor.name, bank: i.bank })), b.currency).map((g) => ({ contactId: g.contactId, name: g.items[0]!.name, amount: g.amount, bills: g.items.length, bank: g.items[0]!.bank })),
      issues,
      createdBy: names.get(b.createdById) ?? null,
      createdById: b.createdById,
      createdAt: b.createdAt.toISOString(),
      approvedBy: b.approvedById ? names.get(b.approvedById) ?? null : null,
      approvedAt: b.approvedAt?.toISOString() ?? null,
      selfApproved: b.selfApproved,
      fileDownloadedAt: b.fileDownloadedAt?.toISOString() ?? null,
      paidBy: b.paidById ? names.get(b.paidById) ?? null : null,
      paidAt: b.paidAt?.toISOString() ?? null,
      cancelledBy: b.cancelledById ? names.get(b.cancelledById) ?? null : null,
      cancelledAt: b.cancelledAt?.toISOString() ?? null,
      cancelReason: b.cancelReason,
      can: this.can(org),
    };
  }

  private serializeDetails(d: { kind: string; accountName: string; accountNumber: string; ifsc: string | null; bankName: string | null; swiftBic: string | null; bankCountry: string | null; bankAddress: string | null; routingCode: string | null; intermediarySwift: string | null; changedById: string; changedAt: Date; verifiedById: string | null; verifiedAt: Date | null; verificationNote: string | null }, names: Map<string, string>) {
    return {
      accountName: d.accountName,
      accountNumberMasked: maskAccountNumber(d.accountNumber),
      ifsc: d.ifsc,
      bankName: d.bankName,
      kind: d.kind,
      swiftBic: d.swiftBic,
      bankCountry: d.bankCountry,
      bankAddress: d.bankAddress,
      routingCode: d.routingCode,
      intermediarySwift: d.intermediarySwift,
      changedBy: names.get(d.changedById) ?? null,
      changedById: d.changedById,
      changedAt: d.changedAt.toISOString(),
      verified: !!d.verifiedAt,
      verifiedBy: d.verifiedById ? names.get(d.verifiedById) ?? null : null,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      verificationNote: d.verificationNote,
    };
  }

  private async bankState(db: Tx | PrismaService, orgId: string, contactIds: string[]) {
    const rows = await db.vendorBankDetails.findMany({ where: { orgId, contactId: { in: [...new Set(contactIds)] } } });
    return new Map(rows.map((r) => [r.contactId, { hasDetails: true, verified: !!r.verifiedAt, international: r.kind === 'INTERNATIONAL', accountNumberMasked: maskAccountNumber(r.accountNumber), ifsc: r.ifsc, changedAt: r.changedAt.toISOString() }]));
  }

  private async dueOf(db: Tx | PrismaService, docs: { id: string; total: Prisma.Decimal }[]) {
    const agg = docs.length ? await db.allocation.groupBy({ by: ['targetId'], where: { targetId: { in: docs.map((d) => d.id) }, removedOn: null }, _sum: { amount: true } }) : [];
    const used = new Map(agg.map((a) => [a.targetId, new D((a._sum.amount ?? 0).toString())]));
    return new Map(docs.map((d) => [d.id, new D(d.total.toFixed()).minus(used.get(d.id) ?? 0)]));
  }

  private async accounts(orgId: string, ids: string[]) {
    const rows = await this.prisma.account.findMany({ where: { orgId, id: { in: [...new Set(ids)] } }, select: { id: true, code: true, name: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async names(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async checkBank(tx: Tx, orgId: string, id: string) {
    const bank = await tx.account.findFirst({ where: { id, orgId } });
    if (!bank || !bank.isPostable || !bank.isActive || bank.subtype !== 'BANK') throw new DomainError('INVALID_BANK_ACCOUNT', 'Choose an active bank account');
    return bank;
  }

  private async lock(tx: Tx, orgId: string, id: string) {
    await lockRow(tx, 'payment_batches', id, orgId);
    const b = await tx.paymentBatch.findFirst({ where: { id, orgId }, include: BATCH_INCLUDE });
    if (!b) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment batch not found' });
    return b;
  }

  /** Whether another member could approve or verify instead of this one. */
  private async otherApprover(tx: Tx, orgId: string, userId: string) {
    const members = await tx.membership.findMany({ where: { orgId, userId: { not: userId } }, select: { role: true } });
    return members.some((m) => hasPermission(m.role as RoleName, 'approvals.decide'));
  }

  private assert(ok: boolean, message: string) {
    if (!ok) throw new ForbiddenException({ error: 'FORBIDDEN', message });
  }
}
