import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, minorUnits, ProFormaError, proFormaAllows, proFormaRef, proFormaState, type ProFormaAction, type ProFormaState, type ProFormaStatus } from '@talk2tax/accounting-engine';
import { ProFormaInvoice, ProFormaInvoiceLine } from '@talk2tax/database';
import { gstHeads } from '@talk2tax/tax-engine';
import type { InvoicePrintSource } from '@talk2tax/accounting-engine';
import { InvoiceTemplatesService } from '../invoice-templates/invoice-templates.service';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { DocumentsService } from '../ledgers/documents.service';
import { todayIst } from '../tasks/tasks.service';
import { LineInput, SalesOrg, SalesOrdersService } from './sales-orders.service';
import { lockRow } from '../db/locks';

type Actor = { id: string };
type WithLines = ProFormaInvoice & { lines: ProFormaInvoiceLine[] };
export interface ProFormaInput {
  contactId: string;
  quoteId?: string | null;
  issueDate: string;
  validUntil: string;
  placeOfSupply?: string | null;
  reference?: string | null;
  terms?: string | null;
  memo?: string | null;
  lines: LineInput[];
}
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
const quoteRef = (q: { number: number; revision: number }) => `QT-${String(q.number).padStart(4, '0')}${q.revision > 1 ? `-R${q.revision}` : ''}`;

/**
 * Pro forma invoices (AR-008). Lines and totals are worked out by the invoice rules (tax rates,
 * India GST place of supply), so the tax invoice made from one has the same figures. Issuing fixes
 * it (a database trigger keeps it so); it posts nothing. Invoicing makes a draft tax invoice with
 * the same lines; deleting or voiding that invoice frees the pro forma again.
 */
@Injectable()
export class ProFormaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesOrdersService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly templates: InvoiceTemplatesService,
  ) {}

  private invalid(message: string, code = 'PRO_FORMA_INVALID'): never {
    throw new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private allow(state: ProFormaState, action: ProFormaAction) {
    try {
      proFormaAllows(state, action);
    } catch (e) {
      if (e instanceof ProFormaError) throw new DomainError(e.code, e.message, HttpStatus.CONFLICT);
      throw e;
    }
  }

  private async invoices(orgId: string, ids: (string | null)[]) {
    const list = ids.filter((x): x is string => !!x);
    const docs = list.length ? await this.prisma.document.findMany({ where: { orgId, id: { in: list } }, select: { id: true, number: true, status: true, total: true } }) : [];
    return new Map(docs.map((d) => [d.id, d]));
  }

  private out(org: SalesOrg, p: ProFormaInvoice, n: Awaited<ReturnType<SalesOrdersService['names']>>, inv: Map<string, { id: string; number: string | null; status: string }>, today: string) {
    const invoice = p.invoiceId ? (inv.get(p.invoiceId) ?? null) : null;
    return {
      id: p.id,
      reference: proFormaRef(p.number),
      status: p.status as ProFormaStatus,
      state: proFormaState(p.status as ProFormaStatus, fromDbDate(p.validUntil), invoice, today),
      contact: n.contact(p.contactId),
      issueDate: fromDbDate(p.issueDate),
      validUntil: fromDbDate(p.validUntil),
      placeOfSupply: p.placeOfSupply,
      customerReference: p.reference,
      terms: p.terms,
      memo: p.memo,
      currency: p.currency,
      subtotal: this.sales.money(org, p.subtotal),
      taxTotal: this.sales.money(org, p.taxTotal),
      total: this.sales.money(org, p.total),
      issuedAt: p.issuedAt?.toISOString() ?? null,
      cancelReason: p.cancelReason,
      cancelledAt: p.cancelledAt?.toISOString() ?? null,
      invoice: invoice && invoice.status !== 'VOID' ? { id: invoice.id, number: invoice.number, status: invoice.status } : null,
      createdAt: p.createdAt.toISOString(),
    };
  }

  async list(org: SalesOrg, f: { view?: 'open' | 'invoiced' | 'all'; contactId?: string }) {
    const today = todayIst();
    const rows = await this.prisma.proFormaInvoice.findMany({ where: { orgId: org.id, ...(f.contactId ? { contactId: f.contactId } : {}) }, orderBy: { number: 'desc' }, take: 500 });
    const [n, inv] = await Promise.all([this.sales.names(org.id, rows.map((r) => ({ contactId: r.contactId, dealId: null }))), this.invoices(org.id, rows.map((r) => r.invoiceId))]);
    const all = rows.map((r) => this.out(org, r, n, inv, today));
    const view = f.view ?? 'open';
    const shown = all.filter((p) => view === 'all' || (view === 'invoiced' ? p.state === 'INVOICED' : ['DRAFT', 'ISSUED', 'EXPIRED'].includes(p.state)));
    const scale = minorUnits(org.functionalCurrency);
    const sum = (xs: typeof all) => xs.reduce((t, x) => t.plus(x.total), new D(0)).toFixed(scale);
    const awaiting = all.filter((p) => p.state === 'ISSUED' || p.state === 'EXPIRED');
    return {
      proFormas: shown,
      totals: {
        drafts: all.filter((p) => p.state === 'DRAFT').length,
        awaiting: { count: awaiting.length, total: sum(awaiting) },
        expired: all.filter((p) => p.state === 'EXPIRED').length,
        invoiced: { count: all.filter((p) => p.state === 'INVOICED').length, total: sum(all.filter((p) => p.state === 'INVOICED')) },
      },
      can: this.sales.can(org),
    };
  }

  async get(org: SalesOrg, id: string) {
    const today = todayIst();
    const p = await this.prisma.proFormaInvoice.findFirst({ where: { id, orgId: org.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Pro forma invoice not found' });
    const [n, inv, quote] = await Promise.all([
      this.sales.names(org.id, [{ contactId: p.contactId, dealId: null }], p.lines),
      this.invoices(org.id, [p.invoiceId]),
      p.quoteId ? this.prisma.salesQuote.findFirst({ where: { id: p.quoteId, orgId: org.id }, select: { id: true, number: true, revision: true } }) : null,
    ]);
    return {
      ...this.out(org, p, n, inv, today),
      lines: p.lines.map((l) => this.sales.lineOut(org, l, n)),
      quote: quote ? { id: quote.id, reference: quoteRef(quote) } : null,
      can: this.sales.can(org),
    };
  }

  private async checkQuote(tx: Tx, orgId: string, quoteId: string | null | undefined, contactId: string) {
    if (!quoteId) return;
    const q = await tx.salesQuote.findFirst({ where: { id: quoteId, orgId }, select: { contactId: true, number: true, revision: true } });
    if (!q) this.invalid('Choose a quotation of this organisation', 'PRO_FORMA_QUOTE');
    if (q.contactId !== contactId) this.invalid(`${quoteRef(q)} is for another customer`, 'PRO_FORMA_QUOTE');
  }

  private data(org: SalesOrg, input: ProFormaInput, c: Awaited<ReturnType<SalesOrdersService['compute']>>) {
    return {
      contactId: input.contactId,
      quoteId: input.quoteId ?? null,
      issueDate: toDbDate(input.issueDate),
      validUntil: toDbDate(input.validUntil),
      placeOfSupply: c.placeOfSupply,
      reference: clean(input.reference),
      terms: clean(input.terms),
      memo: clean(input.memo),
      subtotal: c.subtotal,
      taxTotal: c.taxTotal,
      total: c.total,
      // The line's org_id comes with the relation (pro_forma_id, org_id).
      lines: { create: c.lines },
    };
  }

  async create(org: SalesOrg, actor: Actor, input: ProFormaInput) {
    if (input.validUntil < input.issueDate) this.invalid('A pro forma invoice cannot be valid until a date before its own', 'PRO_FORMA_DATES');
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkQuote(tx, org.id, input.quoteId, input.contactId);
      const c = await this.sales.compute(tx, org, { contactId: input.contactId, date: input.issueDate, placeOfSupply: input.placeOfSupply, lines: input.lines });
      const number = await this.sales.nextNumber(tx, org.id, 'pro_forma');
      const p = await tx.proFormaInvoice.create({ data: { orgId: org.id, number, currency: org.functionalCurrency, createdById: actor.id, ...this.data(org, input, c) } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'pro_forma.created', entityType: 'pro_forma', entityId: p.id, data: { reference: proFormaRef(number), contactId: input.contactId, total: c.total, quoteId: input.quoteId ?? null } });
      return p.id;
    });
    return this.get(org, id);
  }

  private async lock(tx: Tx, orgId: string, id: string): Promise<{ p: WithLines; state: ProFormaState; invoice: { id: string; number: string | null; status: string } | null }> {
    await lockRow(tx, 'pro_forma_invoices', id, orgId);
    const p = await tx.proFormaInvoice.findFirst({ where: { id, orgId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Pro forma invoice not found' });
    const invoice = p.invoiceId ? await tx.document.findFirst({ where: { id: p.invoiceId, orgId }, select: { id: true, number: true, status: true } }) : null;
    return { p, invoice, state: proFormaState(p.status as ProFormaStatus, fromDbDate(p.validUntil), invoice, todayIst()) };
  }

  async update(org: SalesOrg, actor: Actor, id: string, input: ProFormaInput) {
    if (input.validUntil < input.issueDate) this.invalid('A pro forma invoice cannot be valid until a date before its own', 'PRO_FORMA_DATES');
    await this.prisma.$transaction(async (tx) => {
      const { p, state } = await this.lock(tx, org.id, id);
      this.allow(state, 'EDIT');
      await this.checkQuote(tx, org.id, input.quoteId === undefined ? p.quoteId : input.quoteId, input.contactId);
      const c = await this.sales.compute(tx, org, { contactId: input.contactId, date: input.issueDate, placeOfSupply: input.placeOfSupply, lines: input.lines });
      await tx.proFormaInvoiceLine.deleteMany({ where: { proFormaId: id, orgId: org.id } });
      await tx.proFormaInvoice.update({ where: { id }, data: this.data(org, { ...input, quoteId: input.quoteId === undefined ? p.quoteId : input.quoteId }, c) });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'pro_forma.updated', entityType: 'pro_forma', entityId: id, data: { total: c.total, before: this.sales.money(org, p.total) } });
    });
    return this.get(org, id);
  }

  async remove(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { p, state } = await this.lock(tx, org.id, id);
      this.allow(state, 'DELETE');
      await tx.proFormaInvoice.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'pro_forma.deleted', entityType: 'pro_forma', entityId: id, data: { reference: proFormaRef(p.number) } });
    });
  }

  /** Issue a draft: from now on its customer, dates, lines and figures stay as they are. */
  async issue(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { p, state } = await this.lock(tx, org.id, id);
      this.allow(state, 'ISSUE');
      await tx.proFormaInvoice.update({ where: { id }, data: { status: 'ISSUED', issuedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'pro_forma.issued', entityType: 'pro_forma', entityId: id, data: { reference: proFormaRef(p.number), total: this.sales.money(org, p.total) } });
    });
    return this.get(org, id);
  }

  async cancel(org: SalesOrg, actor: Actor, id: string, reason: string) {
    if (!reason.trim()) this.invalid('Say why the pro forma invoice is cancelled', 'PRO_FORMA_REASON_REQUIRED');
    await this.prisma.$transaction(async (tx) => {
      const { p, state } = await this.lock(tx, org.id, id);
      this.allow(state, 'CANCEL');
      await tx.proFormaInvoice.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason.trim(), cancelledAt: new Date(), invoiceId: null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'pro_forma.cancelled', entityType: 'pro_forma', entityId: id, data: { reference: proFormaRef(p.number), reason: reason.trim() } });
    });
    return this.get(org, id);
  }

  /**
   * The tax invoice: a draft invoice with the pro forma's lines, worked out again by the invoice
   * rules on the invoice date, referenced PF-0001. It is reviewed and posted like any invoice.
   */
  async invoice(org: SalesOrg, actor: Actor, id: string, input: { issueDate: string; dueDate?: string | null }) {
    const docId = await this.prisma.$transaction(async (tx) => {
      const { p, state } = await this.lock(tx, org.id, id);
      this.allow(state, 'INVOICE');
      if (input.issueDate < fromDbDate(p.issueDate)) this.invalid('The invoice cannot be dated before the pro forma invoice', 'PRO_FORMA_DATES');
      const ref = proFormaRef(p.number);
      const doc = await this.documents.createDraftInTx(tx, org, actor, 'SALES', {
        kind: 'INVOICE',
        contactId: p.contactId,
        issueDate: input.issueDate,
        dueDate: input.dueDate ?? undefined,
        reference: p.reference ? `${ref} / ${p.reference}`.slice(0, 100) : ref,
        memo: p.memo,
        placeOfSupply: p.placeOfSupply,
        lines: p.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? undefined, quantity: l.quantity.toFixed(), unitPrice: l.unitPrice.toFixed(), taxRateId: l.taxRateId, hsnCode: l.hsnCode })),
      });
      await tx.proFormaInvoice.update({ where: { id }, data: { invoiceId: doc.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'pro_forma.invoiced', entityType: 'pro_forma', entityId: id, data: { reference: ref, documentId: doc.id } });
      return doc.id;
    });
    return { documentId: docId, proForma: await this.get(org, id) };
  }

  /**
   * What the print page needs: the pro forma as an invoice print source (kind PRO_FORMA, printed
   * "not a tax invoice"), the organisation's invoice template, and the templates to pick from.
   */
  async printData(org: SalesOrg, id: string, templateId?: string | null) {
    const p = await this.prisma.proFormaInvoice.findFirst({ where: { id, orgId: org.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Pro forma invoice not found' });
    const [o, gst, contact, list] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { name: true, legalName: true, countryCode: true } }),
      this.prisma.gstRegistration.findUnique({ where: { orgId: org.id } }),
      this.prisma.contact.findFirstOrThrow({ where: { id: p.contactId, orgId: org.id } }),
      this.prisma.invoiceTemplate.findMany({ where: { orgId: org.id, archivedAt: null }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true, isDefault: true, engine: true } }),
    ]);
    const template = await this.templates.resolveTemplate(org.id, o.countryCode, templateId, null);
    // The GST split (CGST/SGST or IGST) of each line, by the invoice rules on the pro forma's date.
    const split = await this.prisma.$transaction(async (tx) =>
      (
        await this.documents.computeSales(tx, org, {
          contactId: p.contactId,
          issueDate: fromDbDate(p.issueDate),
          placeOfSupply: p.placeOfSupply,
          lines: p.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? undefined, quantity: l.quantity.toFixed(), unitPrice: l.unitPrice.toFixed(), taxRateId: l.taxRateId, hsnCode: l.hsnCode })),
        })
      ).computed.lines,
    );
    const scale = minorUnits(p.currency);
    const status = p.status === 'DRAFT' ? 'DRAFT' : p.status === 'CANCELLED' ? 'VOID' : 'POSTED';
    const source: InvoicePrintSource = {
      kind: 'PRO_FORMA',
      originalInvoice: null,
      status,
      number: p.status === 'DRAFT' ? null : proFormaRef(p.number),
      issueDate: fromDbDate(p.issueDate),
      dueDate: fromDbDate(p.validUntil),
      reference: p.reference,
      memo: [p.memo, p.terms].filter(Boolean).join('\n') || null,
      currency: p.currency,
      placeOfSupply: p.placeOfSupply,
      reverseCharge: false,
      seller: { name: o.name, legalName: gst?.legalName ?? o.legalName, taxId: gst?.gstin ?? null },
      buyer: { name: contact.name, taxId: contact.gstin ?? contact.taxId, address: contact.address, city: contact.city, pincode: contact.pincode, email: contact.email, phone: contact.phone, stateCode: contact.stateCode },
      lines: p.lines.map((l, i) => {
        const h = split[i] ? gstHeads(split[i]!.taxComponents) : null;
        const rate = split[i]?.taxRate ?? new D(0);
        return {
          description: l.description,
          hsnCode: l.hsnCode,
          quantity: l.quantity.toFixed(),
          unitPrice: l.unitPrice.toFixed(),
          taxRate: new D(rate.toString()).toFixed(),
          netAmount: l.netAmount.toFixed(scale),
          taxAmount: l.taxAmount.toFixed(scale),
          cgstAmount: (h?.cgst ?? new D(0)).toFixed(scale),
          sgstAmount: (h?.sgst ?? new D(0)).toFixed(scale),
          igstAmount: (h?.igst ?? new D(0)).toFixed(scale),
        };
      }),
      subtotal: p.subtotal.toFixed(scale),
      taxTotal: p.taxTotal.toFixed(scale),
      withholdingAmount: '0',
      total: p.total.toFixed(scale),
      paid: '0',
      eInvoice: null,
      signature: null,
      logoDataUrl: template.logoDataUrl,
    };
    return { proForma: { id: p.id, reference: proFormaRef(p.number), status: p.status, contactName: contact.name }, source, template, templates: list };
  }
}
