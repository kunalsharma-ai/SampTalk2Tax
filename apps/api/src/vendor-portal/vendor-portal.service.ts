import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  D,
  formatAmountText,
  invoiceNumberKey,
  makeVendorPortalToken,
  MAX_PENDING_VENDOR_SUBMISSIONS,
  minorUnits,
  portalLinkState,
  submissionFileOpen,
  validateVendorSubmission,
  VENDOR_PORTAL_TOKEN_PATTERN,
  vendorBillState,
  vendorPortalTokenPrefix,
  type VendorSubmissionStatus,
} from '@talk2tax/accounting-engine';
import type { RoleName } from '@talk2tax/security';
import { createHash, randomBytes } from 'node:crypto';
import { cleanFileName, MAX_ATTACHMENT_BYTES, sniffContentType } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, withSystemAccess } from '../common/prisma.service';
import { enterOrg } from '../common/tenant-context';
import { SubledgerService } from '../ledgers/subledger.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { RegionsService } from '../regions/regions.service';
import { todayIst } from '../tasks/tasks.service';
import { UsageService } from '../usage/usage.service';

type Actor = { id: string };
interface StaffOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const DAY = 86_400_000;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface SubmissionInput {
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
  currency: string;
  purchaseOrderId?: string | null;
  note?: string | null;
}

/**
 * Vendor portal (AP-013). Staff make a private link for a vendor; the vendor opens it to see their
 * bills and when they fall due, the payments made to them, the purchase orders still open and
 * their statement, and to send an invoice. A sent invoice waits until staff record it as a bill
 * (its file is then attached to the bill) or turn it down with a reason the vendor sees. Nothing
 * a vendor does changes the books.
 */
@Injectable()
export class VendorPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subledger: SubledgerService,
    private readonly orders: PurchaseOrdersService,
    private readonly regions: RegionsService,
    private readonly usage: UsageService,
  ) {}

  // ------------------------------------------------------------------ staff: links

  private async vendor(orgId: string, contactId: string) {
    const c = await this.prisma.contact.findFirst({ where: { id: contactId, orgId }, select: { id: true, name: true, isVendor: true, isActive: true } });
    if (!c || !c.isVendor) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Vendor not found' });
    return c;
  }

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  }

  async links(org: StaffOrg, contactId: string) {
    await this.vendor(org.id, contactId);
    const links = await this.prisma.vendorPortalLink.findMany({ where: { orgId: org.id, contactId }, orderBy: { createdAt: 'desc' } });
    const users = await this.names(links.flatMap((l) => [l.createdById, l.revokedById]));
    const now = new Date();
    return links.map((l) => ({
      id: l.id,
      prefix: l.prefix,
      note: l.note,
      state: portalLinkState(l, now),
      createdAt: l.createdAt.toISOString(),
      createdBy: users.get(l.createdById) ?? 'Former member',
      expiresAt: l.expiresAt?.toISOString() ?? null,
      lastSeenAt: l.lastSeenAt?.toISOString() ?? null,
      viewCount: l.viewCount,
      revokedAt: l.revokedAt?.toISOString() ?? null,
      revokedBy: l.revokedById ? (users.get(l.revokedById) ?? 'Former member') : null,
    }));
  }

  /** Makes a link. The token is returned this once and never again. */
  async createLink(org: StaffOrg, actor: Actor, contactId: string, input: { expiresInDays: number | null; note?: string | null }) {
    const c = await this.vendor(org.id, contactId);
    if (!c.isActive) throw new DomainError('CONTACT_INACTIVE', `${c.name} is inactive`, HttpStatus.CONFLICT);
    const token = makeVendorPortalToken((n) => randomBytes(n));
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * DAY) : null;
    const link = await this.prisma.$transaction(async (tx) => {
      const l = await tx.vendorPortalLink.create({ data: { orgId: org.id, contactId, prefix: vendorPortalTokenPrefix(token), tokenHash: hash(token), note: input.note?.trim() || null, expiresAt, createdById: actor.id } });
      // The audit trail names the link by its prefix; the secret is never recorded.
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'vendor_portal.link_created', entityType: 'vendor_portal_link', entityId: l.id, data: { contactId, prefix: l.prefix, expiresAt: expiresAt?.toISOString() ?? null } });
      return l;
    });
    return { id: link.id, prefix: link.prefix, token, path: `/vendor-portal/${token}`, expiresAt: link.expiresAt?.toISOString() ?? null };
  }

  async revokeLink(org: StaffOrg, actor: Actor, contactId: string, linkId: string) {
    await this.prisma.$transaction(async (tx) => {
      const l = await tx.vendorPortalLink.findFirst({ where: { id: linkId, orgId: org.id, contactId } });
      if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Portal link not found' });
      if (l.revokedAt) throw new DomainError('ALREADY_REVOKED', 'This link is already revoked', HttpStatus.CONFLICT);
      await tx.vendorPortalLink.update({ where: { id: l.id }, data: { revokedAt: new Date(), revokedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'vendor_portal.link_revoked', entityType: 'vendor_portal_link', entityId: l.id, data: { contactId, prefix: l.prefix } });
    });
    return this.links(org, contactId);
  }

  // ------------------------------------------------------------------ staff: invoices sent

  private submissionOut(s: Awaited<ReturnType<PrismaService['vendorPortalSubmission']['findMany']>>[number], extra: { vendor: string; decidedBy: string | null; bill: { id: string; number: string | null; reference: string | null } | null; order: string | null }) {
    return {
      id: s.id,
      contactId: s.contactId,
      vendor: extra.vendor,
      invoiceNumber: s.invoiceNumber,
      invoiceDate: fromDbDate(s.invoiceDate),
      currency: s.currency,
      amount: s.amount.toFixed(minorUnits(s.currency)),
      purchaseOrderId: s.purchaseOrderId,
      purchaseOrder: extra.order,
      note: s.note,
      file: s.sha256 ? { name: s.fileName!, contentType: s.contentType!, sizeBytes: s.sizeBytes! } : null,
      status: s.status as VendorSubmissionStatus,
      bill: extra.bill,
      decidedBy: extra.decidedBy,
      decidedAt: s.decidedAt?.toISOString() ?? null,
      rejectReason: s.rejectReason,
      createdAt: s.createdAt.toISOString(),
    };
  }

  private async withNames(orgId: string, rows: Awaited<ReturnType<PrismaService['vendorPortalSubmission']['findMany']>>) {
    const [contacts, users, bills, orders] = await Promise.all([
      this.prisma.contact.findMany({ where: { orgId, id: { in: [...new Set(rows.map((r) => r.contactId))] } }, select: { id: true, name: true } }),
      this.names(rows.map((r) => r.decidedById)),
      this.prisma.document.findMany({ where: { orgId, id: { in: rows.flatMap((r) => (r.documentId ? [r.documentId] : [])) } }, select: { id: true, number: true, reference: true } }),
      this.prisma.purchaseOrder.findMany({ where: { orgId, id: { in: rows.flatMap((r) => (r.purchaseOrderId ? [r.purchaseOrderId] : [])) } }, select: { id: true, number: true } }),
    ]);
    const cn = new Map(contacts.map((c) => [c.id, c.name]));
    const bn = new Map(bills.map((b) => [b.id, b]));
    const on = new Map(orders.map((o) => [o.id, `PO-${String(o.number).padStart(4, '0')}`]));
    return rows.map((r) =>
      this.submissionOut(r, {
        vendor: cn.get(r.contactId) ?? '',
        decidedBy: r.decidedById ? (users.get(r.decidedById) ?? 'Former member') : null,
        bill: r.documentId ? (bn.get(r.documentId) ?? null) : null,
        order: r.purchaseOrderId ? (on.get(r.purchaseOrderId) ?? null) : null,
      }),
    );
  }

  /** Invoices vendors sent, newest first, optionally for one vendor or in one status. */
  async submissions(org: StaffOrg, f: { status?: VendorSubmissionStatus; contactId?: string }) {
    const where = { orgId: org.id, ...(f.contactId ? { contactId: f.contactId } : {}) };
    const [rows, counts] = await Promise.all([
      this.prisma.vendorPortalSubmission.findMany({ where: { ...where, ...(f.status ? { status: f.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200, omit: { content: true } }),
      this.prisma.vendorPortalSubmission.groupBy({ by: ['status'], where, _count: true }),
    ]);
    const count = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
    return { submissions: await this.withNames(org.id, rows as never), counts: { received: count('RECEIVED'), recorded: count('RECORDED'), rejected: count('REJECTED') } };
  }

  async submissionFile(org: StaffOrg, id: string) {
    const s = await this.prisma.vendorPortalSubmission.findFirst({ where: { id, orgId: org.id }, select: { fileName: true, contentType: true, sizeBytes: true, content: true, sha256: true } });
    if (!s?.content) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No file was sent with this invoice' });
    return { fileName: s.fileName!, contentType: s.contentType!, sizeBytes: s.sizeBytes!, sha256: s.sha256!, content: Buffer.from(s.content) };
  }

  /** Bills of the vendor that could record the sent invoice: not void, and not recording another one. */
  async billChoices(org: StaffOrg, id: string) {
    const s = await this.pending(org.id, id);
    const taken = (await this.prisma.vendorPortalSubmission.findMany({ where: { orgId: org.id, documentId: { not: null } }, select: { documentId: true } })).map((x) => x.documentId!);
    const bills = await this.prisma.document.findMany({
      where: { orgId: org.id, contactId: s.contactId, kind: 'BILL', status: { in: ['DRAFT', 'POSTED'] }, id: { notIn: taken } },
      orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      select: { id: true, number: true, status: true, reference: true, issueDate: true, total: true, currency: true },
    });
    const key = s.numberKey;
    return bills
      .map((b) => ({ id: b.id, number: b.number, status: b.status, reference: b.reference, issueDate: fromDbDate(b.issueDate), currency: b.currency, total: b.total.toFixed(minorUnits(b.currency)), matches: !!b.reference && invoiceNumberKey(b.reference) === key }))
      .sort((a, b) => Number(b.matches) - Number(a.matches));
  }

  private async pending(orgId: string, id: string) {
    const s = await this.prisma.vendorPortalSubmission.findFirst({ where: { id, orgId }, omit: { content: true } });
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Sent invoice not found' });
    if (s.status !== 'RECEIVED') throw new DomainError('ALREADY_DECIDED', s.status === 'RECORDED' ? 'This invoice is already recorded' : 'This invoice was already turned down', HttpStatus.CONFLICT);
    return s;
  }

  /** Records a sent invoice against a bill of the same vendor; the vendor's file is attached to the bill. */
  async record(org: StaffOrg, actor: Actor, id: string, documentId: string) {
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.vendorPortalSubmission.findFirst({ where: { id, orgId: org.id } });
      if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Sent invoice not found' });
      if (s.status !== 'RECEIVED') throw new DomainError('ALREADY_DECIDED', s.status === 'RECORDED' ? 'This invoice is already recorded' : 'This invoice was already turned down', HttpStatus.CONFLICT);
      const bill = await tx.document.findFirst({ where: { id: documentId, orgId: org.id }, select: { id: true, kind: true, status: true, contactId: true, number: true, reference: true } });
      if (!bill || bill.kind !== 'BILL') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bill not found' });
      if (bill.contactId !== s.contactId) throw new DomainError('WRONG_VENDOR', 'That bill is for another vendor', HttpStatus.UNPROCESSABLE_ENTITY);
      if (bill.status === 'VOID') throw new DomainError('BILL_VOID', 'That bill is void', HttpStatus.CONFLICT);
      const other = await tx.vendorPortalSubmission.findFirst({ where: { orgId: org.id, documentId: bill.id }, select: { invoiceNumber: true } });
      if (other) throw new DomainError('BILL_TAKEN', `That bill already records invoice ${other.invoiceNumber}`, HttpStatus.CONFLICT);
      await tx.vendorPortalSubmission.update({ where: { id: s.id }, data: { status: 'RECORDED', documentId: bill.id, decidedById: actor.id, decidedAt: new Date() } });
      let attachmentId: string | null = null;
      if (s.content) {
        const same = await tx.attachment.findFirst({ where: { orgId: org.id, entityType: 'DOCUMENT', entityId: bill.id, sha256: s.sha256!, removedAt: null }, select: { id: true } });
        attachmentId =
          same?.id ??
          (await tx.attachment.create({ data: { orgId: org.id, entityType: 'DOCUMENT', entityId: bill.id, fileName: s.fileName!, contentType: s.contentType!, sizeBytes: s.sizeBytes!, sha256: s.sha256!, content: s.content, uploadedById: actor.id }, select: { id: true } })).id;
      }
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'vendor_portal.invoice_recorded',
        entityType: 'vendor_portal_submission',
        entityId: s.id,
        data: { contactId: s.contactId, invoiceNumber: s.invoiceNumber, documentId: bill.id, attachmentId, referenceMatches: !!bill.reference && invoiceNumberKey(bill.reference) === s.numberKey },
      });
    });
    return this.one(org, id);
  }

  async reject(org: StaffOrg, actor: Actor, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.vendorPortalSubmission.findFirst({ where: { id, orgId: org.id }, omit: { content: true } });
      if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Sent invoice not found' });
      if (s.status !== 'RECEIVED') throw new DomainError('ALREADY_DECIDED', s.status === 'RECORDED' ? 'This invoice is already recorded' : 'This invoice was already turned down', HttpStatus.CONFLICT);
      await tx.vendorPortalSubmission.update({ where: { id: s.id }, data: { status: 'REJECTED', rejectReason: reason.trim(), decidedById: actor.id, decidedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'vendor_portal.invoice_rejected', entityType: 'vendor_portal_submission', entityId: s.id, data: { contactId: s.contactId, invoiceNumber: s.invoiceNumber, reason: reason.trim() } });
    });
    return this.one(org, id);
  }

  private async one(org: StaffOrg, id: string) {
    const s = await this.prisma.vendorPortalSubmission.findFirstOrThrow({ where: { id, orgId: org.id }, omit: { content: true } });
    return (await this.withNames(org.id, [s] as never))[0]!;
  }

  // ------------------------------------------------------------------ the portal (no sign-in)

  /** Finds the live link for a token across organisations, then narrows the request to its organisation. */
  private async open(token: string, count = false) {
    const invalid = (message = 'This link is not valid. Ask the business that sent it for a new one.') => new DomainError('PORTAL_LINK_INVALID', message, HttpStatus.NOT_FOUND);
    if (!VENDOR_PORTAL_TOKEN_PATTERN.test(token)) throw invalid();
    const found = await this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const l = await tx.vendorPortalLink.findUnique({ where: { tokenHash: hash(token) } });
        if (!l) return null;
        const org = await tx.organization.findUniqueOrThrow({ where: { id: l.orgId }, select: { id: true, name: true, legalName: true, functionalCurrency: true, dataRegion: true, suspendedAt: true } });
        return { l, org };
      }),
    );
    if (!found) throw invalid();
    const { l, org } = found;
    const state = portalLinkState(l, new Date());
    if (state === 'REVOKED') throw invalid(`${org.name} has withdrawn this link. Ask them for a new one.`);
    if (state === 'EXPIRED') throw invalid(`This link from ${org.name} has expired. Ask them for a new one.`);
    if (org.suspendedAt) throw invalid(`${org.name}'s portal is not available right now.`);
    this.regions.assertHere(org.dataRegion);
    enterOrg(org.id);
    const contact = await this.prisma.contact.findFirst({ where: { id: l.contactId, orgId: org.id }, select: { id: true, name: true, gstin: true, isActive: true, isVendor: true } });
    if (!contact || !contact.isActive || !contact.isVendor) throw invalid();
    if (count) await this.prisma.vendorPortalLink.update({ where: { id: l.id }, data: { lastSeenAt: new Date(), viewCount: { increment: 1 } } });
    return { link: l, org, contact };
  }

  /** The portal's front page: what the business owes the vendor, bills, payments, orders and sent invoices. */
  async overview(token: string) {
    const { link, org, contact } = await this.open(token, true);
    const today = todayIst();
    const gst = await this.prisma.gstRegistration.findUnique({ where: { orgId: org.id }, select: { gstin: true, legalName: true } });
    const items = await this.subledger.openItems(this.prisma, org.id, 'PURCHASES', today, contact.id);
    const openBy = new Map(items.map((i) => [i.id, i]));
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, contactId: contact.id, kind: { in: ['BILL', 'VENDOR_CREDIT'] }, status: { in: ['POSTED', 'VOID'] } },
      orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
      take: 100,
      select: { id: true, kind: true, number: true, status: true, issueDate: true, dueDate: true, currency: true, total: true, reference: true, withholdingAmount: true },
    });
    const bills = docs.map((d) => {
      const scale = minorUnits(d.currency);
      const total = d.total.toFixed(scale);
      const oi = openBy.get(d.id);
      const open = d.status === 'VOID' || !oi ? new D(0).toFixed(scale) : oi.foreignOpen.toFixed(scale);
      const dueDate = d.dueDate ? fromDbDate(d.dueDate) : null;
      return {
        id: d.id,
        kind: d.kind as 'BILL' | 'VENDOR_CREDIT',
        number: d.number,
        yourReference: d.reference,
        issueDate: fromDbDate(d.issueDate),
        dueDate,
        currency: d.currency,
        total,
        tdsDeducted: d.withholdingAmount.gt(0) ? d.withholdingAmount.toFixed(scale) : null,
        open,
        state: d.kind === 'VENDOR_CREDIT' ? (d.status === 'VOID' ? 'VOID' : new D(open).gt(0) ? 'UNUSED_CREDIT' : 'USED') : vendorBillState({ status: d.status, total, open, dueDate }, today),
      };
    });
    const byCurrency = new Map<string, { owed: InstanceType<typeof D>; due: InstanceType<typeof D>; credits: InstanceType<typeof D> }>();
    for (const i of items) {
      const b = byCurrency.get(i.currency) ?? { owed: new D(0), due: new D(0), credits: new D(0) };
      if (i.type === 'charge') {
        b.owed = b.owed.plus(i.foreignOpen);
        if (i.dueDate && i.dueDate <= today) b.due = b.due.plus(i.foreignOpen);
      } else b.credits = b.credits.plus(i.foreignOpen);
      byCurrency.set(i.currency, b);
    }
    const balances = [...byCurrency.entries()]
      .sort(([a], [b]) => (a === org.functionalCurrency ? -1 : b === org.functionalCurrency ? 1 : a.localeCompare(b)))
      .map(([currency, b]) => {
        const s = minorUnits(currency);
        return { currency, owed: b.owed.toFixed(s), due: b.due.toFixed(s), credits: b.credits.toFixed(s), balance: b.owed.minus(b.credits).toFixed(s) };
      });
    const payments = await this.prisma.payment.findMany({ where: { orgId: org.id, contactId: contact.id, kind: 'PAYMENT' }, orderBy: [{ date: 'desc' }, { number: 'desc' }], take: 50, select: { id: true, number: true, date: true, amount: true, currency: true, status: true, reference: true } });
    const po = await this.orders.list({ id: org.id, role: 'VIEWER', functionalCurrency: org.functionalCurrency }, { view: 'all', contactId: contact.id });
    const orders = po.orders
      .filter((o) => o.state !== 'DRAFT' && o.state !== 'CANCELLED')
      .slice(0, 50)
      .map((o) => ({ id: o.id, reference: o.reference, orderDate: o.orderDate, expectedDate: o.expectedDate, currency: o.currency, total: o.total, toBill: o.toBill, state: o.state, yourReference: o.vendorReference }));
    const sent = await this.prisma.vendorPortalSubmission.findMany({ where: { orgId: org.id, contactId: contact.id }, orderBy: { createdAt: 'desc' }, take: 50, omit: { content: true } });
    // Recorded against a draft bill, there is no bill number to show yet.
    const recordedOn = await this.prisma.document.findMany({ where: { orgId: org.id, id: { in: sent.flatMap((s) => (s.documentId ? [s.documentId] : [])) } }, select: { id: true, number: true } });
    const billNo = new Map(recordedOn.map((d) => [d.id, d.number]));
    const orderRef = new Map(po.orders.map((o) => [o.id, o.reference]));
    const now = new Date();
    return {
      from: { name: gst?.legalName || org.legalName || org.name, tradeName: org.name, gstin: gst?.gstin ?? null },
      vendor: { name: contact.name, gstin: contact.gstin },
      link: { expiresAt: link.expiresAt?.toISOString() ?? null },
      today,
      currency: org.functionalCurrency,
      balances,
      bills,
      payments: payments.map((p) => ({ id: p.id, number: p.number, date: fromDbDate(p.date), amount: p.amount.toFixed(minorUnits(p.currency)), currency: p.currency, status: p.status, reference: p.reference })),
      orders,
      sent: sent.map((s) => ({
        id: s.id,
        invoiceNumber: s.invoiceNumber,
        invoiceDate: fromDbDate(s.invoiceDate),
        currency: s.currency,
        amount: s.amount.toFixed(minorUnits(s.currency)),
        purchaseOrder: s.purchaseOrderId ? (orderRef.get(s.purchaseOrderId) ?? null) : null,
        file: s.fileName,
        canAddFile: s.status === 'RECEIVED' && !s.sha256 && submissionFileOpen(s.createdAt, now),
        status: s.status as VendorSubmissionStatus,
        bill: s.documentId ? (billNo.get(s.documentId) ?? null) : null,
        rejectReason: s.rejectReason,
        sentAt: s.createdAt.toISOString(),
      })),
    };
  }

  async statement(token: string, q: { from?: string; to?: string; currency?: string }) {
    const { org, contact } = await this.open(token);
    const to = q.to ?? todayIst();
    const from = q.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4, 8)}01`;
    if (from > to) throw new DomainError('INVALID_RANGE', 'The statement must start on or before its end', HttpStatus.UNPROCESSABLE_ENTITY);
    const s = await this.subledger.statement({ id: org.id, functionalCurrency: org.functionalCurrency }, contact.id, 'PURCHASES', from, to, q.currency);
    return { ...s, lines: s.lines.map(({ id: _id, ...l }) => l) };
  }

  /** The vendor sends an invoice. It waits for the business to check it; a file can follow. */
  async submit(token: string, input: SubmissionInput) {
    const { link, org, contact } = await this.open(token);
    const today = todayIst();
    const issues = validateVendorSubmission(input, today);
    if (issues.length) throw new DomainError('SUBMISSION_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const number = input.invoiceNumber.trim().replace(/\s+/g, ' ');
    const key = invoiceNumberKey(number);
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vendor-portal:${contact.id}`}))`;
      if (input.purchaseOrderId) {
        const o = await tx.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, orgId: org.id, contactId: contact.id, status: { in: ['ISSUED', 'CLOSED'] } }, select: { id: true } });
        if (!o) throw new DomainError('SUBMISSION_INVALID', 'Choose one of your purchase orders', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const waiting = await tx.vendorPortalSubmission.count({ where: { orgId: org.id, contactId: contact.id, status: 'RECEIVED' } });
      if (waiting >= MAX_PENDING_VENDOR_SUBMISSIONS) throw new DomainError('TOO_MANY_WAITING', `${MAX_PENDING_VENDOR_SUBMISSIONS} of your invoices are already waiting to be checked. Wait for ${org.name} to check them.`, HttpStatus.CONFLICT);
      const live = await tx.vendorPortalSubmission.findMany({ where: { orgId: org.id, contactId: contact.id, numberKey: key, status: { not: 'REJECTED' } }, select: { status: true } });
      if (live.length) throw new DomainError('ALREADY_SENT', live[0]!.status === 'RECORDED' ? `Invoice ${number} is already recorded by ${org.name}` : `You already sent invoice ${number}; it is waiting to be checked`, HttpStatus.CONFLICT);
      const bills = await tx.document.findMany({ where: { orgId: org.id, contactId: contact.id, kind: 'BILL', status: { not: 'VOID' }, reference: { not: null } }, select: { reference: true } });
      if (bills.some((b) => invoiceNumberKey(b.reference!) === key)) throw new DomainError('ALREADY_SENT', `Invoice ${number} is already recorded by ${org.name}`, HttpStatus.CONFLICT);
      const s = await tx.vendorPortalSubmission.create({
        data: { orgId: org.id, contactId: contact.id, linkId: link.id, invoiceNumber: number, numberKey: key, invoiceDate: toDbDate(input.invoiceDate), currency: input.currency, amount: input.amount, purchaseOrderId: input.purchaseOrderId ?? null, note: input.note?.trim() || null },
        select: { id: true },
      });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: null,
        action: 'vendor_portal.invoice_sent',
        entityType: 'vendor_portal_submission',
        entityId: s.id,
        data: { contactId: contact.id, linkPrefix: link.prefix, invoiceNumber: number, invoiceDate: input.invoiceDate, amount: formatAmountText(input.amount, input.currency) },
      });
      return s.id;
    });
    return { id, status: 'RECEIVED' as const };
  }

  /** Adds the invoice's file (PDF or image, at most 5 MB) to a just-sent invoice, once. */
  async addFile(token: string, id: string, fileName: string, content: Buffer) {
    const { link, org, contact } = await this.open(token);
    if (!content.length) throw new DomainError('EMPTY_FILE', 'The file is empty');
    if (content.length > MAX_ATTACHMENT_BYTES) throw new DomainError('FILE_TOO_LARGE', 'Files can be at most 5 MB', HttpStatus.PAYLOAD_TOO_LARGE);
    const contentType = sniffContentType(content);
    if (!contentType) throw new DomainError('UNSUPPORTED_FILE', 'Send a PDF, PNG, JPEG or WebP file', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.vendorPortalSubmission.findFirst({ where: { id, orgId: org.id, contactId: contact.id }, select: { id: true, status: true, sha256: true, createdAt: true, invoiceNumber: true } });
      if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
      if (s.sha256) throw new DomainError('FILE_ALREADY_SENT', 'A file was already sent with this invoice', HttpStatus.CONFLICT);
      if (s.status !== 'RECEIVED' || !submissionFileOpen(s.createdAt, new Date())) throw new DomainError('FILE_WINDOW_CLOSED', 'A file can be added only within an hour of sending the invoice. Send the file to the business another way.', HttpStatus.CONFLICT);
      // Counted against the plan's uploads for the month (refused past it).
      await this.usage.takeUpload(tx, org.id, content.length);
      const digest = sha(content);
      await tx.vendorPortalSubmission.update({ where: { id: s.id }, data: { fileName: cleanFileName(fileName), contentType, sizeBytes: content.length, sha256: digest, content: new Uint8Array(content) } });
      await this.audit.append(tx, { orgId: org.id, actorId: null, action: 'vendor_portal.file_sent', entityType: 'vendor_portal_submission', entityId: s.id, data: { contactId: contact.id, linkPrefix: link.prefix, invoiceNumber: s.invoiceNumber, sha256: digest, sizeBytes: content.length } });
    });
    return { id, file: cleanFileName(fileName) };
  }
}
