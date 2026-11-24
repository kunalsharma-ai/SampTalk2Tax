import { HttpStatus, Injectable } from '@nestjs/common';
import { D } from '@talk2tax/accounting-engine';
import { crossBorderCsv, crossBorderReport, type CrossBorderKind } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

const KINDS: CrossBorderKind[] = ['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT'];

/**
 * Cross-border tax reporting (TAX-038): posted sales and purchases with contacts in other
 * countries, by country, with the EU recapitulative statement and the checks in packages/tax-engine
 * cross-border.ts. Countries come from contacts; documents in another currency or (India) with place
 * of supply 96 whose contact has no country are listed so the country can be added. Read-only.
 */
@Injectable()
export class CrossBorderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private period(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso();
    let from = q.from;
    if (!from) {
      // The financial year to date.
      const y = Number(to.slice(0, 4));
      const m = Number(to.slice(5, 7));
      const start = m >= org.fiscalYearStartMonth ? y : y - 1;
      from = `${start}-${String(org.fiscalYearStartMonth).padStart(2, '0')}-01`;
    }
    if (from > to) throw new DomainError('INVALID_RANGE', 'The period must start on or before its end', HttpStatus.UNPROCESSABLE_ENTITY);
    return { from, to };
  }

  async report(org: OrgContext, q: { from?: string; to?: string }) {
    const { from, to } = this.period(org, q);
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: { in: KINDS }, status: 'POSTED', issueDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      select: {
        id: true,
        kind: true,
        number: true,
        issueDate: true,
        contactId: true,
        currency: true,
        exchangeRate: true,
        subtotal: true,
        taxTotal: true,
        reverseCharge: true,
        placeOfSupply: true,
        contact: { select: { name: true, countryCode: true, taxId: true } },
      },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    });
    const local = (v: { toFixed(): string }, rate: { toFixed(): string }) => new D(v.toFixed()).times(rate.toFixed()).toDecimalPlaces(2).toFixed(2);
    const r = crossBorderReport({
      orgCountry: o.countryCode,
      functionalCurrency: org.functionalCurrency,
      documents: docs.map((d) => ({
        id: d.id,
        kind: d.kind as CrossBorderKind,
        number: d.number,
        issueDate: fromDbDate(d.issueDate),
        contactId: d.contactId,
        contactName: d.contact.name,
        contactCountry: d.contact.countryCode ?? null,
        contactTaxId: d.contact.taxId ?? null,
        currency: d.currency,
        netLocal: local(d.subtotal, d.exchangeRate),
        taxLocal: local(d.taxTotal, d.exchangeRate),
        reverseCharge: d.reverseCharge,
        placeOfSupply: d.placeOfSupply,
      })),
    });
    const contactsWithoutCountry = await this.prisma.contact.count({ where: { orgId: org.id, isActive: true, countryCode: null } });
    return { from, to, currency: org.functionalCurrency, documents: docs.length, contactsWithoutCountry, ...r };
  }

  async exportCsv(org: OrgContext, user: AuthUser, q: { from?: string; to?: string }) {
    const r = await this.report(org, q);
    const csv = crossBorderCsv(r, r.currency);
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: org.id,
        actorId: user.id,
        action: 'cross_border_report.exported',
        entityType: 'report',
        entityId: `cross-border:${r.from}:${r.to}`,
        data: { from: r.from, to: r.to, countries: r.byCountry.length, documents: r.considered },
      }),
    );
    return { fileName: `cross-border-${r.from}-to-${r.to}.csv`, csv };
  }
}
