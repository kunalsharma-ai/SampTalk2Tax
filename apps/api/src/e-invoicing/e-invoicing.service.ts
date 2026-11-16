import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Contact, Document, DocumentLine, EInvoice, EInvoiceSettings, GstRegistration } from '@talk2tax/database';
import {
  buildEInvoice,
  cancellable,
  EINVOICE_CANCEL_REASONS,
  EInvoiceCancelReason,
  EInvoiceInput,
  EInvoiceIssue,
  matchIrpResponse,
  parseIrpResponse,
  QrData,
  reportingDeadline,
  signedData,
} from '@talk2tax/tax-engine';
import { createHash } from 'node:crypto';
import { compactVerify, importSPKI } from 'jose';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

export type EInvoiceState = 'NOT_REQUIRED' | 'UNSUPPORTED' | 'NEEDS_DATA' | 'READY' | 'TOO_LATE' | 'GENERATED' | 'CANCELLED';

type Doc = Document & { contact: Contact; lines: DocumentLine[]; eInvoices: EInvoice[] };
interface Context {
  settings: EInvoiceSettings;
  gst: GstRegistration;
  orgLegalName: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_RANGE_DAYS = 400;
/** 30 Apr 2026, for messages people read. */
const human = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const humanTime = (d: Date) => `${d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })} IST`;

@Injectable()
export class EInvoicingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ settings

  async getSettings(orgId: string) {
    const s = await this.prisma.eInvoiceSettings.findUnique({ where: { orgId } });
    const gst = await this.prisma.gstRegistration.findUnique({ where: { orgId } });
    if (!s) return { configured: false as const, gstRegistered: !!gst };
    return { configured: true as const, gstRegistered: !!gst, ...this.serializeSettings(s) };
  }

  async saveSettings(
    orgId: string,
    actor: { id: string },
    input: { applicableFrom: string; aatoTenCroreOrMore: boolean; tradeName?: string | null; address1: string; address2?: string | null; city: string; pincode: string; goodsUnit: string; irpPublicKey?: string | null },
  ) {
    const gst = await this.prisma.gstRegistration.findUnique({ where: { orgId } });
    if (!gst) throw new DomainError('GST_NOT_REGISTERED', 'E-invoicing needs the GST registration first', HttpStatus.CONFLICT);
    const key = input.irpPublicKey?.trim() || null;
    if (key) {
      try {
        await importSPKI(key, 'RS256');
      } catch {
        throw new DomainError('INVALID_KEY', 'The IRP public key must be an RSA public key in PEM format (-----BEGIN PUBLIC KEY-----)');
      }
    }
    const data = {
      applicableFrom: toDbDate(input.applicableFrom),
      aatoTenCroreOrMore: input.aatoTenCroreOrMore,
      tradeName: input.tradeName?.trim() || null,
      address1: input.address1.trim(),
      address2: input.address2?.trim() || null,
      city: input.city.trim(),
      pincode: input.pincode,
      goodsUnit: input.goodsUnit.toUpperCase(),
      irpPublicKey: key,
    };
    const s = await this.prisma.$transaction(async (tx) => {
      const before = await tx.eInvoiceSettings.findUnique({ where: { orgId } });
      const row = before ? await tx.eInvoiceSettings.update({ where: { orgId }, data }) : await tx.eInvoiceSettings.create({ data: { orgId, ...data } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: before ? 'einvoice.settings_updated' : 'einvoice.configured', entityType: 'e_invoice_settings', entityId: orgId, data: { ...data, irpPublicKey: key ? 'set' : null } });
      return row;
    });
    return { configured: true as const, gstRegistered: true, ...this.serializeSettings(s) };
  }

  // ------------------------------------------------------------------ register and documents

  async register(orgId: string, from: string, to: string) {
    if (from > to) throw new DomainError('INVALID_RANGE', 'from must not be after to');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) throw new DomainError('INVALID_RANGE', `Ask for at most ${MAX_RANGE_DAYS} days at a time`);
    const ctx = await this.context(orgId);
    const docs = await this.prisma.document.findMany({
      where: { orgId, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: { in: ['POSTED', 'VOID'] }, issueDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      include: { contact: true, lines: { orderBy: { lineNo: 'asc' } }, eInvoices: { orderBy: { createdAt: 'asc' } } },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    });
    const today = todayIso();
    const rows = docs.map((d) => this.row(ctx, d, today));
    const count = (s: EInvoiceState) => rows.filter((r) => r.state === s).length;
    return {
      from,
      to,
      today,
      aatoTenCroreOrMore: ctx.settings.aatoTenCroreOrMore,
      summary: { ready: count('READY'), needsData: count('NEEDS_DATA'), tooLate: count('TOO_LATE'), generated: count('GENERATED'), cancelled: count('CANCELLED'), notRequired: count('NOT_REQUIRED') + count('UNSUPPORTED') },
      rows,
    };
  }

  async getDocument(orgId: string, documentId: string) {
    const ctx = await this.context(orgId, false);
    const d = await this.loadDoc(orgId, documentId);
    if (!ctx) return { configured: false as const, documentId };
    return { configured: true as const, ...this.row(ctx, d, todayIso()), history: d.eInvoices.map((e) => this.serializeEInvoice(e)) };
  }

  /** The INV-01 JSON for one document, ready to upload to the IRP. */
  async payload(orgId: string, documentId: string) {
    const ctx = await this.context(orgId);
    const d = await this.loadDoc(orgId, documentId);
    const r = this.row(ctx, d, todayIso());
    if (r.state !== 'READY') throw this.notReady(r);
    return r.payload!;
  }

  /** INV-01 JSON for several documents at once (the offline tool takes a JSON array). Documents that are not ready are listed with why. */
  async bulkPayload(orgId: string, documentIds: string[]) {
    const ctx = await this.context(orgId);
    const docs = await this.prisma.document.findMany({ where: { orgId, id: { in: documentIds } }, include: { contact: true, lines: { orderBy: { lineNo: 'asc' } }, eInvoices: true } });
    if (docs.length !== new Set(documentIds).size) throw new NotFoundException('Some documents were not found');
    const today = todayIso();
    const rows = docs.map((d) => this.row(ctx, d, today));
    return {
      payloads: rows.filter((r) => r.state === 'READY').map((r) => r.payload!),
      skipped: rows.filter((r) => r.state !== 'READY').map((r) => ({ documentId: r.documentId, number: r.number, state: r.state, reason: r.reason })),
    };
  }

  /** Record the IRN from the IRP's response, after checking it is for this document. */
  async importResponse(orgId: string, actor: { id: string }, documentId: string, raw: unknown) {
    const ctx = await this.context(orgId);
    const d = await this.loadDoc(orgId, documentId);
    const r = this.row(ctx, d, todayIso());
    if (r.state === 'GENERATED') throw new DomainError('IRN_EXISTS', `${d.number} already has IRN ${r.eInvoice!.irn}; cancel it first`, HttpStatus.CONFLICT);
    if (r.state !== 'READY' && r.state !== 'TOO_LATE' && r.state !== 'CANCELLED') throw this.notReady(r);
    const built = this.build(ctx, d);
    if (!built.payload) throw this.notReady(r);
    const parsed = parseIrpResponse(raw);
    if (!parsed.response) throw new DomainError('INVALID_IRP_RESPONSE', 'That is not an IRP response', HttpStatus.UNPROCESSABLE_ENTITY, { issues: parsed.issues });
    const res = parsed.response;
    const mismatch = matchIrpResponse(res, { sellerGstin: ctx.gst.gstin, buyerGstin: d.counterpartyGstin!, number: d.number!, kind: d.debitNoteForId ? 'DEBIT_NOTE' : (d.kind as 'INVOICE' | 'CREDIT_NOTE'), issueDate: fromDbDate(d.issueDate), total: d.total.toFixed() });
    if (mismatch.length) throw new DomainError('IRP_RESPONSE_MISMATCH', 'The IRP response is not for this document', HttpStatus.UNPROCESSABLE_ENTITY, { issues: mismatch });
    if (Date.parse(res.ackDate) > Date.now() + 5 * 60_000) throw new DomainError('INVALID_IRP_RESPONSE', 'The acknowledgement date is in the future');
    let verified = false;
    if (ctx.settings.irpPublicKey) {
      try {
        await compactVerify(res.signedQrCode, await importSPKI(ctx.settings.irpPublicKey, 'RS256'));
        verified = true;
      } catch {
        throw new DomainError('SIGNATURE_INVALID', 'The signed QR code was not signed with the IRP key in the e-invoicing settings');
      }
    }
    const e = await this.prisma.$transaction(async (tx) => {
      const row = await tx.eInvoice.create({
        data: { orgId, documentId, irn: res.irn, ackNo: res.ackNo, ackDate: new Date(res.ackDate), signedQrCode: res.signedQrCode, signedInvoice: res.signedInvoice, signatureVerified: verified, payloadHash: sha256(JSON.stringify(built.payload)), createdById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'einvoice.irn_recorded', entityType: 'document', entityId: documentId, data: { number: d.number, irn: res.irn, ackNo: res.ackNo, ackDate: res.ackDate, signatureVerified: verified } });
      return row;
    });
    return this.serializeEInvoice(e);
  }

  /** Record that the IRN was cancelled on the IRP (allowed within 24 hours of the acknowledgement). */
  async cancel(orgId: string, actor: { id: string }, documentId: string, input: { cancelledAt?: string; reason: EInvoiceCancelReason; remark: string }) {
    const d = await this.loadDoc(orgId, documentId);
    const live = d.eInvoices.find((e) => e.status === 'ACTIVE');
    if (!live) throw new DomainError('NO_IRN', `${d.number} has no live IRN`, HttpStatus.CONFLICT);
    const at = input.cancelledAt ?? new Date().toISOString();
    if (Date.parse(at) > Date.now() + 5 * 60_000) throw new DomainError('INVALID_DATE', 'The cancellation time cannot be in the future');
    if (!cancellable(live.ackDate.toISOString(), at)) throw new DomainError('CANCEL_WINDOW_CLOSED', `An IRN can be cancelled only within 24 hours of its acknowledgement (${humanTime(live.ackDate)}). Issue a credit note instead.`, HttpStatus.CONFLICT);
    const e = await this.prisma.$transaction(async (tx) => {
      const row = await tx.eInvoice.update({ where: { id: live.id }, data: { status: 'CANCELLED', cancelledAt: new Date(at), cancelReason: input.reason, cancelRemark: input.remark.trim(), cancelledById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'einvoice.irn_cancelled', entityType: 'document', entityId: documentId, data: { number: d.number, irn: live.irn, reason: EINVOICE_CANCEL_REASONS[input.reason], remark: input.remark } });
      return row;
    });
    return this.serializeEInvoice(e);
  }

  // ------------------------------------------------------------------ internals

  private async context(orgId: string): Promise<Context>;
  private async context(orgId: string, required: false): Promise<Context | null>;
  private async context(orgId: string, required = true): Promise<Context | null> {
    const [settings, gst, org] = await Promise.all([
      this.prisma.eInvoiceSettings.findUnique({ where: { orgId } }),
      this.prisma.gstRegistration.findUnique({ where: { orgId } }),
      this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, legalName: true } }),
    ]);
    if (!settings || !gst) {
      if (!required) return null;
      throw new DomainError('EINVOICE_NOT_CONFIGURED', 'Set up e-invoicing first', HttpStatus.CONFLICT);
    }
    return { settings, gst, orgLegalName: gst.legalName ?? org.legalName ?? org.name };
  }

  private async loadDoc(orgId: string, id: string): Promise<Doc> {
    const d = await this.prisma.document.findFirst({ where: { id, orgId }, include: { contact: true, lines: { orderBy: { lineNo: 'asc' } }, eInvoices: { orderBy: { createdAt: 'asc' } } } });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  private build(ctx: Context, d: Doc) {
    const addr = (d.contact.address ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const input: EInvoiceInput = {
      kind: d.debitNoteForId ? 'DEBIT_NOTE' : (d.kind as 'INVOICE' | 'CREDIT_NOTE'),
      number: d.number ?? '',
      issueDate: fromDbDate(d.issueDate),
      currency: d.currency,
      placeOfSupply: d.placeOfSupply ?? '',
      seller: { gstin: ctx.gst.gstin, legalName: ctx.orgLegalName, tradeName: ctx.settings.tradeName, address1: ctx.settings.address1, address2: ctx.settings.address2, location: ctx.settings.city, pincode: ctx.settings.pincode },
      buyer: { gstin: d.counterpartyGstin ?? '', legalName: d.contact.name, address1: addr[0] ?? '', address2: addr.slice(1).join(', ') || null, location: d.contact.city ?? '', pincode: d.contact.pincode ?? '' },
      lines: d.lines.map((l) => ({
        description: l.description ?? '',
        hsnCode: l.hsnCode,
        quantity: l.quantity.toFixed(),
        unitPrice: l.unitPrice.toFixed(),
        netAmount: l.netAmount.toFixed(),
        gstRate: l.taxRate.toFixed(),
        cgst: l.cgstAmount.toFixed(),
        sgst: l.sgstAmount.toFixed(),
        igst: l.igstAmount.toFixed(),
      })),
      otherCharges: d.withholdingKind === 'TCS' ? d.withholdingAmount.toFixed() : '0',
      total: d.total.toFixed(),
      goodsUnit: ctx.settings.goodsUnit,
    };
    return buildEInvoice(input);
  }

  private row(ctx: Context, d: Doc, today: string) {
    const live = d.eInvoices.find((e) => e.status === 'ACTIVE') ?? null;
    const last = d.eInvoices[d.eInvoices.length - 1] ?? null;
    const issueDate = fromDbDate(d.issueDate);
    const deadline = reportingDeadline(issueDate, ctx.settings.aatoTenCroreOrMore);
    const base = {
      documentId: d.id,
      kind: d.debitNoteForId ? ('DEBIT_NOTE' as const) : d.kind,
      number: d.number,
      issueDate,
      documentStatus: d.status,
      contact: { id: d.contact.id, name: d.contact.name },
      buyerGstin: d.counterpartyGstin,
      total: d.total.toFixed(2),
      deadline,
      eInvoice: live ? this.serializeEInvoice(live) : last ? this.serializeEInvoice(last) : null,
      issues: [] as EInvoiceIssue[],
      payload: null as Record<string, unknown> | null,
    };
    const out = (state: EInvoiceState, reason: string, extra: Partial<typeof base> = {}) => ({ ...base, ...extra, state, reason });
    if (live) return out('GENERATED', `IRN recorded, acknowledged ${humanTime(live.ackDate)}`);
    if (fromDbDate(d.issueDate) < fromDbDate(ctx.settings.applicableFrom)) return out('NOT_REQUIRED', 'Dated before e-invoicing applies');
    if (d.currency !== 'INR') return out('UNSUPPORTED', `In ${d.currency}: e-invoices for foreign-currency documents are not supported yet; report it on the IRP directly`);
    if (d.placeOfSupply === '96') return out('UNSUPPORTED', 'Export: e-invoices for exports are not supported yet; report it on the IRP directly');
    if (!d.counterpartyGstin) return out('NOT_REQUIRED', 'Customer not registered for GST (B2C)');
    if (d.status === 'VOID') return out(last ? 'CANCELLED' : 'NOT_REQUIRED', last ? 'IRN cancelled and document voided' : 'Voided');
    const built = this.build(ctx, d);
    if (!built.payload) return out('NEEDS_DATA', built.issues.map((i) => i.message).join('; '), { issues: built.issues });
    if (deadline && today > deadline) return out('TOO_LATE', `The IRP accepts it only until ${human(deadline)} (30-day limit); issue a fresh document or take advice`, { payload: built.payload });
    if (last) return out('READY', 'IRN cancelled; a new IRN can be generated for corrected details', { payload: built.payload });
    return out('READY', deadline ? `Report to the IRP by ${human(deadline)}` : 'Ready to upload to the IRP', { payload: built.payload });
  }

  private notReady(r: { state: EInvoiceState; reason: string; issues: EInvoiceIssue[] }) {
    const code = r.state === 'NEEDS_DATA' ? 'EINVOICE_DATA_MISSING' : r.state === 'TOO_LATE' ? 'REPORTING_WINDOW_CLOSED' : 'EINVOICE_NOT_APPLICABLE';
    return new DomainError(code, r.reason, HttpStatus.UNPROCESSABLE_ENTITY, r.issues.length ? { issues: r.issues.map((i) => i.message) } : undefined);
  }

  private serializeSettings(s: EInvoiceSettings) {
    return {
      applicableFrom: fromDbDate(s.applicableFrom),
      aatoTenCroreOrMore: s.aatoTenCroreOrMore,
      tradeName: s.tradeName,
      address1: s.address1,
      address2: s.address2,
      city: s.city,
      pincode: s.pincode,
      goodsUnit: s.goodsUnit,
      irpPublicKeySet: !!s.irpPublicKey,
    };
  }

  private serializeEInvoice(e: EInvoice) {
    let qr: QrData | null = null;
    try {
      qr = signedData<QrData>(e.signedQrCode);
    } catch {
      qr = null;
    }
    return {
      id: e.id,
      irn: e.irn,
      ackNo: e.ackNo,
      ackDate: e.ackDate.toISOString(),
      status: e.status,
      signedQrCode: e.signedQrCode,
      signatureVerified: e.signatureVerified,
      qr: qr ? { sellerGstin: qr.SellerGstin, buyerGstin: qr.BuyerGstin, docNo: qr.DocNo, docType: qr.DocTyp, docDate: qr.DocDt, total: String(qr.TotInvVal), itemCount: qr.ItemCnt ?? null, mainHsn: qr.MainHsnCode ?? null } : null,
      cancellableUntil: new Date(e.ackDate.getTime() + 24 * 3_600_000).toISOString(),
      cancelledAt: e.cancelledAt?.toISOString() ?? null,
      cancelReason: e.cancelReason ? EINVOICE_CANCEL_REASONS[e.cancelReason as EInvoiceCancelReason] : null,
      cancelRemark: e.cancelRemark,
      createdAt: e.createdAt.toISOString(),
    };
  }
}
