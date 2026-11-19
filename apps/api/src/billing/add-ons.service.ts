import { HttpStatus, Injectable } from '@nestjs/common';
import { ADD_ON_FEATURES, addOnProblems, AddOnFeature, AddOnOffer, BillingCurrency, PLAN_FEATURE_LABELS } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';

/**
 * Add-on module prices (SUBS-017), set by platform administrators. A module without a price is
 * not offered. Switching one off stops it being added; subscriptions that have it keep it, at
 * its price, until they remove it.
 */
@Injectable()
export class AddOnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  /** Every add-on with a price, switched on or off. */
  async offers(tx?: Tx): Promise<AddOnOffer[]> {
    const rows = await (tx ?? this.prisma).addOnPrice.findMany({});
    return rows.map((r) => ({ feature: r.feature as AddOnFeature, prices: r.prices as AddOnOffer['prices'], isActive: r.isActive }));
  }

  /** The add-ons an organisation can add, priced in its currency. */
  async forCurrency(currency: BillingCurrency) {
    const offers = await this.offers();
    return offers.filter((o) => o.isActive && o.prices[currency]).map((o) => ({ feature: o.feature, label: PLAN_FEATURE_LABELS[o.feature], monthly: o.prices[currency].monthly, annual: o.prices[currency].annual }));
  }

  /** Platform administration: every module that can be an add-on, with its price if it has one. */
  async list() {
    const offers = await this.offers();
    const counts = await this.system((tx) => Promise.all(ADD_ON_FEATURES.map((f) => tx.subscription.count({ where: { addOns: { has: f } } }))));
    return ADD_ON_FEATURES.map((f, i) => {
      const o = offers.find((x) => x.feature === f);
      return { feature: f, label: PLAN_FEATURE_LABELS[f], prices: o?.prices ?? null, isActive: o?.isActive ?? false, subscriptions: counts[i] };
    });
  }

  async save(actor: AuthUser, feature: string, input: { prices: AddOnOffer['prices']; isActive: boolean }) {
    const problems = addOnProblems({ feature: feature as AddOnFeature, prices: input.prices });
    if (problems.length) throw new DomainError('ADD_ON_INVALID', problems.join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { problems });
    const prices = Object.fromEntries(Object.entries(input.prices).map(([c, p]) => [c, { monthly: p.monthly, annual: p.annual }]));
    await this.system(async (tx) => {
      const before = await tx.addOnPrice.findUnique({ where: { feature } });
      if (before) await tx.addOnPrice.update({ where: { feature }, data: { prices, isActive: input.isActive, updatedBy: actor.id } });
      else await tx.addOnPrice.create({ data: { feature, prices, isActive: input.isActive, updatedBy: actor.id } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.add_on_saved', entityType: 'add_on', entityId: feature, data: { feature, prices, isActive: input.isActive, before: before ? { prices: before.prices, isActive: before.isActive } : null } });
    });
    return this.list();
  }
}
