import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D } from '@talk2tax/accounting-engine';
import { nexusExposure, salesTaxByState, US_SALES_TAX_CHECKED_ON, US_STATES, usState, type StateSales } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { usSalesTaxRegistrations, type UsSalesTaxRegistrationDoc } from '../db/collections/us-sales-tax';

export interface RegistrationBody {
  state: string;
  registeredFrom: string;
  permitNumber?: string | null;
  taxRateId?: string | null;
  filingFrequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
}

/**
 * US sales tax (TAX-028): the states the business holds a permit in, economic nexus by state from
 * sales into each state (the customer's state on the contact), and the tax charged by state for a
 * filing period with what looks wrong. Rates are the business's own tax rates; none are suggested.
 * Nothing is filed with any state.
 */
@Injectable()
export class UsSalesTaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
  ) {}

  async requireUs(org: OrgContext) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    if (o.countryCode !== 'US') throw new DomainError('NOT_US', 'US sales tax is for organisations in the United States', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  async sales(org: OrgContext, from: string, to: string) {
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: 'POSTED', issueDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      select: {
        id: true,
        kind: true,
        number: true,
        issueDate: true,
        contactId: true,
        subtotal: true,
        taxTotal: true,
        exchangeRate: true,
        contact: { select: { name: true, regionCode: true, countryCode: true } },
      },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    });
    const local = (v: { toFixed(): string }, rate: { toFixed(): string }) => new D(v.toFixed()).times(rate.toFixed()).toDecimalPlaces(2).toFixed(2);
    return docs
      .filter((d) => !d.contact.countryCode || d.contact.countryCode === 'US')
      .map((d) => ({
        id: d.id,
        kind: d.kind as 'INVOICE' | 'CREDIT_NOTE',
        number: d.number,
        issueDate: fromDbDate(d.issueDate),
        contactId: d.contactId,
        contactName: d.contact.name,
        state: d.contact.regionCode ?? null,
        net: local(d.subtotal, d.exchangeRate),
        tax: local(d.taxTotal, d.exchangeRate),
      }));
  }

  private byState(docs: Awaited<ReturnType<UsSalesTaxService['sales']>>): StateSales[] {
    const m = new Map<string, { sales: InstanceType<typeof D>; transactions: number }>();
    for (const d of docs) {
      if (!d.state || !usState(d.state)) continue;
      const r = m.get(d.state) ?? { sales: new D(0), transactions: 0 };
      r.sales = d.kind === 'CREDIT_NOTE' ? r.sales.minus(d.net) : r.sales.plus(d.net);
      if (d.kind === 'INVOICE') r.transactions++;
      m.set(d.state, r);
    }
    return [...m.entries()].map(([state, r]) => ({ state, sales: r.sales.toFixed(2), transactions: r.transactions }));
  }

  async registrations() {
    return (await this.store.collection(usSalesTaxRegistrations).find({})).sort((a, b) => a.state.localeCompare(b.state));
  }

  private async rateOf(org: OrgContext, regs: UsSalesTaxRegistrationDoc[]) {
    const ids = regs.map((r) => r.taxRateId).filter((x): x is string => !!x);
    const rates = ids.length ? await this.prisma.taxRate.findMany({ where: { orgId: org.id, id: { in: ids } }, select: { id: true, name: true, rate: true } }) : [];
    return new Map(rates.map((r) => [r.id, { name: r.name, rate: r.rate.toFixed() }]));
  }

  async overview(org: OrgContext, q: { from?: string; to?: string }) {
    await this.requireUs(org);
    const to = q.to ?? todayIso();
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw new DomainError('INVALID_RANGE', 'The period must start on or before its end', HttpStatus.UNPROCESSABLE_ENTITY);
    const year = Number(to.slice(0, 4));
    const regs = await this.registrations();
    const rates = await this.rateOf(org, regs);
    const [period, current, previous] = await Promise.all([this.sales(org, from, to), this.sales(org, `${year}-01-01`, `${year}-12-31`), this.sales(org, `${year - 1}-01-01`, `${year - 1}-12-31`)]);
    const registrations = regs.map((r) => ({
      state: r.state,
      name: usState(r.state)?.name ?? r.state,
      registeredFrom: r.registeredFrom,
      permitNumber: r.permitNumber,
      filingFrequency: r.filingFrequency,
      taxRateId: r.taxRateId,
      taxRate: r.taxRateId ? (rates.get(r.taxRateId) ?? null) : null,
    }));
    const report = salesTaxByState({ documents: period, registrations: registrations.map((r) => ({ state: r.state, rate: r.taxRate?.rate ?? null })) });
    const customersWithoutState = await this.prisma.contact.count({ where: { orgId: org.id, isCustomer: true, isActive: true, regionCode: null } });
    return {
      from,
      to,
      currency: org.functionalCurrency,
      checkedOn: US_SALES_TAX_CHECKED_ON,
      stateList: US_STATES.map((s) => ({ code: s.code, name: s.name, salesTax: s.salesTax })),
      registrations,
      nexus: nexusExposure({ currentYear: this.byState(current), previousYear: this.byState(previous), registered: regs.map((r) => r.state) }),
      nexusYears: { current: year, previous: year - 1 },
      customersWithoutState,
      ...report,
    };
  }

  async register(org: OrgContext, user: AuthUser, body: RegistrationBody) {
    await this.requireUs(org);
    const state = body.state.toUpperCase();
    const rule = usState(state);
    if (!rule) throw new DomainError('VALIDATION_FAILED', 'Choose a US state', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!rule.salesTax) throw new DomainError('NO_STATE_SALES_TAX', `${rule.name} has no statewide sales tax`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (body.registeredFrom > todayIso()) throw new DomainError('VALIDATION_FAILED', 'The registration date cannot be in the future', HttpStatus.UNPROCESSABLE_ENTITY);
    if (body.taxRateId) {
      const r = await this.prisma.taxRate.findFirst({ where: { orgId: org.id, id: body.taxRateId }, select: { id: true } });
      if (!r) throw new DomainError('UNKNOWN_TAX_RATE', 'That tax rate is not one of this organisation’s', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const col = this.store.collection(usSalesTaxRegistrations);
    const before = await col.findOne({ state });
    const fields = {
      registeredFrom: body.registeredFrom,
      permitNumber: body.permitNumber?.trim() || null,
      taxRateId: body.taxRateId ?? null,
      filingFrequency: body.filingFrequency,
      updatedAt: new Date(),
    };
    if (before) await col.updateOne({ id: before.id }, { $set: fields });
    else await col.insertOne({ state, ...fields, createdById: user.id, createdAt: new Date() });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, {
        orgId: org.id,
        actorId: user.id,
        action: before ? 'us_sales_tax.registration_updated' : 'us_sales_tax.registered',
        entityType: 'us_sales_tax_registration',
        entityId: state,
        data: { state, registeredFrom: body.registeredFrom, filingFrequency: body.filingFrequency },
      }),
    );
    return this.overview(org, {});
  }

  async unregister(org: OrgContext, user: AuthUser, state: string) {
    await this.requireUs(org);
    const col = this.store.collection(usSalesTaxRegistrations);
    const r = await col.findOne({ state: state.toUpperCase() });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No registration for that state' });
    await col.deleteOne({ id: r.id });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'us_sales_tax.registration_removed', entityType: 'us_sales_tax_registration', entityId: r.state, data: { state: r.state } }),
    );
    return this.overview(org, {});
  }
}
