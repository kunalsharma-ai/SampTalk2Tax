import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { checkGstin, supplierTaxIssues, type RegistrationStatus, type SupplierFacts, type SupplierIssue, type TaxpayerType } from '@talk2tax/tax-engine';
import { Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { todayIst } from '../tasks/tasks.service';

type Actor = { id: string };
interface TaxOrg {
  id: string;
}
export interface CheckInput {
  status: RegistrationStatus;
  taxpayerType?: TaxpayerType | null;
  legalName?: string | null;
  effectiveDate?: string | null;
  checkedOn: string;
  note?: string | null;
}
const ymd = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Supplier tax validation (AP-019): each active vendor's GSTIN and PAN checked against each other,
 * against other vendors and against the GST on their bills of the last twelve months, plus what
 * people recorded when they looked the GSTIN up on the GST portal.
 */
@Injectable()
export class SupplierTaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Facts for the active vendors (or one), as the engine checks them. */
  private async facts(orgId: string, today: string, onlyId?: string) {
    const vendors = await this.prisma.contact.findMany({ where: { orgId, isVendor: true, isActive: true }, select: { id: true, name: true, gstin: true, stateCode: true, pan: true, withholdingSectionId: true }, orderBy: { name: 'asc' } });
    if (onlyId && !vendors.some((v) => v.id === onlyId)) return null;
    const sections = new Map((await this.prisma.withholdingSection.findMany({ where: { orgId }, select: { id: true, code: true } })).map((s) => [s.id, s.code]));
    const from = ymd(today, -365);
    const ids = onlyId ? [onlyId] : vendors.map((v) => v.id);
    const bills = ids.length
      ? (
          await this.prisma.document.findMany({
            where: { orgId, kind: 'BILL', status: 'POSTED', issueDate: { gte: toDbDate(from) }, contactId: { in: ids } },
            orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
            select: { id: true, contactId: true, number: true, issueDate: true, counterpartyGstin: true, supplierState: true, placeOfSupply: true, reverseCharge: true, lines: { select: { cgstAmount: true, sgstAmount: true, igstAmount: true } } },
          })
        ).map((d) => {
          // As PostgreSQL printed SUM of numeric(24,6): six places, or 0 for a bill with no lines.
          const total = (k: 'cgstAmount' | 'sgstAmount' | 'igstAmount') => (d.lines.length ? d.lines.reduce((t, l) => t.plus(l[k]), new Prisma.Decimal(0)).toFixed(6) : '0');
          return { id: d.id, contact_id: d.contactId, number: d.number ?? '', issue_date: d.issueDate, counterparty_gstin: d.counterpartyGstin, supplier_state: d.supplierState, place_of_supply: d.placeOfSupply, reverse_charge: d.reverseCharge, cgst: total('cgstAmount'), sgst: total('sgstAmount'), igst: total('igstAmount') };
        })
      : [];
    const checks = await this.prisma.supplierGstinCheck.findMany({ where: { orgId, contactId: { in: ids } }, orderBy: [{ checkedOn: 'desc' }, { createdAt: 'desc' }] });
    const byGstin = new Map<string, string[]>();
    const byPan = new Map<string, string[]>();
    for (const v of vendors) {
      if (v.gstin) byGstin.set(v.gstin, [...(byGstin.get(v.gstin) ?? []), v.name]);
      if (v.pan) byPan.set(v.pan, [...(byPan.get(v.pan) ?? []), v.name]);
    }
    const pick = onlyId ? vendors.filter((v) => v.id === onlyId) : vendors;
    return pick.map((v) => {
      // The latest check of the vendor's current GSTIN; checks of an earlier GSTIN do not count.
      const c = checks.find((x) => x.contactId === v.id && x.gstin === v.gstin);
      const facts: SupplierFacts = {
        name: v.name,
        gstin: v.gstin,
        stateCode: v.stateCode,
        pan: v.pan,
        tdsSection: v.withholdingSectionId ? (sections.get(v.withholdingSectionId) ?? null) : null,
        sameGstin: v.gstin ? (byGstin.get(v.gstin) ?? []).filter((n) => n !== v.name) : [],
        samePan: v.pan ? (byPan.get(v.pan) ?? []).filter((n) => n !== v.name) : [],
        verification: c ? { status: c.status as RegistrationStatus, taxpayerType: c.taxpayerType as TaxpayerType | null, checkedOn: fromDbDate(c.checkedOn), legalName: c.legalName, effectiveDate: c.effectiveDate ? fromDbDate(c.effectiveDate) : null } : null,
        bills: bills.filter((b) => b.contact_id === v.id).map((b) => ({ number: b.number, date: fromDbDate(b.issue_date), gstin: b.counterparty_gstin, supplierState: b.supplier_state, placeOfSupply: b.place_of_supply, reverseCharge: b.reverse_charge, cgst: b.cgst, sgst: b.sgst, igst: b.igst })),
      };
      const billIds = new Map(bills.filter((b) => b.contact_id === v.id).map((b) => [b.number, b.id]));
      return { vendor: v, facts, billIds, checks: checks.filter((x) => x.contactId === v.id) };
    });
  }

  private issuesWithLinks(issues: SupplierIssue[], billIds: Map<string, string>) {
    return issues.map((i) => ({ ...i, bills: i.bills?.map((number) => ({ number, id: billIds.get(number) ?? null })) }));
  }

  /** Every active vendor with what was found, worst first. */
  async report(org: TaxOrg) {
    const today = todayIst();
    const rows = (await this.facts(org.id, today))!;
    const vendors = rows.map(({ vendor, facts, billIds }) => {
      const issues = supplierTaxIssues(facts, today);
      return {
        id: vendor.id,
        name: vendor.name,
        gstin: vendor.gstin,
        pan: vendor.pan,
        verification: facts.verification,
        billCount: facts.bills.length,
        high: issues.filter((i) => i.severity === 'HIGH').length,
        medium: issues.filter((i) => i.severity === 'MEDIUM').length,
        low: issues.filter((i) => i.severity === 'LOW').length,
        issues: this.issuesWithLinks(issues, billIds),
      };
    });
    vendors.sort((a, b) => b.high - a.high || b.medium - a.medium || b.low - a.low || a.name.localeCompare(b.name));
    return {
      asOf: today,
      billsFrom: ymd(today, -365),
      totals: {
        vendors: vendors.length,
        withHigh: vendors.filter((v) => v.high).length,
        withIssues: vendors.filter((v) => v.issues.length).length,
        clean: vendors.filter((v) => !v.issues.length).length,
        verified: vendors.filter((v) => v.verification).length,
        registered: vendors.filter((v) => v.gstin).length,
      },
      vendors,
    };
  }

  /** One vendor: what was found and every portal check recorded. */
  async forVendor(org: TaxOrg, contactId: string) {
    const today = todayIst();
    const rows = await this.facts(org.id, today, contactId);
    if (!rows?.length) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Active vendor not found' });
    const { vendor, facts, billIds, checks } = rows[0]!;
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(checks.map((c) => c.recordedById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return {
      vendor: { id: vendor.id, name: vendor.name, gstin: vendor.gstin, pan: vendor.pan, stateCode: vendor.stateCode, tdsSection: facts.tdsSection },
      billsFrom: ymd(today, -365),
      billCount: facts.bills.length,
      verification: facts.verification,
      issues: this.issuesWithLinks(supplierTaxIssues(facts, today), billIds),
      checks: checks.map((c) => ({
        id: c.id,
        gstin: c.gstin,
        current: c.gstin === vendor.gstin,
        status: c.status,
        taxpayerType: c.taxpayerType,
        legalName: c.legalName,
        effectiveDate: c.effectiveDate ? fromDbDate(c.effectiveDate) : null,
        checkedOn: fromDbDate(c.checkedOn),
        note: c.note,
        recordedBy: users.get(c.recordedById) ?? 'Former member',
        recordedAt: c.createdAt.toISOString(),
      })),
    };
  }

  /** Record what the GST portal showed for the vendor's current GSTIN. */
  async recordCheck(org: TaxOrg, actor: Actor, contactId: string, input: CheckInput) {
    const invalid = (m: string) => new DomainError('CHECK_INVALID', m, HttpStatus.UNPROCESSABLE_ENTITY);
    const today = todayIst();
    if (input.checkedOn > today) throw invalid('The check date cannot be in the future');
    if (input.effectiveDate && !['CANCELLED', 'SUSPENDED'].includes(input.status)) throw invalid('A date from which it applies is only for a cancelled or suspended registration');
    if (input.status === 'NOT_FOUND' && input.taxpayerType) throw invalid('A GSTIN the portal does not find has no taxpayer type');
    await this.prisma.$transaction(async (tx) => {
      const v = await tx.contact.findFirst({ where: { id: contactId, orgId: org.id, isVendor: true }, select: { id: true, gstin: true, name: true } });
      if (!v) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Vendor not found' });
      if (!v.gstin || !checkGstin(v.gstin).valid) throw invalid(`${v.name} has no valid GSTIN to check; add it to the vendor first`);
      const c = await tx.supplierGstinCheck.create({
        data: {
          orgId: org.id,
          contactId,
          gstin: v.gstin,
          status: input.status,
          taxpayerType: input.taxpayerType ?? null,
          legalName: input.legalName?.trim() || null,
          effectiveDate: input.effectiveDate ? toDbDate(input.effectiveDate) : null,
          checkedOn: toDbDate(input.checkedOn),
          note: input.note?.trim() || null,
          recordedById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'supplier_tax.gstin_checked', entityType: 'contact', entityId: contactId, data: { checkId: c.id, gstin: v.gstin, status: input.status, taxpayerType: input.taxpayerType ?? null, checkedOn: input.checkedOn, effectiveDate: input.effectiveDate ?? null } });
    });
    return this.forVendor(org, contactId);
  }
}
