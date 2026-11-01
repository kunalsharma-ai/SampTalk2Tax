import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D } from '@talk2tax/accounting-engine';
import { Contact, Document, DocumentLine, EWayBill, EWayBillSettings, EWayBillVehicleUpdate, GstRegistration, TaxRate, TransportMode } from '@talk2tax/database';
import {
  buildEWayBill,
  consignmentValue,
  EWB_CANCEL_REASONS,
  EWB_VEHICLE_REASONS,
  EWayBillCancelReason,
  EWayBillInput,
  EWayBillIssue,
  EWayBillTransport,
  ewayBillCancellable,
  ewayBillFile,
  ewayBillRequired,
  EWayBillVehicleReason,
  expectedValidUntil,
  generationDeadline,
  indiaState,
  normaliseVehicleNo,
  transportIssues,
} from '@talk2tax/tax-engine';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

export type EWayBillState = 'NEEDED' | 'OPTIONAL' | 'NEEDS_DATA' | 'TOO_OLD' | 'GENERATED' | 'CANCELLED' | 'NOT_APPLICABLE' | 'UNSUPPORTED';

type Bill = EWayBill & { vehicleUpdates: EWayBillVehicleUpdate[] };
type Doc = Document & { contact: Contact; lines: (DocumentLine & { tax: TaxRate | null })[]; eWayBills: Bill[] };
interface Context {
  settings: EWayBillSettings;
  gst: GstRegistration;
  orgLegalName: string;
}
export interface TransportInput {
  mode: TransportMode | null;
  distanceKm: number;
  vehicleNo?: string | null;
  vehicleType: 'R' | 'O';
  transporterId?: string | null;
  transporterName?: string | null;
  transDocNo?: string | null;
  transDocDate?: string | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_RANGE_DAYS = 400;
const human = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const humanTime = (d: Date) => `${d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })} IST`;
const EXEMPT = new Set(['NIL_RATED', 'EXEMPT', 'NON_GST']);
const DOC_INCLUDE = { contact: true, lines: { orderBy: { lineNo: 'asc' as const }, include: { tax: true } }, eWayBills: { orderBy: { createdAt: 'asc' as const }, include: { vehicleUpdates: { orderBy: { updatedAt: 'asc' as const } } } } };

@Injectable()
export class EWayBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ settings

  async getSettings(orgId: string) {
    const [s, gst, einv] = await Promise.all([
      this.prisma.eWayBillSettings.findUnique({ where: { orgId } }),
      this.prisma.gstRegistration.findUnique({ where: { orgId } }),
      this.prisma.eInvoiceSettings.findUnique({ where: { orgId } }),
    ]);
    // The e-invoice seller address, offered as the dispatch address when setting up.
    const suggested = einv ? { address1: einv.address1, address2: einv.address2, city: einv.city, pincode: einv.pincode, goodsUnit: einv.goodsUnit } : null;
    if (!s) return { configured: false as const, gstRegistered: !!gst, stateCode: gst?.stateCode ?? null, suggested };
    return { configured: true as const, gstRegistered: !!gst, stateCode: gst?.stateCode ?? null, ...this.serializeSettings(s) };
  }

  async saveSettings(orgId: string, actor: { id: string }, input: { threshold: string; intraStateThreshold?: string | null; address1: string; address2?: string | null; city: string; pincode: string; goodsUnit: string }) {
    const gst = await this.prisma.gstRegistration.findUnique({ where: { orgId } });
    if (!gst) throw new DomainError('GST_NOT_REGISTERED', 'E-way bills need the GST registration first', HttpStatus.CONFLICT);
    const data = {
      threshold: new D(input.threshold).toFixed(2),
      intraStateThreshold: input.intraStateThreshold ? new D(input.intraStateThreshold).toFixed(2) : null,
      address1: input.address1.trim(),
      address2: input.address2?.trim() || null,
      city: input.city.trim(),
      pincode: input.pincode,
      goodsUnit: input.goodsUnit.toUpperCase(),
    };
    const s = await this.prisma.$transaction(async (tx) => {
      const before = await tx.eWayBillSettings.findUnique({ where: { orgId } });
      const row = before ? await tx.eWayBillSettings.update({ where: { orgId }, data }) : await tx.eWayBillSettings.create({ data: { orgId, ...data } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: before ? 'ewaybill.settings_updated' : 'ewaybill.configured', entityType: 'e_way_bill_settings', entityId: orgId, data });
      return row;
    });
    return { configured: true as const, gstRegistered: true, stateCode: gst.stateCode, ...this.serializeSettings(s) };
  }

  // ------------------------------------------------------------------ register and documents

  async register(orgId: string, from: string, to: string) {
    if (from > to) throw new DomainError('INVALID_RANGE', 'from must not be after to');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) throw new DomainError('INVALID_RANGE', `Ask for at most ${MAX_RANGE_DAYS} days at a time`);
    const ctx = await this.context(orgId);
    const docs = await this.prisma.document.findMany({
      where: { orgId, kind: 'INVOICE', status: { in: ['POSTED', 'VOID'] }, issueDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      include: DOC_INCLUDE,
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    });
    const now = new Date();
    const rows = docs.map((d) => this.row(ctx, d, now));
    const count = (...s: EWayBillState[]) => rows.filter((r) => s.includes(r.state)).length;
    return {
      from,
      to,
      today: todayIso(),
      threshold: ctx.settings.threshold.toFixed(2),
      summary: {
        needed: count('NEEDED'),
        needsData: count('NEEDS_DATA'),
        tooOld: count('TOO_OLD'),
        generated: count('GENERATED'),
        expiringSoon: rows.filter((r) => r.state === 'GENERATED' && r.eWayBill?.validUntil && !r.eWayBill.expired && Date.parse(r.eWayBill.validUntil) - now.getTime() < 12 * 3_600_000).length,
        partAOnly: rows.filter((r) => r.state === 'GENERATED' && r.eWayBill && !r.eWayBill.partB).length,
        optional: count('OPTIONAL'),
        notApplicable: count('NOT_APPLICABLE', 'UNSUPPORTED', 'CANCELLED'),
      },
      rows,
    };
  }

  async getDocument(orgId: string, documentId: string) {
    const ctx = await this.context(orgId, false);
    const d = await this.loadDoc(orgId, documentId);
    if (!ctx) return { configured: false as const, documentId };
    return { configured: true as const, ...this.row(ctx, d, new Date()), history: d.eWayBills.map((b) => this.serializeBill(b)) };
  }

  /** The portal's bulk-upload JSON for one invoice with the transport details given. */
  async payload(orgId: string, documentId: string, transport: TransportInput) {
    const ctx = await this.context(orgId);
    const d = await this.loadDoc(orgId, documentId);
    const r = this.row(ctx, d, new Date());
    if (r.state !== 'NEEDED' && r.state !== 'OPTIONAL') throw this.notReady(r);
    return ewayBillFile([this.buildWith(ctx, d, transport)]);
  }

  /** Record the e-way bill the portal generated, with the transport details it was generated with. */
  async record(orgId: string, actor: { id: string }, documentId: string, input: { number: string; generatedAt: string; validUntil?: string | null; transport: TransportInput }) {
    const ctx = await this.context(orgId);
    const d = await this.loadDoc(orgId, documentId);
    const r = this.row(ctx, d, new Date());
    if (r.state === 'GENERATED') throw new DomainError('EWAY_BILL_EXISTS', `${d.number} already has e-way bill ${r.eWayBill!.number}; cancel it first`, HttpStatus.CONFLICT);
    if (r.state !== 'NEEDED' && r.state !== 'OPTIONAL') throw this.notReady(r);
    const payload = this.buildWith(ctx, d, input.transport);
    const generated = new Date(input.generatedAt);
    if (generated.getTime() > Date.now() + 5 * 60_000) throw new DomainError('INVALID_DATE', 'The generation time cannot be in the future');
    if (new Date(generated.getTime() + 330 * 60_000).toISOString().slice(0, 10) < fromDbDate(d.issueDate)) throw new DomainError('INVALID_DATE', 'The e-way bill cannot be generated before the invoice date');
    const t = input.transport;
    if (t.mode && !input.validUntil) throw new DomainError('VALIDITY_REQUIRED', 'With Part B (the vehicle) the portal shows a "valid until" time; enter it');
    if (!t.mode && input.validUntil) throw new DomainError('INVALID_DATE', 'Without Part B the e-way bill has no validity yet');
    if (input.validUntil && Date.parse(input.validUntil) <= generated.getTime()) throw new DomainError('INVALID_DATE', 'The validity must end after the e-way bill was generated');
    const b = await this.prisma.$transaction(async (tx) => {
      const row = await tx.eWayBill.create({
        data: {
          orgId,
          documentId,
          number: input.number,
          generatedAt: generated,
          validUntil: input.validUntil ? new Date(input.validUntil) : null,
          distanceKm: t.distanceKm,
          vehicleType: t.vehicleType,
          transportMode: t.mode,
          vehicleNo: t.vehicleNo ? normaliseVehicleNo(t.vehicleNo) : null,
          transporterId: t.transporterId || null,
          transporterName: t.transporterName?.trim() || null,
          transDocNo: t.transDocNo?.trim() || null,
          transDocDate: t.transDocDate ? toDbDate(t.transDocDate) : null,
          payloadHash: sha256(JSON.stringify(payload)),
          createdById: actor.id,
        },
        include: { vehicleUpdates: true },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'ewaybill.recorded', entityType: 'document', entityId: documentId, data: { number: d.number, eWayBill: input.number, generatedAt: input.generatedAt, validUntil: input.validUntil ?? null, mode: t.mode, vehicleNo: row.vehicleNo } });
      return row;
    });
    return this.serializeBill(b);
  }

  /** Record a Part B update made on the portal: the first vehicle, or a change after a breakdown or transhipment. */
  async updateVehicle(
    orgId: string,
    actor: { id: string },
    documentId: string,
    input: { updatedAt?: string; mode: TransportMode; vehicleNo?: string | null; transDocNo?: string | null; transDocDate?: string | null; fromPlace: string; fromStateCode: string; reason: EWayBillVehicleReason; remark: string; validUntil?: string | null },
  ) {
    const d = await this.loadDoc(orgId, documentId);
    const live = d.eWayBills.find((b) => b.status === 'ACTIVE');
    if (!live) throw new DomainError('NO_EWAY_BILL', `${d.number} has no live e-way bill`, HttpStatus.CONFLICT);
    const at = input.updatedAt ?? new Date().toISOString();
    if (Date.parse(at) > Date.now() + 5 * 60_000) throw new DomainError('INVALID_DATE', 'The update time cannot be in the future');
    if (Date.parse(at) < live.generatedAt.getTime()) throw new DomainError('INVALID_DATE', 'The update cannot be before the e-way bill was generated');
    const state = this.current(live);
    if (state.validUntil && Date.parse(at) > state.validUntil.getTime()) throw new DomainError('EWAY_BILL_EXPIRED', `The e-way bill expired at ${humanTime(state.validUntil)}; Part B can no longer be updated`, HttpStatus.CONFLICT);
    if (!indiaState(input.fromStateCode)) throw new DomainError('INVALID_STATE', 'Choose the state the vehicle changes in');
    const first = !state.partB;
    if (first && input.reason !== '4') throw new DomainError('INVALID_REASON', 'This e-way bill has no vehicle yet: the reason is "First time"');
    if (!first && input.reason === '4') throw new DomainError('INVALID_REASON', 'The vehicle was already entered; choose breakdown, transhipment or others');
    if (first && !input.validUntil) throw new DomainError('VALIDITY_REQUIRED', 'The first Part B starts the validity; enter the "valid until" time the portal shows');
    if (!first && input.validUntil) throw new DomainError('INVALID_DATE', 'Validity is not recalculated on later Part B updates');
    if (input.validUntil && Date.parse(input.validUntil) <= Date.parse(at)) throw new DomainError('INVALID_DATE', 'The validity must end after the update');
    const issues = transportIssues({ mode: input.mode, distanceKm: live.distanceKm, vehicleNo: input.vehicleNo, vehicleType: live.vehicleType as 'R' | 'O', transDocNo: input.transDocNo, transDocDate: input.transDocDate }, { issueDate: fromDbDate(d.issueDate), samePin: false });
    if (issues.length) throw new DomainError('INVALID_TRANSPORT', 'The transport details are incomplete', HttpStatus.UNPROCESSABLE_ENTITY, { issues: issues.map((i) => i.message) });
    const u = await this.prisma.$transaction(async (tx) => {
      const row = await tx.eWayBillVehicleUpdate.create({
        data: {
          orgId,
          eWayBillId: live.id,
          updatedAt: new Date(at),
          transportMode: input.mode,
          vehicleNo: input.vehicleNo ? normaliseVehicleNo(input.vehicleNo) : null,
          transDocNo: input.transDocNo?.trim() || null,
          transDocDate: input.transDocDate ? toDbDate(input.transDocDate) : null,
          fromPlace: input.fromPlace.trim(),
          fromStateCode: input.fromStateCode,
          reason: input.reason,
          remark: input.remark.trim(),
          validUntil: input.validUntil ? new Date(input.validUntil) : null,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'ewaybill.vehicle_updated', entityType: 'document', entityId: documentId, data: { number: d.number, eWayBill: live.number, mode: input.mode, vehicleNo: row.vehicleNo, reason: EWB_VEHICLE_REASONS[input.reason], remark: input.remark } });
      return row;
    });
    return this.serializeBill({ ...live, vehicleUpdates: [...live.vehicleUpdates, u] });
  }

  /** Record that the e-way bill was cancelled on the portal (allowed within 24 hours of generation). */
  async cancel(orgId: string, actor: { id: string }, documentId: string, input: { cancelledAt?: string; reason: EWayBillCancelReason; remark: string }) {
    const d = await this.loadDoc(orgId, documentId);
    const live = d.eWayBills.find((b) => b.status === 'ACTIVE');
    if (!live) throw new DomainError('NO_EWAY_BILL', `${d.number} has no live e-way bill`, HttpStatus.CONFLICT);
    const at = input.cancelledAt ?? new Date().toISOString();
    if (Date.parse(at) > Date.now() + 5 * 60_000) throw new DomainError('INVALID_DATE', 'The cancellation time cannot be in the future');
    if (!ewayBillCancellable(live.generatedAt.toISOString(), at)) throw new DomainError('CANCEL_WINDOW_CLOSED', `An e-way bill can be cancelled only within 24 hours of its generation (${humanTime(live.generatedAt)})`, HttpStatus.CONFLICT);
    const b = await this.prisma.$transaction(async (tx) => {
      const row = await tx.eWayBill.update({ where: { id: live.id }, data: { status: 'CANCELLED', cancelledAt: new Date(at), cancelReason: input.reason, cancelRemark: input.remark.trim(), cancelledById: actor.id }, include: { vehicleUpdates: { orderBy: { updatedAt: 'asc' } } } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'ewaybill.cancelled', entityType: 'document', entityId: documentId, data: { number: d.number, eWayBill: live.number, reason: EWB_CANCEL_REASONS[input.reason], remark: input.remark } });
      return row;
    });
    return this.serializeBill(b);
  }

  // ------------------------------------------------------------------ internals

  private async context(orgId: string): Promise<Context>;
  private async context(orgId: string, required: false): Promise<Context | null>;
  private async context(orgId: string, required = true): Promise<Context | null> {
    const [settings, gst, org] = await Promise.all([
      this.prisma.eWayBillSettings.findUnique({ where: { orgId } }),
      this.prisma.gstRegistration.findUnique({ where: { orgId } }),
      this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, legalName: true } }),
    ]);
    if (!settings || !gst) {
      if (!required) return null;
      throw new DomainError('EWAY_BILLS_NOT_CONFIGURED', 'Set up e-way bills first', HttpStatus.CONFLICT);
    }
    return { settings, gst, orgLegalName: gst.legalName ?? org.legalName ?? org.name };
  }

  private async loadDoc(orgId: string, id: string): Promise<Doc> {
    const d = await this.prisma.document.findFirst({ where: { id, orgId }, include: DOC_INCLUDE });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  private input(ctx: Context, d: Doc, transport: EWayBillTransport): EWayBillInput {
    const addr = (d.contact.address ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return {
      number: d.number ?? '',
      issueDate: fromDbDate(d.issueDate),
      generationDate: todayIso(),
      placeOfSupply: d.placeOfSupply ?? '',
      seller: { gstin: ctx.gst.gstin, legalName: ctx.orgLegalName, address1: ctx.settings.address1, address2: ctx.settings.address2, place: ctx.settings.city, pincode: ctx.settings.pincode, stateCode: ctx.gst.stateCode },
      buyer: { gstin: d.counterpartyGstin, legalName: d.contact.name, address1: addr[0] ?? '', address2: addr.slice(1).join(', ') || null, place: d.contact.city ?? '', pincode: d.contact.pincode ?? '', stateCode: d.contact.stateCode ?? d.placeOfSupply ?? '' },
      lines: d.lines.map((l) => ({
        description: l.description ?? '',
        hsnCode: l.hsnCode,
        quantity: l.quantity.toFixed(),
        netAmount: l.netAmount.toFixed(),
        gstRate: l.taxRate.toFixed(),
        cgst: l.cgstAmount.toFixed(),
        sgst: l.sgstAmount.toFixed(),
        igst: l.igstAmount.toFixed(),
        exempt: !!l.tax?.gstCategory && EXEMPT.has(l.tax.gstCategory),
      })),
      otherCharges: d.withholdingKind === 'TCS' ? d.withholdingAmount.toFixed() : '0',
      total: d.total.toFixed(),
      goodsUnit: ctx.settings.goodsUnit,
      transport,
    };
  }

  /** Built with the user's transport details; throws with every issue when the portal would refuse it. */
  private buildWith(ctx: Context, d: Doc, t: TransportInput) {
    const built = buildEWayBill(this.input(ctx, d, { ...t, vehicleNo: t.vehicleNo || null, transDocNo: t.transDocNo || null, transporterId: t.transporterId || null }));
    if (!built.payload) throw new DomainError('EWAY_BILL_DATA_MISSING', 'The e-way bill cannot be generated with these details', HttpStatus.UNPROCESSABLE_ENTITY, { issues: built.issues.map((i) => i.message) });
    return built.payload;
  }

  private row(ctx: Context, d: Doc, now: Date) {
    const live = d.eWayBills.find((b) => b.status === 'ACTIVE') ?? null;
    const last = d.eWayBills[d.eWayBills.length - 1] ?? null;
    const issueDate = fromDbDate(d.issueDate);
    const intraState = d.placeOfSupply === ctx.gst.stateCode;
    const pre = this.input(ctx, d, { mode: null, distanceKm: 1, vehicleType: 'R' });
    const value = consignmentValue(pre.lines);
    const required = ewayBillRequired(value, ctx.settings.threshold.toFixed(), intraState, ctx.settings.intraStateThreshold?.toFixed() ?? null);
    const base = {
      documentId: d.id,
      number: d.number,
      issueDate,
      documentStatus: d.status,
      contact: { id: d.contact.id, name: d.contact.name },
      buyerGstin: d.counterpartyGstin,
      placeOfSupply: d.placeOfSupply,
      total: d.total.toFixed(2),
      consignmentValue: value,
      required,
      generateBy: generationDeadline(issueDate),
      eWayBill: live ? this.serializeBill(live, now) : last ? this.serializeBill(last, now) : null,
      issues: [] as EWayBillIssue[],
    };
    const out = (state: EWayBillState, reason: string, extra: Partial<typeof base> = {}) => ({ ...base, ...extra, state, reason });
    if (live) {
      const s = this.serializeBill(live, now);
      return out('GENERATED', !s.partB ? 'Part A only: add the vehicle (Part B) before the goods move' : s.expired ? `Expired ${humanTime(new Date(s.validUntil!))}` : `Valid until ${humanTime(new Date(s.validUntil!))}`);
    }
    if (d.status === 'VOID') return out(last ? 'CANCELLED' : 'NOT_APPLICABLE', last ? 'E-way bill cancelled and invoice voided' : 'Voided');
    if (d.placeOfSupply === '96') return out('UNSUPPORTED', 'Export: e-way bills for exports are not supported yet; generate it on the portal');
    if (!pre.lines.some((l) => l.hsnCode && !l.hsnCode.startsWith('99'))) return out('NOT_APPLICABLE', 'Services only: no goods move');
    const built = buildEWayBill(pre);
    const dataIssues = built.issues.filter((i) => !i.field.startsWith('transport.') && i.field !== 'issueDate');
    if (todayIso() > base.generateBy) return out('TOO_OLD', `Dated more than 180 days ago: the portal no longer takes it (last day ${human(base.generateBy)})`);
    if (dataIssues.length) return out(required ? 'NEEDS_DATA' : 'OPTIONAL', dataIssues.map((i) => i.message).join('; '), { issues: dataIssues });
    if (!required) return out('OPTIONAL', `Goods worth ₹${new D(value).toFixed(2)}: not over the threshold, an e-way bill is optional`);
    return out('NEEDED', last ? 'E-way bill cancelled; generate a new one before the goods move' : `Goods worth ₹${new D(value).toFixed(2)}: an e-way bill is needed before the goods move`);
  }

  private notReady(r: { state: EWayBillState; reason: string; issues: EWayBillIssue[] }) {
    const code = r.state === 'TOO_OLD' ? 'DOCUMENT_TOO_OLD' : r.state === 'NEEDS_DATA' ? 'EWAY_BILL_DATA_MISSING' : 'EWAY_BILL_NOT_APPLICABLE';
    return new DomainError(code, r.reason, HttpStatus.UNPROCESSABLE_ENTITY, r.issues.length ? { issues: r.issues.map((i) => i.message) } : undefined);
  }

  /** The current Part B and validity: the latest update, or what the bill was generated with. */
  private current(b: Bill) {
    const latest = b.vehicleUpdates[b.vehicleUpdates.length - 1];
    const firstPartBAt = b.transportMode ? b.generatedAt : (b.vehicleUpdates[0]?.updatedAt ?? null);
    const validUntil = b.validUntil ?? b.vehicleUpdates.find((u) => u.validUntil)?.validUntil ?? null;
    const partB = latest
      ? { mode: latest.transportMode, vehicleNo: latest.vehicleNo, transDocNo: latest.transDocNo, transDocDate: latest.transDocDate ? fromDbDate(latest.transDocDate) : null }
      : b.transportMode
        ? { mode: b.transportMode, vehicleNo: b.vehicleNo, transDocNo: b.transDocNo, transDocDate: b.transDocDate ? fromDbDate(b.transDocDate) : null }
        : null;
    return { partB, validUntil, firstPartBAt };
  }

  private serializeSettings(s: EWayBillSettings) {
    return { threshold: s.threshold.toFixed(2), intraStateThreshold: s.intraStateThreshold?.toFixed(2) ?? null, address1: s.address1, address2: s.address2, city: s.city, pincode: s.pincode, goodsUnit: s.goodsUnit };
  }

  private serializeBill(b: Bill, now = new Date()) {
    const c = this.current(b);
    return {
      id: b.id,
      number: b.number,
      generatedAt: b.generatedAt.toISOString(),
      validUntil: c.validUntil?.toISOString() ?? null,
      /** What Rule 138(10) gives for the distance, from the first Part B; the portal's figure above is the one that counts. */
      expectedValidUntil: c.firstPartBAt ? expectedValidUntil(c.firstPartBAt.toISOString(), b.distanceKm, b.vehicleType as 'R' | 'O') : null,
      expired: !!c.validUntil && c.validUntil.getTime() < now.getTime(),
      distanceKm: b.distanceKm,
      vehicleType: b.vehicleType,
      transporterId: b.transporterId,
      transporterName: b.transporterName,
      partB: c.partB,
      status: b.status,
      cancellableUntil: new Date(b.generatedAt.getTime() + 24 * 3_600_000).toISOString(),
      cancelledAt: b.cancelledAt?.toISOString() ?? null,
      cancelReason: b.cancelReason ? EWB_CANCEL_REASONS[b.cancelReason as EWayBillCancelReason] : null,
      cancelRemark: b.cancelRemark,
      updates: b.vehicleUpdates.map((u) => ({
        id: u.id,
        updatedAt: u.updatedAt.toISOString(),
        mode: u.transportMode,
        vehicleNo: u.vehicleNo,
        transDocNo: u.transDocNo,
        fromPlace: u.fromPlace,
        fromStateCode: u.fromStateCode,
        reason: EWB_VEHICLE_REASONS[u.reason as EWayBillVehicleReason],
        remark: u.remark,
      })),
      createdAt: b.createdAt.toISOString(),
    };
  }
}
