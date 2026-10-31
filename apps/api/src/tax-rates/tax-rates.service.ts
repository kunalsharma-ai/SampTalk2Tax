import { Injectable, NotFoundException } from '@nestjs/common';
import { dec } from '@talk2tax/accounting-engine';
import { TaxRate } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';

/**
 * Tenant-configured percentage tax rates. These are a calculation aid only: they do
 * not implement any jurisdiction's tax rules (place of supply, reverse charge,
 * thresholds, filings). See KNOWN_LIMITATIONS.md.
 */
@Injectable()
export class TaxRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, includeInactive: boolean) {
    const rows = await this.prisma.taxRate.findMany({ where: { orgId, ...(includeInactive ? {} : { isActive: true }) }, orderBy: [{ rate: 'asc' }, { name: 'asc' }] });
    return rows.map(serialize);
  }

  async create(orgId: string, actor: { id: string }, input: { name: string; rate: string; salesAccountId?: string | null; purchaseAccountId?: string | null }) {
    const rate = dec(input.rate);
    if (rate.gt(100)) throw new DomainError('INVALID_RATE', 'A tax rate cannot exceed 100%');
    return this.prisma.$transaction(async (tx) => {
      await this.checkAccounts(tx, orgId, input, rate.gt(0));
      const t = await tx.taxRate.create({ data: { orgId, name: input.name, rate: rate.toFixed(), salesAccountId: input.salesAccountId ?? null, purchaseAccountId: input.purchaseAccountId ?? null } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'tax_rate.created', entityType: 'tax_rate', entityId: t.id, data: { name: t.name, rate: t.rate.toFixed() } });
      return serialize(t);
    });
  }

  async update(orgId: string, actor: { id: string }, id: string, input: { name?: string; isActive?: boolean; salesAccountId?: string | null; purchaseAccountId?: string | null }) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.taxRate.findFirst({ where: { id, orgId } });
      if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Tax rate not found' });
      await this.checkAccounts(tx, orgId, input, false);
      const t = await tx.taxRate.update({ where: { id }, data: input });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'tax_rate.updated', entityType: 'tax_rate', entityId: id, data: input });
      return serialize(t);
    });
  }

  private async checkAccounts(tx: Tx, orgId: string, input: { salesAccountId?: string | null; purchaseAccountId?: string | null }, requireOne: boolean) {
    const ids = [input.salesAccountId, input.purchaseAccountId].filter((x): x is string => !!x);
    if (requireOne && ids.length === 0) throw new DomainError('TAX_ACCOUNT_REQUIRED', 'Choose the account for tax on sales, on purchases, or both');
    if (!ids.length) return;
    const found = await tx.account.findMany({ where: { orgId, id: { in: ids }, isPostable: true, isActive: true } });
    if (found.length !== new Set(ids).size) throw new DomainError('INVALID_ACCOUNT', 'Tax accounts must be active, postable accounts of this organisation');
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });
    if (ids.some((x) => x === org.arAccountId || x === org.apAccountId || x === org.claimsAccountId)) throw new DomainError('INVALID_ACCOUNT', 'A control account cannot hold tax');
  }
}

function serialize(t: TaxRate) {
  return { id: t.id, name: t.name, rate: t.rate.toFixed(), salesAccountId: t.salesAccountId, purchaseAccountId: t.purchaseAccountId, isActive: t.isActive };
}
