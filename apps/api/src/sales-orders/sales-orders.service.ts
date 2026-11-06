import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { billingIssues, D, dealStageChange, isOpenStage, minorUnits, orderBilling, quoteAllows, quoteState, remainingToBill, SalesOrderError, type QuoteStatus } from '@talk2tax/accounting-engine';
import { Prisma, SalesOrder, SalesOrderLine, SalesQuote, SalesQuoteLine } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { DocumentsService } from '../ledgers/documents.service';
import { todayIst } from '../tasks/tasks.service';

export interface SalesOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
type Actor = { id: string };

export interface LineInput {
  accountId: string;
  description?: string | null;
  quantity: string;
  unitPrice: string;
  taxRateId?: string | null;
  hsnCode?: string | null;
}

export interface QuoteInput {
  contactId: string;
  dealId?: string | null;
  issueDate: string;
  validUntil: string;
  placeOfSupply?: string | null;
  reference?: string | null;
  terms?: string | null;
  memo?: string | null;
  lines: LineInput[];
}

export interface OrderInput {
  contactId: string;
  dealId?: string | null;
  orderDate: string;
  placeOfSupply?: string | null;
  reference?: string | null;
  memo?: string | null;
  lines: LineInput[];
}

const quoteRef = (q: { number: number; revision: number }) => `QT-${String(q.number).padStart(4, '0')}${q.revision > 1 ? `-R${q.revision}` : ''}`;
const orderRef = (n: number) => `SO-${String(n).padStart(4, '0')}`;
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
const dealRef = (n: number) => `DL-${String(n).padStart(4, '0')}`;

type QuoteWithLines = SalesQuote & { lines: SalesQuoteLine[] };
type OrderWithLines = SalesOrder & { lines: (SalesOrderLine & { billings: { quantity: Prisma.Decimal; documentId: string }[] })[] };

/**
 * Quotations and sales orders (CRM slice 2). Their lines and totals are worked out by the same
 * code as invoices (tax rates, India GST place of supply and split), so an order bills into an
 * invoice with the same figures. Billing creates a draft invoice; voiding or deleting it frees the
 * quantities again.
 */
@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  private scale(org: SalesOrg) {
    return minorUnits(org.functionalCurrency);
  }

  private can(org: SalesOrg) {
    return { manage: hasPermission(org.role, 'sales.manage') };
  }

  private invalid(message: string, code = 'SALES_ORDER_INVALID', details?: unknown): never {
    throw new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  private rule(f: () => void) {
    try {
      f();
    } catch (e) {
      if (e instanceof SalesOrderError) this.invalid(e.message, e.code);
      throw e;
    }
  }

  private async nextNumber(tx: Tx, orgId: string, key: 'sales_quote' | 'sales_order') {
    const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO org_counters (org_id, key, value) VALUES (${orgId}::uuid, ${key}, 1)
      ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1
      RETURNING value`;
    return value;
  }

  /** The figures by the invoice rules, as rows to store. */
  private async compute(tx: Tx, org: SalesOrg, input: { contactId: string; date: string; placeOfSupply?: string | null; lines: LineInput[] }) {
    const { computed, gst } = await this.documents.computeSales(tx, org, {
      contactId: input.contactId,
      issueDate: input.date,
      placeOfSupply: input.placeOfSupply ?? null,
      lines: input.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? undefined, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId ?? null, hsnCode: l.hsnCode ?? null })),
    });
    return {
      placeOfSupply: gst?.placeOfSupply ?? null,
      subtotal: computed.subtotal.toFixed(),
      taxTotal: computed.taxTotal.toFixed(),
      total: computed.total.toFixed(),
      lines: computed.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description ?? null,
        accountId: l.accountId,
        quantity: l.quantity.toFixed(),
        unitPrice: l.unitPrice.toFixed(),
        taxRateId: l.taxRateId,
        hsnCode: l.hsnCode,
        netAmount: l.netAmount.toFixed(),
        taxAmount: l.taxAmount.toFixed(),
      })),
    };
  }

  private async checkDeal(db: Pick<Tx, 'crmDeal'>, orgId: string, dealId: string | null | undefined, contactId: string) {
    if (!dealId) return null;
    const d = await db.crmDeal.findFirst({ where: { id: dealId, orgId } });
    if (!d) this.invalid('Choose a deal of this organisation', 'SALES_DEAL_NOT_FOUND');
    if (d.contactId !== contactId) this.invalid(`${dealRef(d.number)} is for another customer`, 'SALES_DEAL_OTHER_CUSTOMER');
    return d;
  }

  // ------------------------------------------------------------------ shared output

  private async names(orgId: string, rows: { contactId: string; dealId: string | null }[], lines: { accountId: string; taxRateId: string | null }[] = []) {
    const contactIds = [...new Set(rows.map((r) => r.contactId))];
    const dealIds = [...new Set(rows.map((r) => r.dealId).filter((x): x is string => !!x))];
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const taxIds = [...new Set(lines.map((l) => l.taxRateId).filter((x): x is string => !!x))];
    const [contacts, deals, accounts, taxes] = await Promise.all([
      contactIds.length ? this.prisma.contact.findMany({ where: { orgId, id: { in: contactIds } }, select: { id: true, name: true, email: true, gstin: true } }) : [],
      dealIds.length ? this.prisma.crmDeal.findMany({ where: { orgId, id: { in: dealIds } }, select: { id: true, number: true, name: true, stage: true } }) : [],
      accountIds.length ? this.prisma.account.findMany({ where: { orgId, id: { in: accountIds } }, select: { id: true, code: true, name: true } }) : [],
      taxIds.length ? this.prisma.taxRate.findMany({ where: { orgId, id: { in: taxIds } }, select: { id: true, name: true, rate: true } }) : [],
    ]);
    return {
      contact: (id: string) => contacts.find((c) => c.id === id) ?? null,
      deal: (id: string | null) => {
        const d = id ? deals.find((x) => x.id === id) : null;
        return d ? { id: d.id, reference: dealRef(d.number), name: d.name, stage: d.stage } : null;
      },
      account: (id: string) => accounts.find((a) => a.id === id) ?? null,
      tax: (id: string | null) => {
        const t = id ? taxes.find((x) => x.id === id) : null;
        return t ? { id: t.id, name: t.name, rate: t.rate.toFixed() } : null;
      },
    };
  }

  private money(org: SalesOrg, v: Prisma.Decimal) {
    return new D(v.toString()).toFixed(this.scale(org));
  }

  private qty(v: Prisma.Decimal | string) {
    return new D(v.toString()).toFixed();
  }

  // ------------------------------------------------------------------ quotations

  private quoteOut(org: SalesOrg, q: SalesQuote, n: Awaited<ReturnType<SalesOrdersService['names']>>, today: string) {
    return {
      id: q.id,
      reference: quoteRef(q),
      number: q.number,
      revision: q.revision,
      status: q.status,
      state: quoteState(q.status as QuoteStatus, fromDbDate(q.validUntil), today),
      contact: n.contact(q.contactId),
      deal: n.deal(q.dealId),
      issueDate: fromDbDate(q.issueDate),
      validUntil: fromDbDate(q.validUntil),
      placeOfSupply: q.placeOfSupply,
      customerReference: q.reference,
      terms: q.terms,
      memo: q.memo,
      currency: q.currency,
      subtotal: this.money(org, q.subtotal),
      taxTotal: this.money(org, q.taxTotal),
      total: this.money(org, q.total),
      sentAt: q.sentAt?.toISOString() ?? null,
      decidedAt: q.decidedAt?.toISOString() ?? null,
      declineReason: q.declineReason,
      orderId: q.orderId,
      createdAt: q.createdAt.toISOString(),
    };
  }

  async listQuotes(org: SalesOrg, f: { status?: QuoteStatus; contactId?: string; dealId?: string }) {
    const today = todayIst();
    const quotes = await this.prisma.salesQuote.findMany({
      where: { orgId: org.id, ...(f.status ? { status: f.status } : {}), ...(f.contactId ? { contactId: f.contactId } : {}), ...(f.dealId ? { dealId: f.dealId } : {}) },
      orderBy: [{ number: 'desc' }, { revision: 'desc' }],
      take: 500,
    });
    const n = await this.names(org.id, quotes);
    const out = quotes.map((q) => this.quoteOut(org, q, n, today));
    const scale = this.scale(org);
    const sum = (xs: typeof out) => xs.reduce((t, x) => t.plus(x.total), new D(0)).toFixed(scale);
    const awaiting = out.filter((q) => q.state === 'SENT');
    const accepted = out.filter((q) => q.state === 'ACCEPTED');
    const decided = out.filter((q) => q.state === 'ACCEPTED' || q.state === 'DECLINED');
    return {
      quotes: out,
      totals: {
        drafts: out.filter((q) => q.state === 'DRAFT').length,
        awaiting: { count: awaiting.length, total: sum(awaiting) },
        expired: out.filter((q) => q.state === 'EXPIRED').length,
        accepted: { count: accepted.length, total: sum(accepted) },
        /** Accepted as a share of answered quotations, whole percent; null with none answered. */
        acceptanceRate: decided.length ? Math.round((accepted.length / decided.length) * 100) : null,
      },
      can: this.can(org),
    };
  }

  async getQuote(org: SalesOrg, id: string) {
    const today = todayIst();
    const q = await this.prisma.salesQuote.findFirst({ where: { id, orgId: org.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!q) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Quotation not found' });
    const [n, revisions, order] = await Promise.all([
      this.names(org.id, [q], q.lines),
      this.prisma.salesQuote.findMany({ where: { orgId: org.id, number: q.number }, orderBy: { revision: 'asc' }, select: { id: true, number: true, revision: true, status: true, validUntil: true, total: true } }),
      q.orderId ? this.prisma.salesOrder.findFirst({ where: { id: q.orderId, orgId: org.id }, select: { id: true, number: true } }) : null,
    ]);
    return {
      ...this.quoteOut(org, q, n, today),
      lines: q.lines.map((l) => this.lineOut(org, l, n)),
      revisions: revisions.map((r) => ({ id: r.id, reference: quoteRef(r), state: quoteState(r.status as QuoteStatus, fromDbDate(r.validUntil), today), total: this.money(org, r.total) })),
      order: order ? { id: order.id, reference: orderRef(order.number) } : null,
      can: this.can(org),
    };
  }

  private lineOut(org: SalesOrg, l: SalesQuoteLine | SalesOrderLine, n: Awaited<ReturnType<SalesOrdersService['names']>>) {
    return {
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      account: n.account(l.accountId),
      quantity: this.qty(l.quantity),
      unitPrice: this.qty(l.unitPrice),
      tax: n.tax(l.taxRateId),
      hsnCode: l.hsnCode,
      netAmount: this.money(org, l.netAmount),
      taxAmount: this.money(org, l.taxAmount),
    };
  }

  async createQuote(org: SalesOrg, actor: Actor, input: QuoteInput) {
    if (input.validUntil < input.issueDate) this.invalid('A quotation cannot expire before its date', 'QUOTE_DATES');
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkDeal(tx, org.id, input.dealId, input.contactId);
      const c = await this.compute(tx, org, { contactId: input.contactId, date: input.issueDate, placeOfSupply: input.placeOfSupply, lines: input.lines });
      const number = await this.nextNumber(tx, org.id, 'sales_quote');
      const q = await tx.salesQuote.create({
        data: {
          orgId: org.id, number, contactId: input.contactId, dealId: input.dealId ?? null, issueDate: toDbDate(input.issueDate), validUntil: toDbDate(input.validUntil), placeOfSupply: c.placeOfSupply,
          reference: clean(input.reference), terms: clean(input.terms), memo: clean(input.memo), currency: org.functionalCurrency, subtotal: c.subtotal, taxTotal: c.taxTotal, total: c.total, createdById: actor.id,
          lines: { create: c.lines.map((l) => ({ ...l, orgId: org.id })) },
        },
      });
      await this.dealNote(tx, org, actor, input.dealId, `Quotation ${quoteRef(q)} drafted for ${c.total}`);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_quote.created', entityType: 'sales_quote', entityId: q.id, data: { reference: quoteRef(q), contactId: input.contactId, total: c.total, dealId: input.dealId ?? null } });
      return q.id;
    });
    return this.getQuote(org, id);
  }

  private async lockQuote(tx: Tx, orgId: string, id: string): Promise<QuoteWithLines> {
    await tx.$queryRaw`SELECT id FROM sales_quotes WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const q = await tx.salesQuote.findFirst({ where: { id, orgId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!q) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Quotation not found' });
    return q;
  }

  async updateQuote(org: SalesOrg, actor: Actor, id: string, input: QuoteInput) {
    if (input.validUntil < input.issueDate) this.invalid('A quotation cannot expire before its date', 'QUOTE_DATES');
    await this.prisma.$transaction(async (tx) => {
      const q = await this.lockQuote(tx, org.id, id);
      this.rule(() => quoteAllows(q.status as QuoteStatus, fromDbDate(q.validUntil), todayIst(), 'EDIT'));
      if (q.revision > 1 && input.contactId !== q.contactId) this.invalid('A revision is for the same customer', 'QUOTE_REVISION_CUSTOMER');
      await this.checkDeal(tx, org.id, input.dealId, input.contactId);
      const c = await this.compute(tx, org, { contactId: input.contactId, date: input.issueDate, placeOfSupply: input.placeOfSupply, lines: input.lines });
      await tx.salesQuoteLine.deleteMany({ where: { quoteId: id, orgId: org.id } });
      await tx.salesQuote.update({
        where: { id },
        data: {
          contactId: input.contactId, dealId: input.dealId ?? null, issueDate: toDbDate(input.issueDate), validUntil: toDbDate(input.validUntil), placeOfSupply: c.placeOfSupply,
          reference: clean(input.reference), terms: clean(input.terms), memo: clean(input.memo), subtotal: c.subtotal, taxTotal: c.taxTotal, total: c.total,
          lines: { create: c.lines.map((l) => ({ ...l, orgId: org.id })) },
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_quote.updated', entityType: 'sales_quote', entityId: id, data: { total: c.total, before: this.money(org, q.total) } });
    });
    return this.getQuote(org, id);
  }

  async deleteQuote(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const q = await this.lockQuote(tx, org.id, id);
      this.rule(() => quoteAllows(q.status as QuoteStatus, fromDbDate(q.validUntil), todayIst(), 'EDIT'));
      // A draft revision goes on its own; the quotation it would have replaced stays as it was.
      await tx.salesQuote.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_quote.deleted', entityType: 'sales_quote', entityId: id, data: { reference: quoteRef(q) } });
    });
  }

  async sendQuote(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const q = await this.lockQuote(tx, org.id, id);
      this.rule(() => quoteAllows(q.status as QuoteStatus, fromDbDate(q.validUntil), todayIst(), 'SEND'));
      await tx.salesQuote.update({ where: { id }, data: { status: 'SENT', sentAt: new Date() } });
      if (q.previousId) {
        const prev = await this.lockQuote(tx, org.id, q.previousId);
        if (prev.status === 'ACCEPTED') this.invalid(`${quoteRef(prev)} was accepted meanwhile; this revision cannot be sent`, 'QUOTE_PREVIOUS_ACCEPTED');
        await tx.salesQuote.update({ where: { id: prev.id }, data: { status: 'SUPERSEDED' } });
      }
      await this.dealNote(tx, org, actor, q.dealId, `Quotation ${quoteRef(q)} sent: ${this.money(org, q.total)}, valid until ${fromDbDate(q.validUntil)}`);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_quote.sent', entityType: 'sales_quote', entityId: id, data: { reference: quoteRef(q), total: this.money(org, q.total) } });
    });
    return this.getQuote(org, id);
  }

  async declineQuote(org: SalesOrg, actor: Actor, id: string, reason: string) {
    if (!reason.trim()) this.invalid('Say why the customer declined', 'QUOTE_REASON_REQUIRED');
    await this.prisma.$transaction(async (tx) => {
      const q = await this.lockQuote(tx, org.id, id);
      this.rule(() => quoteAllows(q.status as QuoteStatus, fromDbDate(q.validUntil), todayIst(), 'DECLINE'));
      await this.assertLatest(tx, org.id, q);
      await tx.salesQuote.update({ where: { id }, data: { status: 'DECLINED', decidedAt: new Date(), declineReason: reason.trim() } });
      await this.dealNote(tx, org, actor, q.dealId, `Quotation ${quoteRef(q)} declined: ${reason.trim()}`);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_quote.declined', entityType: 'sales_quote', entityId: id, data: { reference: quoteRef(q), reason: reason.trim() } });
    });
    return this.getQuote(org, id);
  }

  /** A draft revision with the same number and lines, dated today; sending it supersedes this one. */
  async reviseQuote(org: SalesOrg, actor: Actor, id: string) {
    const newId = await this.prisma.$transaction(async (tx) => {
      const q = await this.lockQuote(tx, org.id, id);
      this.rule(() => quoteAllows(q.status as QuoteStatus, fromDbDate(q.validUntil), todayIst(), 'REVISE'));
      const latest = await tx.salesQuote.findFirst({ where: { orgId: org.id, number: q.number }, orderBy: { revision: 'desc' } });
      if (latest!.id !== q.id) this.invalid(`${quoteRef(latest!)} is already its next revision`, 'QUOTE_NOT_LATEST');
      const today = todayIst();
      const days = Math.round((q.validUntil.getTime() - q.issueDate.getTime()) / 86_400_000);
      const validUntil = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      const r = await tx.salesQuote.create({
        data: {
          orgId: org.id, number: q.number, revision: q.revision + 1, previousId: q.id, contactId: q.contactId, dealId: q.dealId, issueDate: toDbDate(today), validUntil: toDbDate(validUntil), placeOfSupply: q.placeOfSupply,
          reference: q.reference, terms: q.terms, memo: q.memo, currency: q.currency, subtotal: q.subtotal, taxTotal: q.taxTotal, total: q.total, createdById: actor.id,
          lines: { create: q.lines.map(({ id: _id, quoteId: _q, ...l }) => l) },
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_quote.revised', entityType: 'sales_quote', entityId: r.id, data: { reference: quoteRef(r), replaces: quoteRef(q) } });
      return r.id;
    });
    return this.getQuote(org, newId);
  }

  /**
   * The customer accepted: the quotation becomes a sales order with the same lines and figures,
   * and its deal, when open, is won.
   */
  async acceptQuote(org: SalesOrg, actor: Actor, id: string, input: { orderDate?: string | null; reference?: string | null }) {
    const orderId = await this.prisma.$transaction(async (tx) => {
      const q = await this.lockQuote(tx, org.id, id);
      const today = todayIst();
      this.rule(() => quoteAllows(q.status as QuoteStatus, fromDbDate(q.validUntil), today, 'ACCEPT'));
      await this.assertLatest(tx, org.id, q);
      const orderDate = input.orderDate ?? today;
      if (orderDate < fromDbDate(q.issueDate)) this.invalid('The order cannot be dated before the quotation', 'ORDER_DATE');
      const number = await this.nextNumber(tx, org.id, 'sales_order');
      const o = await tx.salesOrder.create({
        data: {
          orgId: org.id, number, contactId: q.contactId, quoteId: q.id, dealId: q.dealId, orderDate: toDbDate(orderDate), placeOfSupply: q.placeOfSupply, reference: clean(input.reference) ?? q.reference, memo: q.memo,
          currency: q.currency, subtotal: q.subtotal, taxTotal: q.taxTotal, total: q.total, createdById: actor.id,
          lines: { create: q.lines.map(({ id: _id, quoteId: _q, ...l }) => l) },
        },
      });
      await tx.salesQuote.update({ where: { id }, data: { status: 'ACCEPTED', decidedAt: new Date(), orderId: o.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_quote.accepted', entityType: 'sales_quote', entityId: id, data: { reference: quoteRef(q), orderId: o.id, order: orderRef(number) } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_order.created', entityType: 'sales_order', entityId: o.id, data: { reference: orderRef(number), fromQuote: quoteRef(q), total: this.money(org, q.total) } });
      if (q.dealId) await this.winDeal(tx, org, actor, q.dealId, `Won: quotation ${quoteRef(q)} accepted as order ${orderRef(number)}`);
      return o.id;
    });
    return this.getOrder(org, orderId);
  }

  /** An answer is recorded on the latest revision only (a draft revision waiting to be sent counts). */
  private async assertLatest(tx: Tx, orgId: string, q: SalesQuote) {
    const next = await tx.salesQuote.findFirst({ where: { orgId, previousId: q.id }, select: { number: true, revision: true } });
    if (next) this.invalid(`${quoteRef(next)} replaces this quotation; record the answer there, or delete that draft first`, 'QUOTE_NOT_LATEST');
  }

  /** Note on the deal's timeline, when there is a deal. */
  private async dealNote(tx: Tx, org: SalesOrg, actor: Actor, dealId: string | null | undefined, body: string) {
    if (!dealId) return;
    await tx.crmActivity.create({ data: { orgId: org.id, dealId, kind: 'NOTE', body, actorId: actor.id } });
  }

  private async winDeal(tx: Tx, org: SalesOrg, actor: Actor, dealId: string, body: string) {
    await tx.$queryRaw`SELECT id FROM crm_deals WHERE id = ${dealId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
    const d = await tx.crmDeal.findFirst({ where: { id: dealId, orgId: org.id } });
    if (!d) return;
    if (!isOpenStage(d.stage)) {
      await this.dealNote(tx, org, actor, dealId, body.replace(/^Won: /, ''));
      return;
    }
    const r = dealStageChange(d.stage, 'WON');
    await tx.crmDeal.update({ where: { id: dealId }, data: { stage: 'WON', probability: r.probability, closedOn: toDbDate(todayIst()), lostReason: null } });
    await tx.crmActivity.create({ data: { orgId: org.id, dealId, kind: 'STAGE_CHANGED', body, data: { from: d.stage, to: 'WON', probabilityFrom: d.probability, probability: 100, reopened: false }, actorId: actor.id } });
    await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.deal.won', entityType: 'crm_deal', entityId: dealId, data: { from: d.stage, to: 'WON', probability: 100, by: 'quotation accepted' } });
  }

  // ------------------------------------------------------------------ orders

  private orderLines(org: SalesOrg, o: OrderWithLines, n: Awaited<ReturnType<SalesOrdersService['names']>>, live: Set<string>) {
    return o.lines.map((l) => {
      const billed = l.billings.filter((b) => live.has(b.documentId)).reduce((t, b) => t.plus(b.quantity.toString()), new D(0)).toFixed();
      return { ...this.lineOut(org, l, n), billed, remaining: remainingToBill({ quantity: l.quantity.toString(), billed }) };
    });
  }

  /** Invoices billing these orders that are not void (drafts count: what they bill is reserved). */
  private async liveDocuments(orgId: string, orders: OrderWithLines[]) {
    const ids = [...new Set(orders.flatMap((o) => o.lines.flatMap((l) => l.billings.map((b) => b.documentId))))];
    const docs = ids.length ? await this.prisma.document.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, status: true, number: true, total: true, issueDate: true } }) : [];
    return { live: new Set(docs.filter((d) => d.status !== 'VOID').map((d) => d.id)), docs };
  }

  private orderInclude = { lines: { orderBy: { lineNo: 'asc' as const }, include: { billings: { select: { quantity: true, documentId: true } } } } };

  private orderOut(org: SalesOrg, o: OrderWithLines, n: Awaited<ReturnType<SalesOrdersService['names']>>, live: Set<string>) {
    const lines = this.orderLines(org, o, n, live);
    const billing = orderBilling(lines.map((l) => ({ quantity: l.quantity, billed: l.billed })));
    const scale = this.scale(org);
    // Value still to bill at the order's prices (net plus tax, in proportion to the quantity left).
    const toBill = o.lines.reduce((t, l, i) => t.plus(new D(l.netAmount.toString()).plus(l.taxAmount.toString()).times(lines[i]!.remaining).div(l.quantity.toString())), new D(0)).toDecimalPlaces(scale).toFixed(scale);
    return {
      id: o.id,
      reference: orderRef(o.number),
      contact: n.contact(o.contactId),
      deal: n.deal(o.dealId),
      quoteId: o.quoteId,
      orderDate: fromDbDate(o.orderDate),
      placeOfSupply: o.placeOfSupply,
      customerReference: o.reference,
      memo: o.memo,
      currency: o.currency,
      subtotal: this.money(org, o.subtotal),
      taxTotal: this.money(org, o.taxTotal),
      total: this.money(org, o.total),
      toBill: o.status === 'CANCELLED' ? new D(0).toFixed(scale) : toBill,
      status: o.status,
      billing,
      cancelReason: o.cancelReason,
      cancelledAt: o.cancelledAt?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
      lines,
    };
  }

  async listOrders(org: SalesOrg, f: { view?: 'open' | 'billed' | 'cancelled' | 'all'; contactId?: string; dealId?: string }) {
    const orders = (await this.prisma.salesOrder.findMany({
      where: { orgId: org.id, ...(f.contactId ? { contactId: f.contactId } : {}), ...(f.dealId ? { dealId: f.dealId } : {}), ...(f.view === 'cancelled' ? { status: 'CANCELLED' } : f.view === 'all' ? {} : { status: 'OPEN' }) },
      include: this.orderInclude,
      orderBy: { number: 'desc' },
      take: 500,
    })) as OrderWithLines[];
    const [{ live }, n] = await Promise.all([this.liveDocuments(org.id, orders), this.names(org.id, orders, orders.flatMap((o) => o.lines))]);
    let out = orders.map((o) => this.orderOut(org, o, n, live));
    if (f.view === 'open' || !f.view) out = out.filter((o) => o.billing !== 'BILLED');
    if (f.view === 'billed') out = out.filter((o) => o.billing === 'BILLED');
    const scale = this.scale(org);
    const open = out.filter((o) => o.status === 'OPEN' && o.billing !== 'BILLED');
    return {
      orders: out.map(({ lines: _l, ...o }) => o),
      totals: { open: open.length, toBill: open.reduce((t, o) => t.plus(o.toBill), new D(0)).toFixed(scale) },
      can: this.can(org),
    };
  }

  async getOrder(org: SalesOrg, id: string) {
    const o = (await this.prisma.salesOrder.findFirst({ where: { id, orgId: org.id }, include: this.orderInclude })) as OrderWithLines | null;
    if (!o) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Sales order not found' });
    const [{ live, docs }, n, quote] = await Promise.all([
      this.liveDocuments(org.id, [o]),
      this.names(org.id, [o], o.lines),
      o.quoteId ? this.prisma.salesQuote.findFirst({ where: { id: o.quoteId, orgId: org.id }, select: { id: true, number: true, revision: true } }) : null,
    ]);
    const billings = await this.prisma.salesOrderBilling.findMany({ where: { orgId: org.id, orderId: id }, orderBy: { createdAt: 'asc' } });
    const invoices = docs.map((d) => {
      const bs = billings.filter((b) => b.documentId === d.id);
      return { id: d.id, number: d.number, status: d.status, issueDate: fromDbDate(d.issueDate), total: this.money(org, d.total), lines: bs.map((b) => ({ lineNo: o.lines.find((l) => l.id === b.orderLineId)!.lineNo, quantity: this.qty(b.quantity) })) };
    });
    return { ...this.orderOut(org, o, n, live), quote: quote ? { id: quote.id, reference: quoteRef(quote) } : null, invoices, can: { ...this.can(org), cancel: hasPermission(org.role, 'sales.manage') } };
  }

  async createOrder(org: SalesOrg, actor: Actor, input: OrderInput) {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkDeal(tx, org.id, input.dealId, input.contactId);
      const c = await this.compute(tx, org, { contactId: input.contactId, date: input.orderDate, placeOfSupply: input.placeOfSupply, lines: input.lines });
      const number = await this.nextNumber(tx, org.id, 'sales_order');
      const o = await tx.salesOrder.create({
        data: {
          orgId: org.id, number, contactId: input.contactId, dealId: input.dealId ?? null, orderDate: toDbDate(input.orderDate), placeOfSupply: c.placeOfSupply, reference: clean(input.reference), memo: clean(input.memo),
          currency: org.functionalCurrency, subtotal: c.subtotal, taxTotal: c.taxTotal, total: c.total, createdById: actor.id,
          lines: { create: c.lines.map((l) => ({ ...l, orgId: org.id })) },
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_order.created', entityType: 'sales_order', entityId: o.id, data: { reference: orderRef(number), contactId: input.contactId, total: c.total } });
      if (input.dealId) await this.winDeal(tx, org, actor, input.dealId, `Won: order ${orderRef(number)} received`);
      return o.id;
    });
    return this.getOrder(org, id);
  }

  private async lockOrder(tx: Tx, orgId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const o = (await tx.salesOrder.findFirst({ where: { id, orgId }, include: this.orderInclude })) as OrderWithLines | null;
    if (!o) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Sales order not found' });
    const ids = [...new Set(o.lines.flatMap((l) => l.billings.map((b) => b.documentId)))];
    const docs = ids.length ? await tx.document.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, status: true } }) : [];
    const live = new Set(docs.filter((d) => d.status !== 'VOID').map((d) => d.id));
    const lines = o.lines.map((l) => ({ id: l.id, lineNo: l.lineNo, quantity: l.quantity.toString(), billed: l.billings.filter((b) => live.has(b.documentId)).reduce((t, b) => t.plus(b.quantity.toString()), new D(0)).toFixed(), line: l }));
    return { o, lines };
  }

  /**
   * Bill an order: a draft invoice with the chosen quantities at the order's prices and tax rates,
   * worked out again by the invoice rules on the invoice date. It is then reviewed and posted like
   * any invoice.
   */
  async billOrder(org: SalesOrg, actor: Actor, id: string, input: { issueDate: string; dueDate?: string | null; lines?: { orderLineId: string; quantity: string }[] | null }) {
    const docId = await this.prisma.$transaction(async (tx) => {
      const { o, lines } = await this.lockOrder(tx, org.id, id);
      if (o.status === 'CANCELLED') this.invalid('This order is cancelled', 'ORDER_CANCELLED');
      if (input.issueDate < fromDbDate(o.orderDate)) this.invalid('The invoice cannot be dated before the order', 'ORDER_DATE');
      const request = input.lines?.length ? input.lines : lines.filter((l) => new D(remainingToBill(l)).gt(0)).map((l) => ({ orderLineId: l.id, quantity: remainingToBill(l) }));
      if (!request.length) this.invalid('Everything on this order is billed', 'ORDER_BILLED');
      const issues = billingIssues(lines, request);
      if (issues.length) this.invalid(issues[0]!, 'ORDER_BILLING_INVALID', { issues });
      const chosen = request.map((r) => ({ r, l: lines.find((x) => x.id === r.orderLineId)!.line }));
      const doc = await this.documents.createDraftInTx(tx, org, actor, 'SALES', {
        kind: 'INVOICE',
        contactId: o.contactId,
        issueDate: input.issueDate,
        dueDate: input.dueDate ?? undefined,
        reference: o.reference ? `${orderRef(o.number)} / ${o.reference}` : orderRef(o.number),
        memo: o.memo,
        placeOfSupply: o.placeOfSupply,
        lines: chosen.map(({ r, l }) => ({ accountId: l.accountId, description: l.description ?? undefined, quantity: r.quantity, unitPrice: l.unitPrice.toFixed(), taxRateId: l.taxRateId, hsnCode: l.hsnCode })),
      });
      await tx.salesOrderBilling.createMany({ data: chosen.map(({ r, l }) => ({ orgId: org.id, orderId: o.id, orderLineId: l.id, documentId: doc.id, quantity: new D(r.quantity).toFixed(), createdById: actor.id })) });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_order.billed', entityType: 'sales_order', entityId: o.id, data: { reference: orderRef(o.number), documentId: doc.id, lines: request } });
      return doc.id;
    });
    return { documentId: docId, order: await this.getOrder(org, id) };
  }

  async cancelOrder(org: SalesOrg, actor: Actor, id: string, reason: string) {
    if (!reason.trim()) this.invalid('Say why the order is cancelled', 'ORDER_REASON_REQUIRED');
    await this.prisma.$transaction(async (tx) => {
      const { o, lines } = await this.lockOrder(tx, org.id, id);
      if (o.status === 'CANCELLED') this.invalid('This order is already cancelled', 'ORDER_CANCELLED');
      if (lines.some((l) => new D(l.billed).gt(0))) this.invalid('Part of this order is billed; void or delete those invoices first', 'ORDER_HAS_INVOICES');
      await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason.trim(), cancelledAt: new Date() } });
      await this.dealNote(tx, org, actor, o.dealId, `Order ${orderRef(o.number)} cancelled: ${reason.trim()}`);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_order.cancelled', entityType: 'sales_order', entityId: id, data: { reference: orderRef(o.number), reason: reason.trim() } });
    });
    return this.getOrder(org, id);
  }
}
