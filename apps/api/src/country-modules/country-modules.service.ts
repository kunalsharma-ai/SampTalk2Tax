import { HttpStatus, Injectable } from '@nestjs/common';
import { COUNTRY_MODULES, countryModule, dec, plannedStarterRates, type CountryModule } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/** Where starter rates post: the chart's tax control accounts. */
const OUTPUT_TAX = '2300';
const INPUT_TAX = '1450';

/**
 * Country modules: what Talk2Tax does for an organisation's country (engine countries.ts), and
 * setting up a starter country's standard sales-tax rates as ordinary tax rates.
 */
@Injectable()
export class CountryModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return COUNTRY_MODULES.map((m) => ({ code: m.code, name: m.name, currency: m.currency, fiscalYearStartMonth: m.fiscalYearStartMonth, level: m.level, salesTaxName: m.salesTaxName, summary: m.summary }));
  }

  one(code: string): CountryModule {
    return countryModule(code.toUpperCase());
  }

  async forOrg(orgId: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true } });
    const module = countryModule(org.countryCode);
    const rates = await this.prisma.taxRate.findMany({ where: { orgId }, select: { id: true, name: true, rate: true, isActive: true } });
    const byName = new Map(rates.map((r) => [r.name.trim().toLowerCase(), r]));
    const accounts = await this.taxAccounts(orgId);
    return {
      countryCode: org.countryCode,
      module,
      starterRates: module.starterRates.map((s) => {
        const have = byName.get(s.name.toLowerCase());
        // A rate with the same name but another percentage is the organisation's own; it is not overwritten.
        return { ...s, existing: have ? { id: have.id, rate: have.rate.toFixed(), isActive: have.isActive, sameRate: dec(have.rate.toFixed()).eq(dec(s.rate)) } : null };
      }),
      taxAccounts: { sales: accounts.sales ? { code: OUTPUT_TAX, name: accounts.sales.name } : null, purchases: accounts.purchases ? { code: INPUT_TAX, name: accounts.purchases.name } : null },
    };
  }

  /** Creates the chosen (default: all) starter rates that do not exist yet, in one transaction. */
  async addStarterRates(orgId: string, actor: { id: string }, chosen?: string[]) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true } });
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.taxRate.findMany({ where: { orgId }, select: { name: true } });
      const plan = plannedStarterRates(org.countryCode, existing.map((r) => r.name), chosen);
      if (plan.refused) throw new DomainError('NO_STARTER_RATES', plan.refused, HttpStatus.CONFLICT);
      const accounts = await this.taxAccounts(orgId, tx);
      if (plan.add.some((r) => dec(r.rate).gt(0)) && (!accounts.sales || !accounts.purchases)) {
        throw new DomainError('TAX_ACCOUNT_REQUIRED', `Starter rates post to ${OUTPUT_TAX} Output Tax Payable and ${INPUT_TAX} Input Tax Receivable. Add those accounts (active and postable) to the chart of accounts, or create the rates yourself under Tax rates.`, HttpStatus.CONFLICT);
      }
      const created = [];
      for (const r of plan.add) {
        const zero = dec(r.rate).isZero();
        const t = await tx.taxRate.create({
          data: { orgId, name: r.name, rate: dec(r.rate).toFixed(), kind: 'SIMPLE', salesAccountId: zero ? null : accounts.sales!.id, purchaseAccountId: zero ? null : accounts.purchases!.id },
        });
        await this.audit.append(tx, { orgId, actorId: actor.id, action: 'tax_rate.created', entityType: 'tax_rate', entityId: t.id, data: { name: t.name, rate: t.rate.toFixed(), kind: 'SIMPLE', source: 'COUNTRY_MODULE' } });
        created.push({ id: t.id, name: t.name, rate: t.rate.toFixed() });
      }
      const m = countryModule(org.countryCode);
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'country_module.starter_rates_added', entityType: 'organization', entityId: orgId, data: { countryCode: org.countryCode, reviewedOn: m.reviewedOn, created: created.map((c) => c.name), skipped: plan.skipped } });
      return { created, skipped: plan.skipped };
    });
  }

  private async taxAccounts(orgId: string, tx: Pick<PrismaService, 'account'> = this.prisma) {
    const rows = await tx.account.findMany({ where: { orgId, code: { in: [OUTPUT_TAX, INPUT_TAX] }, isActive: true, isPostable: true }, select: { id: true, code: true, name: true } });
    return { sales: rows.find((r) => r.code === OUTPUT_TAX), purchases: rows.find((r) => r.code === INPUT_TAX) };
  }
}
