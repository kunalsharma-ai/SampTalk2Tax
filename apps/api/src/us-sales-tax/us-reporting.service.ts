import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D } from '@talk2tax/accounting-engine';
import {
  information1099Csv,
  information1099Returns,
  stateSalesTaxReturns,
  US_REPORTING_CHECKED_ON,
  usState,
  type Form1099Kind,
  type VendorTaxProfile,
  type W9Classification,
} from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { usVendorTaxProfiles } from '../db/collections/us-sales-tax';
import { UsSalesTaxService } from './us-sales-tax.service';

export interface VendorProfileBody {
  classification: W9Classification;
  tinType: 'SSN' | 'EIN';
  tinLast4?: string | null;
  w9ReceivedOn?: string | null;
  formKind: Form1099Kind;
  isAttorney?: boolean;
}

/**
 * US federal and state tax reporting (TAX-029): the 1099-NEC and 1099-MISC returns due for a
 * calendar year's vendor payments, and the sales tax returns each state permit calls for in the
 * year with the tax charged in each period. Nothing is filed with the IRS or any state.
 */
@Injectable()
export class UsReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
    private readonly salesTax: UsSalesTaxService,
  ) {}

  private async profiles() {
    return this.store.collection(usVendorTaxProfiles).find({});
  }

  /**
   * Vendor payments in the calendar year, in US dollars. They are always from a bank or cash
   * account: spending on company cards is not a vendor payment here, and the card company reports
   * it on Form 1099-K, so it never reaches these totals.
   */
  private async payments(org: OrgContext, year: number) {
    const rows = await this.prisma.payment.findMany({
      where: { orgId: org.id, kind: 'PAYMENT', status: 'POSTED', date: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } },
      select: { contactId: true, date: true, amount: true, exchangeRate: true },
    });
    return rows.map((r) => ({
      contactId: r.contactId,
      date: fromDbDate(r.date),
      amount: new D(r.amount.toFixed()).times(r.exchangeRate.toFixed()).toDecimalPlaces(2).toFixed(2),
      byCard: false,
    }));
  }

  async overview(org: OrgContext, q: { year?: number }) {
    await this.salesTax.requireUs(org);
    const today = todayIso();
    const year = q.year ?? Number(today.slice(0, 4));
    const [payments, profiles, regs, docs] = await Promise.all([this.payments(org, year), this.profiles(), this.salesTax.registrations(), this.salesTax.sales(org, `${year}-01-01`, `${year}-12-31`)]);
    const vendorRows = await this.prisma.contact.findMany({
      where: { orgId: org.id, OR: [{ isVendor: true, isActive: true }, { id: { in: [...new Set(payments.map((p) => p.contactId))] } }] },
      select: { id: true, name: true, countryCode: true },
      orderBy: { name: 'asc' },
    });
    const byId = new Map(profiles.map((p) => [p.contactId, p]));
    const engineProfiles: VendorTaxProfile[] = profiles.map((p) => ({
      contactId: p.contactId,
      classification: p.classification,
      tinType: p.tinType,
      tinLast4: p.tinLast4,
      w9ReceivedOn: p.w9ReceivedOn,
      formKind: p.formKind,
      isAttorney: p.isAttorney,
    }));
    const federal = information1099Returns({ year, vendors: vendorRows.map((v) => ({ contactId: v.id, name: v.name, countryCode: v.countryCode ?? null })), payments, profiles: engineProfiles });
    const periods = stateSalesTaxReturns({ year, today, registrations: regs, documents: docs });
    return {
      year,
      today,
      currency: org.functionalCurrency,
      checkedOn: US_REPORTING_CHECKED_ON,
      federal,
      vendors: vendorRows.map((v) => {
        const p = byId.get(v.id);
        return {
          contactId: v.id,
          name: v.name,
          profile: p ? { classification: p.classification, tinType: p.tinType, tinLast4: p.tinLast4, w9ReceivedOn: p.w9ReceivedOn, formKind: p.formKind, isAttorney: p.isAttorney } : null,
        };
      }),
      state: {
        registrations: regs.map((r) => ({ state: r.state, name: usState(r.state)?.name ?? r.state, filingFrequency: r.filingFrequency, registeredFrom: r.registeredFrom })),
        periods: periods.map((p) => ({ ...p, stateName: usState(p.state)?.name ?? p.state })),
        taxTotal: periods.reduce((s, p) => s.plus(p.tax), new D(0)).toFixed(2),
      },
    };
  }

  async exportCsv(org: OrgContext, user: AuthUser, q: { year?: number }) {
    const r = await this.overview(org, q);
    const csv = information1099Csv(r.federal);
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: org.id,
        actorId: user.id,
        action: 'us_1099_report.exported',
        entityType: 'report',
        entityId: `us-1099:${r.year}`,
        data: { year: r.year, vendors: r.federal.rows.length, nec: r.federal.summary.nec, misc: r.federal.summary.misc },
      }),
    );
    return { fileName: `us-1099-${r.year}.csv`, csv };
  }

  async saveProfile(org: OrgContext, user: AuthUser, contactId: string, body: VendorProfileBody) {
    await this.salesTax.requireUs(org);
    const contact = await this.prisma.contact.findFirst({ where: { orgId: org.id, id: contactId }, select: { id: true, isVendor: true } });
    if (!contact) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Vendor not found' });
    if (!contact.isVendor) throw new DomainError('NOT_A_VENDOR', 'W-9 details are kept for vendors', HttpStatus.UNPROCESSABLE_ENTITY);
    if (body.w9ReceivedOn && body.w9ReceivedOn > todayIso()) throw new DomainError('VALIDATION_FAILED', 'The W-9 date cannot be in the future', HttpStatus.UNPROCESSABLE_ENTITY);
    if (body.isAttorney && body.formKind !== 'NEC' && body.formKind !== 'MISC_OTHER')
      throw new DomainError('VALIDATION_FAILED', 'Legal services are reported on a 1099-NEC', HttpStatus.UNPROCESSABLE_ENTITY);
    const col = this.store.collection(usVendorTaxProfiles);
    const before = await col.findOne({ contactId });
    const fields = {
      classification: body.classification,
      tinType: body.tinType,
      tinLast4: body.tinLast4 || null,
      w9ReceivedOn: body.w9ReceivedOn || null,
      formKind: body.formKind,
      isAttorney: body.isAttorney ?? false,
      updatedAt: new Date(),
    };
    if (before) await col.updateOne({ id: before.id }, { $set: fields });
    else await col.insertOne({ contactId, ...fields, createdById: user.id, createdAt: new Date() });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: org.id,
        actorId: user.id,
        action: before ? 'us_vendor_tax_profile.updated' : 'us_vendor_tax_profile.created',
        entityType: 'contact',
        entityId: contactId,
        // The last four digits are not written to the audit trail either.
        data: { classification: fields.classification, tinType: fields.tinType, formKind: fields.formKind, isAttorney: fields.isAttorney, w9ReceivedOn: fields.w9ReceivedOn },
      }),
    );
    return this.overview(org, {});
  }

  async removeProfile(org: OrgContext, user: AuthUser, contactId: string) {
    await this.salesTax.requireUs(org);
    const col = this.store.collection(usVendorTaxProfiles);
    const p = await col.findOne({ contactId });
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No W-9 details for that vendor' });
    await col.deleteOne({ id: p.id });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'us_vendor_tax_profile.removed', entityType: 'contact', entityId: contactId, data: {} }));
    return this.overview(org, {});
  }
}
