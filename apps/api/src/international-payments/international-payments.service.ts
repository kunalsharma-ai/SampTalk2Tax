import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { atRateInr, CHARGES, D, dec, form15Requirement, instructionCsv, maskAccountNumber, minorUnits, PURPOSE_CODE_PATTERN, PURPOSE_CODES, remittanceIssues, remittanceRef, type Charges, type Form15Part } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { DocumentsService } from '../ledgers/documents.service';

type Actor = { id: string };
export interface RemitOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
export interface RemittanceInput {
  contactId: string;
  bankAccountId: string;
  paymentDate: string;
  currency: string;
  items: { documentId: string; amount?: string | null }[];
  purposeCode?: string | null;
  purpose?: string | null;
  charges?: Charges;
  taxableInIndia?: boolean;
  hasTaxOrder?: boolean;
  estimateRate?: string | null;
  form15caAck?: string | null;
  form15cbNumber?: string | null;
  memo?: string | null;
}

const INCLUDE = { items: true } satisfies Prisma.InternationalPaymentInclude;
type Row = Prisma.InternationalPaymentGetPayload<{ include: typeof INCLUDE }>;
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

/** The Indian financial year (April to March) a date falls in, as its first and last day. */
function indianFy(date: string) {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/**
 * International payments (AP-023): outward remittances to vendors abroad. Prepared against the
 * vendor's foreign-currency bills with the purpose of payment and, for an Indian organisation, the
 * Form 15CA/15CB position; approved by a second person; the remittance instruction is downloaded for
 * the bank (which marks it sent); and recorded as paid at the bank's rate through
 * DocumentsService.recordPaymentInTx, so the payment, the realised exchange difference, the bills and
 * the vendor's statement behave as for any payment. The app never moves money.
 */
@Injectable()
export class InternationalPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  can(org: RemitOrg) {
    return {
      manage: hasPermission(org.role, 'purchases.manage'),
      approve: hasPermission(org.role, 'approvals.decide'),
      pay: hasPermission(org.role, 'purchases.manage') && hasPermission(org.role, 'journals.post'),
    };
  }

  private need(ok: boolean, message: string) {
    if (!ok) throw new ForbiddenException({ error: 'FORBIDDEN', message });
  }

  private invalid(message: string, code = 'REMITTANCE_INVALID', status = HttpStatus.UNPROCESSABLE_ENTITY, details?: unknown): never {
    throw new DomainError(code, message, status, details);
  }

  private async home(db: Tx | PrismaService, orgId: string) {
    const o = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true, name: true, legalName: true } });
    const gst = await db.gstRegistration.findUnique({ where: { orgId }, select: { gstin: true, legalName: true } });
    // An Indian GSTIN carries the PAN in characters 3 to 12.
    return { countryCode: o.countryCode, name: gst?.legalName ?? o.legalName ?? o.name, address: null as string | null, pan: gst ? gst.gstin.slice(2, 12) : null };
  }

  // ------------------------------------------------------------------ reading

  /** Posted foreign-currency bills with something left to pay, by vendor, with where each already sits. */
  async payable(org: RemitOrg) {
    const bills = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: 'BILL', status: 'POSTED', currency: { not: org.functionalCurrency } },
      include: { contact: { select: { id: true, name: true } } },
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    });
    const due = await this.dueOf(this.prisma, bills);
    const inOpen = await this.openItems(this.prisma, org.id, bills.map((b) => b.id));
    const banks = await this.prisma.vendorBankDetails.findMany({ where: { orgId: org.id, contactId: { in: [...new Set(bills.map((b) => b.contactId))] } } });
    const bank = new Map(banks.map((b) => [b.contactId, { international: b.kind === 'INTERNATIONAL', verified: !!b.verifiedAt, swiftBic: b.swiftBic, bankCountry: b.bankCountry }]));
    return bills
      .filter((b) => due.get(b.id)!.gt(0))
      .map((b) => ({
        id: b.id,
        number: b.number,
        vendorInvoice: b.reference,
        vendor: b.contact,
        issueDate: fromDbDate(b.issueDate),
        dueDate: b.dueDate ? fromDbDate(b.dueDate) : null,
        currency: b.currency,
        due: due.get(b.id)!.toFixed(minorUnits(b.currency)),
        inPayment: inOpen.get(b.id) ?? null,
        bank: bank.get(b.contactId) ?? null,
      }));
  }

  async list(org: RemitOrg, f: { status?: string }) {
    const rows = await this.prisma.internationalPayment.findMany({ where: { orgId: org.id, ...(f.status ? { status: f.status } : {}) }, orderBy: { number: 'desc' }, take: 300 });
    const contacts = new Map((await this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.map((r) => r.contactId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const counts = { DRAFT: 0, APPROVED: 0, SENT: 0, PAID: 0, CANCELLED: 0 } as Record<string, number>;
    for (const r of await this.prisma.internationalPayment.groupBy({ by: ['status'], where: { orgId: org.id }, _count: true })) counts[r.status] = r._count;
    return {
      payments: rows.map((r) => ({
        id: r.id,
        reference: remittanceRef(r.number),
        vendor: { id: r.contactId, name: contacts.get(r.contactId) ?? '' },
        status: r.status,
        paymentDate: fromDbDate(r.paymentDate),
        currency: r.currency,
        amount: new D(r.amount.toFixed()).toFixed(minorUnits(r.currency)),
        purposeCode: r.purposeCode,
        form15Part: r.form15Part,
        inr: r.paidRate ? atRateInr(r.amount.toFixed(), r.paidRate.toFixed()) : r.estimateRate ? atRateInr(r.amount.toFixed(), r.estimateRate.toFixed()) : null,
        paid: !!r.paidRate,
      })),
      counts,
      purposeCodes: PURPOSE_CODES,
      charges: CHARGES,
      can: this.can(org),
    };
  }

  async get(org: RemitOrg, id: string, actor?: Actor) {
    const r = await this.prisma.internationalPayment.findFirst({ where: { orgId: org.id, id }, include: INCLUDE });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'International payment not found' });
    return this.serialize(this.prisma, org, r, actor);
  }

  // ------------------------------------------------------------------ preparing

  async create(org: RemitOrg, actor: Actor, input: RemittanceInput) {
    this.need(this.can(org).manage, 'Preparing an international payment needs purchases.manage');
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('international_payments'), hashtext(${org.id}))`;
      const n = ((await tx.internationalPayment.aggregate({ where: { orgId: org.id }, _max: { number: true } }))._max.number ?? 0) + 1;
      const row = await tx.internationalPayment.create({ data: { orgId: org.id, number: n, contactId: input.contactId, bankAccountId: input.bankAccountId, paymentDate: toDbDate(input.paymentDate), currency: input.currency.toUpperCase(), createdById: actor.id } });
      await this.apply(tx, org, row.id, input);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'international_payment.prepared', entityType: 'international_payment', entityId: row.id, data: { reference: remittanceRef(n), contactId: input.contactId, currency: input.currency } });
      return row.id;
    });
    return this.get(org, id, actor);
  }

  async update(org: RemitOrg, actor: Actor, id: string, input: RemittanceInput) {
    this.need(this.can(org).manage, 'Changing an international payment needs purchases.manage');
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status !== 'DRAFT') this.invalid('Only a draft can be changed; cancel it and prepare a new one', 'NOT_DRAFT', HttpStatus.CONFLICT);
      await tx.internationalPayment.update({ where: { id }, data: { contactId: input.contactId, bankAccountId: input.bankAccountId, paymentDate: toDbDate(input.paymentDate), currency: input.currency.toUpperCase() } });
      await this.apply(tx, org, id, input);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'international_payment.changed', entityType: 'international_payment', entityId: id, data: { reference: remittanceRef(r.number) } });
    });
    return this.get(org, id, actor);
  }

  /** Checks the vendor, account and bills, and stores everything that follows from them. */
  private async apply(tx: Tx, org: RemitOrg, id: string, input: RemittanceInput) {
    const currency = input.currency.toUpperCase();
    if (currency === org.functionalCurrency) this.invalid(`International payments are in the vendor's currency; pay ${org.functionalCurrency} bills with a payment or a payment batch`);
    const contact = await tx.contact.findFirst({ where: { orgId: org.id, id: input.contactId } });
    if (!contact?.isVendor) this.invalid('Choose a vendor');
    const bank = await tx.account.findFirst({ where: { orgId: org.id, id: input.bankAccountId } });
    if (!bank || !bank.isPostable || !bank.isActive || bank.subtype !== 'BANK') this.invalid('Choose an active bank account to pay from');
    const purposeCode = clean(input.purposeCode)?.toUpperCase() ?? null;
    if (purposeCode && !PURPOSE_CODE_PATTERN.test(purposeCode)) this.invalid('A purpose code is a letter (P or S) and four digits, such as S0802');
    if (!input.items.length) this.invalid('Add at least one bill');
    if (new Set(input.items.map((i) => i.documentId)).size !== input.items.length) this.invalid('A bill is listed twice');
    const docs = await tx.document.findMany({ where: { orgId: org.id, id: { in: input.items.map((i) => i.documentId) } } });
    const due = await this.dueOf(tx, docs);
    const open = await this.openItems(tx, org.id, docs.map((d) => d.id), id);
    const items = input.items.map((i) => {
      const d = docs.find((x) => x.id === i.documentId);
      if (!d || d.kind !== 'BILL' || d.status !== 'POSTED') this.invalid('Only posted bills can be paid');
      if (d.contactId !== contact.id) this.invalid(`${d.number} is not from ${contact.name}`);
      if (d.currency !== currency) this.invalid(`${d.number} is in ${d.currency}, not ${currency}`);
      if (open.has(d.id)) this.invalid(`${d.number} is already in ${open.get(d.id)}`);
      const left = due.get(d.id)!;
      const amount = i.amount ? dec(i.amount) : left;
      if (amount.lte(0)) this.invalid(`${d.number} has nothing left to pay`);
      if (amount.gt(left)) this.invalid(`${d.number} has ${left.toFixed(minorUnits(currency))} ${currency} left to pay`);
      return { documentId: d.id, amount: amount.toFixed(minorUnits(currency)) };
    });
    const total = items.reduce((s, i) => s.plus(i.amount), new D(0));
    const estimateRate = clean(input.estimateRate) ?? (await this.rateOn(tx, org.id, currency, input.paymentDate));
    if (estimateRate && !new D(estimateRate).gt(0)) this.invalid('The expected exchange rate must be above zero');
    const f15 = await this.form15(tx, org, { contactId: contact.id, purposeCode: purposeCode ?? '', taxableInIndia: input.taxableInIndia ?? true, hasTaxOrder: input.hasTaxOrder ?? false, date: input.paymentDate, inr: estimateRate ? atRateInr(total.toFixed(), estimateRate) : '0', excludeId: id });
    await tx.internationalPaymentItem.deleteMany({ where: { remittanceId: id } });
    await tx.internationalPaymentItem.createMany({ data: items.map((i) => ({ orgId: org.id, remittanceId: id, documentId: i.documentId, amount: i.amount })) });
    const known = PURPOSE_CODES.find((p) => p.code === purposeCode);
    await tx.internationalPayment.update({
      where: { id },
      data: {
        amount: total.toFixed(),
        estimateRate,
        purposeCode,
        purpose: clean(input.purpose) ?? known?.label ?? null,
        charges: input.charges ?? 'OUR',
        taxableInIndia: input.taxableInIndia ?? true,
        hasTaxOrder: input.hasTaxOrder ?? false,
        form15Part: f15.part,
        needs15cb: f15.needs15cb,
        form15caAck: f15.part === 'NONE' ? null : clean(input.form15caAck),
        form15cbNumber: f15.needs15cb ? clean(input.form15cbNumber) : null,
        memo: clean(input.memo),
      },
    });
  }

  /** The Form 15CA/15CB position, counting what was already sent to this vendor this financial year. */
  private async form15(db: Tx | PrismaService, org: RemitOrg, x: { contactId: string; purposeCode: string; taxableInIndia: boolean; hasTaxOrder: boolean; date: string; inr: string; excludeId?: string }) {
    const home = await this.home(db, org.id);
    const fy = indianFy(x.date);
    const prior = await db.internationalPayment.findMany({ where: { orgId: org.id, contactId: x.contactId, status: { in: ['APPROVED', 'SENT', 'PAID'] }, paymentDate: { gte: toDbDate(fy.from), lte: toDbDate(fy.to) }, ...(x.excludeId ? { id: { not: x.excludeId } } : {}) }, select: { amount: true, paidRate: true, estimateRate: true } });
    const before = prior.reduce((s, p) => s.plus(atRateInr(p.amount.toFixed(), (p.paidRate ?? p.estimateRate ?? new Prisma.Decimal(0)).toFixed())), new D(0));
    const r = form15Requirement({ homeCountry: home.countryCode, purposeCode: x.purposeCode, taxableInIndia: x.taxableInIndia, hasOrder: x.hasTaxOrder, inrThisYear: before.plus(x.inr).toFixed(2) });
    return { ...r, inrThisYear: before.plus(x.inr).toFixed(2), inrBefore: before.toFixed(2) };
  }

  async remove(org: RemitOrg, actor: Actor, id: string) {
    this.need(this.can(org).manage, 'Deleting an international payment needs purchases.manage');
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status !== 'DRAFT') this.invalid('Only a draft can be deleted; cancel it instead', 'NOT_DRAFT', HttpStatus.CONFLICT);
      await tx.internationalPayment.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'international_payment.deleted', entityType: 'international_payment', entityId: id, data: { reference: remittanceRef(r.number) } });
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------ approving, sending, paying

  async approve(org: RemitOrg, actor: Actor, id: string) {
    this.need(this.can(org).approve, 'Approving an international payment needs approvals.decide');
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status !== 'DRAFT') this.invalid(`This payment is ${r.status.toLowerCase()}`, 'NOT_DRAFT', HttpStatus.CONFLICT);
      const s = await this.serialize(tx, org, r);
      if (s.issues.length) this.invalid(s.issues[0]!, 'REMITTANCE_NOT_READY', HttpStatus.CONFLICT, { issues: s.issues });
      if (s.form15.part !== r.form15Part || s.form15.needs15cb !== r.needs15cb) this.invalid('The Form 15CA position has changed since this was saved; save it again and check the form details', 'REMITTANCE_NOT_READY', HttpStatus.CONFLICT);
      const self = r.createdById === actor.id;
      if (self && (await this.otherApprover(tx, org.id, actor.id))) this.invalid('An international payment must be approved by someone other than the person who prepared it', 'SAME_PERSON', HttpStatus.CONFLICT);
      await tx.internationalPayment.update({ where: { id }, data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date(), selfApproved: self } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'international_payment.approved', entityType: 'international_payment', entityId: id, data: { reference: remittanceRef(r.number), amount: r.amount.toFixed(), currency: r.currency, form15Part: r.form15Part, selfApproved: self } });
    });
    return this.get(org, id, actor);
  }

  /** The remittance instruction for the bank. The first download marks the payment as sent. */
  async instruction(org: RemitOrg, actor: Actor, id: string) {
    this.need(this.can(org).pay, 'Downloading the remittance instruction needs purchases.manage and journals.post');
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (!['APPROVED', 'SENT', 'PAID'].includes(r.status)) this.invalid('The instruction is ready once the payment is approved', 'NOT_APPROVED', HttpStatus.CONFLICT);
      const [home, contact, bank, account, docs] = await Promise.all([
        this.home(tx, org.id),
        tx.contact.findUniqueOrThrow({ where: { id: r.contactId } }),
        tx.vendorBankDetails.findFirst({ where: { orgId: org.id, contactId: r.contactId } }),
        tx.account.findUniqueOrThrow({ where: { id: r.bankAccountId } }),
        tx.document.findMany({ where: { orgId: org.id, id: { in: r.items.map((i) => i.documentId) } }, select: { number: true, reference: true } }),
      ]);
      // Read now: details changed since approval must have been verified again.
      if (!bank || bank.kind !== 'INTERNATIONAL' || !bank.verifiedAt) this.invalid("The vendor's international bank details changed and are not verified; verify them before sending", 'BANK_NOT_VERIFIED', HttpStatus.CONFLICT);
      const csv = instructionCsv({
        reference: remittanceRef(r.number),
        date: fromDbDate(r.paymentDate),
        debitAccount: `${account.code} ${account.name}`,
        remitter: { name: home.name, address: home.address, pan: home.pan },
        beneficiary: { name: contact.name, address: contact.address, country: bank.bankCountry, accountName: bank.accountName, account: bank.accountNumber, swift: bank.swiftBic!, bankName: bank.bankName, bankAddress: bank.bankAddress, bankCountry: bank.bankCountry!, routingCode: bank.routingCode, intermediarySwift: bank.intermediarySwift },
        currency: r.currency,
        amount: new D(r.amount.toFixed()).toFixed(minorUnits(r.currency)),
        purposeCode: r.purposeCode!,
        purpose: r.purpose ?? '',
        charges: r.charges as Charges,
        invoices: docs.map((d) => `${d.number}${d.reference ? ` (${d.reference})` : ''}`),
        form15: { part: r.form15Part as Form15Part, ack: r.form15caAck, cb: r.form15cbNumber },
      });
      if (r.status === 'APPROVED') await tx.internationalPayment.update({ where: { id }, data: { status: 'SENT', sentById: actor.id, sentAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'international_payment.instruction_downloaded', entityType: 'international_payment', entityId: id, data: { reference: remittanceRef(r.number) } });
      return { filename: `${remittanceRef(r.number)}-${fromDbDate(r.paymentDate)}.csv`, csv };
    });
  }

  /** The bank confirmed the remittance: record the payment at the rate the bank applied. */
  async markPaid(org: RemitOrg, actor: Actor, id: string, input: { rate: string; date?: string | null; bankReference?: string | null }) {
    this.need(this.can(org).pay, 'Recording the payment needs purchases.manage and journals.post');
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status !== 'SENT') this.invalid(r.status === 'PAID' ? 'This payment is already recorded' : 'Send the instruction to the bank first', 'NOT_SENT', HttpStatus.CONFLICT);
      if (!new D(input.rate).gt(0)) this.invalid('Enter the rate the bank applied');
      const date = input.date ?? fromDbDate(r.paymentDate);
      const p = await this.documents.recordPaymentInTx(tx, org, actor, 'PURCHASES', {
        contactId: r.contactId,
        date,
        bankAccountId: r.bankAccountId,
        amount: r.amount.toFixed(),
        currency: r.currency,
        exchangeRate: input.rate,
        reference: clean(input.bankReference) ?? remittanceRef(r.number),
        memo: `International payment ${remittanceRef(r.number)}`,
        allocations: r.items.map((i) => ({ documentId: i.documentId, amount: i.amount.toFixed() })),
      });
      await tx.internationalPayment.update({ where: { id }, data: { status: 'PAID', paidRate: input.rate, bankReference: clean(input.bankReference), paymentId: p.id, paidById: actor.id, paidAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'international_payment.paid', entityType: 'international_payment', entityId: id, data: { reference: remittanceRef(r.number), rate: input.rate, payment: p.number } });
    });
    return this.get(org, id, actor);
  }

  async cancel(org: RemitOrg, actor: Actor, id: string, reason: string) {
    this.need(this.can(org).manage, 'Cancelling an international payment needs purchases.manage');
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status === 'PAID') this.invalid('A paid international payment cannot be cancelled; void its payment instead', 'ALREADY_PAID', HttpStatus.CONFLICT);
      if (r.status === 'CANCELLED') this.invalid('This payment is already cancelled', 'ALREADY_CANCELLED', HttpStatus.CONFLICT);
      await tx.internationalPayment.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: actor.id, cancelledAt: new Date(), cancelReason: reason.trim() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'international_payment.cancelled', entityType: 'international_payment', entityId: id, data: { reference: remittanceRef(r.number), reason: reason.trim(), wasSent: r.status === 'SENT' } });
    });
    return this.get(org, id, actor);
  }

  // ------------------------------------------------------------------ helpers

  private async serialize(db: Tx | PrismaService, org: RemitOrg, r: Row, actor?: Actor) {
    const [contact, bank, account, docs, users, payment, home] = await Promise.all([
      db.contact.findUniqueOrThrow({ where: { id: r.contactId }, select: { id: true, name: true, email: true } }),
      db.vendorBankDetails.findFirst({ where: { orgId: org.id, contactId: r.contactId } }),
      db.account.findUniqueOrThrow({ where: { id: r.bankAccountId }, select: { id: true, code: true, name: true } }),
      db.document.findMany({ where: { orgId: org.id, id: { in: r.items.map((i) => i.documentId) } } }),
      db.user.findMany({ where: { id: { in: [r.createdById, r.approvedById, r.sentById, r.paidById, r.cancelledById].filter((x): x is string => !!x) } }, select: { id: true, name: true, email: true } }),
      r.paymentId ? db.payment.findUnique({ where: { id: r.paymentId }, select: { id: true, number: true } }) : null,
      this.home(db, org.id),
    ]);
    const name = new Map(users.map((u) => [u.id, u.name || u.email]));
    const due = await this.dueOf(db, docs);
    const scale = minorUnits(r.currency);
    const doc = new Map(docs.map((d) => [d.id, d]));
    const items = r.items.map((i) => {
      const d = doc.get(i.documentId)!;
      return { documentId: d.id, number: d.number ?? '', vendorInvoice: d.reference, currency: d.currency, status: d.status, total: new D(d.total.toFixed()).toFixed(scale), due: due.get(d.id)!.toFixed(scale), amount: new D(i.amount.toFixed()).toFixed(scale) };
    });
    const amount = new D(r.amount.toFixed()).toFixed(scale);
    const inr = r.estimateRate ? atRateInr(r.amount.toFixed(), r.estimateRate.toFixed()) : null;
    const f15 = await this.form15(db, org, { contactId: r.contactId, purposeCode: r.purposeCode ?? '', taxableInIndia: r.taxableInIndia, hasTaxOrder: r.hasTaxOrder, date: fromDbDate(r.paymentDate), inr: inr ?? '0', excludeId: r.id });
    const issues = r.status === 'DRAFT'
      ? [
          ...remittanceIssues({
            bank: bank ? { international: bank.kind === 'INTERNATIONAL', verified: !!bank.verifiedAt } : null,
            purposeCode: r.purposeCode,
            part: f15.part,
            needs15cb: f15.needs15cb,
            form15caAck: r.form15caAck,
            form15cbNumber: r.form15cbNumber,
            currency: r.currency,
            // While a draft, the amounts are checked against what is left to pay now.
            items: items.map((i) => ({ number: i.number, currency: i.currency, status: i.status, due: i.due, amount: i.amount })),
          }),
          ...(home.countryCode === 'IN' && !r.estimateRate ? [`Enter the expected ${r.currency} rate, or add one under Exchange rates, to work out the Form 15CA position`] : []),
        ]
      : [];
    return {
      id: r.id,
      reference: remittanceRef(r.number),
      status: r.status,
      vendor: contact,
      bankAccount: account,
      paymentDate: fromDbDate(r.paymentDate),
      currency: r.currency,
      amount,
      estimateRate: r.estimateRate?.toFixed() ?? null,
      estimateInr: inr,
      functionalCurrency: org.functionalCurrency,
      purposeCode: r.purposeCode,
      purpose: r.purpose,
      charges: r.charges,
      taxableInIndia: r.taxableInIndia,
      hasTaxOrder: r.hasTaxOrder,
      form15: { part: f15.part as Form15Part, needs15cb: f15.needs15cb, reason: f15.reason, inrThisYear: f15.inrThisYear, inrBefore: f15.inrBefore, ack: r.form15caAck, cb: r.form15cbNumber, applies: home.countryCode === 'IN' },
      memo: r.memo,
      items,
      bank: bank
        ? { kind: bank.kind, verified: !!bank.verifiedAt, accountName: bank.accountName, accountMasked: maskAccountNumber(bank.accountNumber), swiftBic: bank.swiftBic, bankCountry: bank.bankCountry, bankName: bank.bankName, routingCode: bank.routingCode }
        : null,
      issues,
      createdBy: name.get(r.createdById) ?? null,
      createdAt: r.createdAt.toISOString(),
      approvedBy: r.approvedById ? name.get(r.approvedById) ?? null : null,
      approvedAt: r.approvedAt?.toISOString() ?? null,
      selfApproved: r.selfApproved,
      sentBy: r.sentById ? name.get(r.sentById) ?? null : null,
      sentAt: r.sentAt?.toISOString() ?? null,
      paidRate: r.paidRate?.toFixed() ?? null,
      paidInr: r.paidRate ? atRateInr(r.amount.toFixed(), r.paidRate.toFixed()) : null,
      bankReference: r.bankReference,
      payment,
      paidBy: r.paidById ? name.get(r.paidById) ?? null : null,
      paidAt: r.paidAt?.toISOString() ?? null,
      cancelledBy: r.cancelledById ? name.get(r.cancelledById) ?? null : null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      cancelReason: r.cancelReason,
      mine: actor ? r.createdById === actor.id : false,
      can: this.can(org),
    };
  }

  private async rateOn(db: Tx | PrismaService, orgId: string, currency: string, date: string) {
    const row = await db.exchangeRate.findFirst({ where: { orgId, currency, date: { lte: toDbDate(date) } }, orderBy: { date: 'desc' } });
    return row ? row.rate.toFixed() : null;
  }

  private async dueOf(db: Tx | PrismaService, docs: { id: string; total: Prisma.Decimal }[]) {
    const agg = docs.length ? await db.allocation.groupBy({ by: ['targetId'], where: { targetId: { in: docs.map((d) => d.id) }, removedOn: null }, _sum: { amount: true } }) : [];
    const used = new Map(agg.map((a) => [a.targetId, new D((a._sum.amount ?? 0).toString())]));
    return new Map(docs.map((d) => [d.id, new D(d.total.toFixed()).minus(used.get(d.id) ?? 0)]));
  }

  /** Bills already in an international payment that is not paid or cancelled, by bill, with its reference. */
  private async openItems(db: Tx | PrismaService, orgId: string, documentIds: string[], exceptId?: string) {
    if (!documentIds.length) return new Map<string, string>();
    const items = await db.internationalPaymentItem.findMany({ where: { orgId, documentId: { in: documentIds }, remittance: { status: { in: ['DRAFT', 'APPROVED', 'SENT'] }, ...(exceptId ? { id: { not: exceptId } } : {}) } }, include: { remittance: { select: { number: true } } } });
    return new Map(items.map((i) => [i.documentId, remittanceRef(i.remittance.number)]));
  }

  private async lock(tx: Tx, orgId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM international_payments WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const r = await tx.internationalPayment.findFirst({ where: { id, orgId }, include: INCLUDE });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'International payment not found' });
    return r;
  }

  private async otherApprover(tx: Tx, orgId: string, userId: string) {
    const members = await tx.membership.findMany({ where: { orgId, userId: { not: userId } }, select: { role: true } });
    return members.some((m) => hasPermission(m.role as RoleName, 'approvals.decide'));
  }
}
