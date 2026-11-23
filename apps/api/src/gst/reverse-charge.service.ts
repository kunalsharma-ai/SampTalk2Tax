import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, dec } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { financialYearOf, gstPeriodRange, indiaState, REVERSE_CHARGE_CATEGORIES, reverseChargeCategory, reverseChargeRegister, SELF_INVOICE_DAYS, selfInvoiceIssues, selfInvoiceNumber, selfInvoiceRequired } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { gstPayments } from '../db/collections/gst-payments';
import { users } from '../db/collections/identity';
import { rcmSelfInvoices } from '../db/collections/rcm-self-invoices';
import { GstService } from './gst.service';

/**
 * Reverse charge (TAX-032): the month's register of bills and vendor credits under reverse charge,
 * the tax to pay in cash, bills whose HSN/SAC is a notified reverse-charge category but which were
 * not recorded under reverse charge, and self-invoices for bills from suppliers who are not
 * registered (CGST Act s.31(3)(f), rule 47A). The rules are in packages/tax-engine
 * (india/reverse-charge.ts). reports.read to read; accounts.manage to issue a self-invoice (audited).
 */
@Injectable()
export class ReverseChargeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly gst: GstService,
    private readonly audit: AuditService,
  ) {}

  private async registration(orgId: string) {
    const reg = await this.gst.registration(this.prisma, orgId);
    if (!reg) throw new DomainError('GST_NOT_REGISTERED', 'Set up the GST registration first (Settings → GST)', HttpStatus.CONFLICT);
    return reg;
  }

  async month(org: OrgContext, period?: string, today = todayIso()) {
    await this.registration(org.id);
    const month = period ?? today.slice(0, 7);
    let range: { from: string; to: string };
    try {
      range = gstPeriodRange(month);
    } catch {
      throw new DomainError('INVALID_PERIOD', 'Give the month as YYYY-MM', HttpStatus.BAD_REQUEST);
    }
    const docs = await this.gst.purchaseDocuments(org.id, range.from, range.to);
    const issued = docs.length ? await this.store.collection(rcmSelfInvoices).find({ documentId: { $in: docs.map((d) => d.id) } }) : [];
    const register = reverseChargeRegister(docs, new Map(issued.map((s) => [s.documentId, { number: s.number, issuedOn: s.issuedOn }])), today);
    const paid = await this.store.collection(gstPayments).findOne({ period: month, status: 'POSTED' });
    return {
      period: month,
      ...range,
      asOf: today,
      ...register,
      selfInvoiceDays: SELF_INVOICE_DAYS,
      payment: paid ? { id: paid.id, number: paid.number, paymentDate: fromDbDate(paid.paymentDate), cash: (['igst', 'cgst', 'sgst'] as const).reduce((s, h) => s.plus(dec(paid.cash[h])), new D(0)).toFixed(2) } : null,
      categories: REVERSE_CHARGE_CATEGORIES,
    };
  }

  private async document(orgId: string, id: string) {
    const d = await this.gst.purchaseDocument(orgId, id);
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bill not found' });
    return d;
  }

  /** The self-invoice for a reverse-charge bill: issued, or what it would say before it is issued. */
  async selfInvoice(org: OrgContext, id: string) {
    const reg = await this.registration(org.id);
    const d = await this.document(org.id, id);
    const si = await this.store.collection(rcmSelfInvoices).findOne({ documentId: id });
    const by = si ? ((await this.store.collection(users).findById(si.createdById))?.name ?? 'Former member') : null;
    const state = (code: string | undefined) => (code ? (code === '96' ? 'Outside India' : (indiaState(code)?.name ?? code)) : null);
    const lines = d.lines.map((l) => ({ ...l, category: reverseChargeCategory(l.hsnCode)?.title ?? null, tax: dec(l.igst).plus(dec(l.cgst)).plus(dec(l.sgst)).toFixed(2) }));
    const sum = (k: 'taxable' | 'igst' | 'cgst' | 'sgst') => lines.reduce((s, l) => s.plus(dec(l[k])), new D(0)).toFixed(2);
    const required = selfInvoiceRequired(d);
    return {
      documentId: d.id,
      kind: d.kind,
      status: d.status,
      billNumber: d.number,
      billDate: d.issueDate,
      reverseCharge: !!d.reverseCharge,
      required,
      dueBy: required ? new Date(Date.parse(`${d.issueDate}T00:00:00Z`) + SELF_INVOICE_DAYS * 86_400_000).toISOString().slice(0, 10) : null,
      issued: si ? { number: si.number, issuedOn: si.issuedOn, issuedBy: by, issuedAt: si.createdAt.toISOString() } : null,
      recipient: { name: reg.legalName ?? null, gstin: reg.gstin, state: state(reg.stateCode) },
      supplier: { name: d.contactName, gstin: d.gstin, state: state(d.supplierState), importOfServices: d.supplierState === '96' },
      placeOfSupply: state(d.placeOfSupply),
      lines,
      totals: { taxable: sum('taxable'), igst: sum('igst'), cgst: sum('cgst'), sgst: sum('sgst'), tax: lines.reduce((s, l) => s.plus(dec(l.tax)), new D(0)).toFixed(2) },
    };
  }

  async issue(org: OrgContext, user: AuthUser, id: string, issuedOn: string | undefined, today = todayIso()) {
    await this.registration(org.id);
    const d = await this.document(org.id, id);
    const col = this.store.collection(rcmSelfInvoices);
    const existing = await col.findOne({ documentId: id });
    const on = issuedOn ?? today;
    const issues = selfInvoiceIssues(d, existing ? { number: existing.number, issuedOn: existing.issuedOn } : null, on, today);
    if (issues.length) throw new DomainError('SELF_INVOICE_INVALID', issues.join(' '), HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const fy = financialYearOf(on);
    const [last] = await col.find({ fy }, { sort: { seq: -1 }, limit: 1 });
    const seq = (last?.seq ?? 0) + 1; // not money
    const number = selfInvoiceNumber(fy, seq);
    try {
      await col.insertOne({ documentId: id, number, fy, seq, issuedOn: on, createdById: user.id, createdAt: new Date() });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('CHANGED', 'A self-invoice was issued meanwhile; reload and try again', HttpStatus.CONFLICT);
      throw e;
    }
    const tax = d.lines.reduce((s, l) => s.plus(dec(l.igst)).plus(dec(l.cgst)).plus(dec(l.sgst)), new D(0)).toFixed(2);
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'gst.rcm_self_invoice_issued', entityType: 'document', entityId: id, data: { number, bill: d.number, issuedOn: on, supplier: d.contactName, tax, late: on > new Date(Date.parse(`${d.issueDate}T00:00:00Z`) + SELF_INVOICE_DAYS * 86_400_000).toISOString().slice(0, 10) } }));
    return this.selfInvoice(org, id);
  }
}
