import { DocumentStoreService } from '../common/document-store.service';
import { runInOrg } from '../common/tenant-context';
import { invitations, memberships } from '../db/collections/tenancy';
import { HttpStatus, Injectable } from '@nestjs/common';
import { addOnLines, BillingCurrency, BillingInterval, chooseAddOns, effectiveFeatures, isDowngrade, PlanError, priceWithAddOns, PLAN_FEATURE_LABELS, PlanDefinition, PlanFeature, PlanLimits, priceFor } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { accessOf } from './limits';
import { couponSummary, CouponsService } from './payments/coupons.service';
import { AddOnsService } from './add-ons.service';

type PlanRow = { id: string; code: string; name: string; description: string; prices: unknown; limits: unknown; features: string[]; isActive: boolean; sortOrder: number };

export function serializePlan(p: PlanRow, currency?: BillingCurrency) {
  const prices = p.prices as PlanDefinition['prices'];
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    prices,
    ...(currency ? { price: { currency, monthly: priceFor({ prices }, currency, 'MONTHLY').toFixed(2), annual: priceFor({ prices }, currency, 'ANNUAL').toFixed(2) } } : {}),
    limits: p.limits as PlanLimits,
    features: p.features as PlanFeature[],
    isActive: p.isActive,
    sortOrder: p.sortOrder,
  };
}

/**
 * An organisation's own view of its Talk2Tax subscription: plan, status, what it allows, usage
 * against the limits, the plans it can move to, and a request to change plan. Activation of a
 * requested plan is done when payment is received (by a platform administrator in this release;
 * by online checkout in the next).
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly coupons: CouponsService,
    private readonly addOns: AddOnsService,
  ) {}

  async forOrg(orgId: string, now = new Date()) {
    const s = await this.prisma.subscription.findUnique({ where: { orgId }, include: { plan: true, requestedPlan: true, coupon: true } });
    if (!s) throw new DomainError('NO_SUBSCRIPTION', 'This organisation has no subscription', HttpStatus.NOT_FOUND);
    const currency = s.currency as BillingCurrency;
    const [members, openInvitations, plans, history, promotions, addOnOffers] = await Promise.all([
      runInOrg(orgId, () => this.store.collection(memberships).count({})),
      runInOrg(orgId, () => this.store.collection(invitations).count({ openFor: { $exists: true }, expiresAt: { $gt: now } })),
      this.prisma.plan.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
      this.prisma.subscriptionEvent.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 30 }),
      this.coupons.promotions(currency, now),
      this.addOns.forCurrency(currency),
    ]);
    return {
      plan: serializePlan(s.plan, currency),
      status: s.status,
      access: accessOf(s, now),
      billingInterval: s.billingInterval,
      currency,
      price: s.price?.toFixed(2) ?? null,
      // Add-on modules paid for (SUBS-017), and every module the organisation can use with them.
      addOns: s.addOns ?? [],
      features: effectiveFeatures(s.plan.features, s.addOns),
      trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
      currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      // The coupon taking money off payments (SUBS-024), and how many payments it has left.
      coupon: s.coupon ? { ...couponSummary(s.coupon), paymentsUsed: s.couponUses, paymentsLeft: s.coupon.cycles === null ? null : Math.max(s.coupon.cycles - s.couponUses, 0) } : null,
      request: s.requestedPlan ? { plan: serializePlan(s.requestedPlan, currency), interval: s.requestedInterval, addOns: s.requestedAddOns ?? [], at: s.requestedAt!.toISOString() } : null,
      usage: { members, openInvitations },
      plans: plans.map((p) => serializePlan(p, currency)),
      // Promotions on offer (SUBS-025): taken off at checkout without a code.
      promotions,
      addOnOffers,
      featureLabels: PLAN_FEATURE_LABELS,
      history: history.map((h) => ({ kind: h.kind, at: h.createdAt.toISOString(), data: h.data })),
    };
  }

  /** Asks for a plan. It takes effect when payment is received; until then nothing changes. */
  async request(orgId: string, actorId: string, planCode: string, interval: BillingInterval, addOns: string[] = []) {
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.subscription.findUniqueOrThrow({ where: { orgId }, include: { plan: true } });
      const plan = await tx.plan.findUnique({ where: { code: planCode } });
      if (!plan || !plan.isActive) throw new DomainError('PLAN_NOT_FOUND', 'That plan is not offered', HttpStatus.UNPROCESSABLE_ENTITY);
      const offers = await this.addOns.offers(tx);
      let chosen: ReturnType<typeof chooseAddOns>;
      try {
        chosen = chooseAddOns(plan.features, addOns, offers);
      } catch (e) {
        if (e instanceof PlanError) throw new DomainError('ADD_ON_INVALID', e.message, HttpStatus.UNPROCESSABLE_ENTITY);
        throw e;
      }
      const unchanged = [...(s.addOns ?? [])].sort().join() === [...chosen].sort().join();
      if (s.status === 'ACTIVE' && s.planId === plan.id && s.billingInterval === interval && unchanged) throw new DomainError('PLAN_UNCHANGED', `You are already on ${plan.name}, billed ${interval.toLowerCase()}`, HttpStatus.CONFLICT);
      const currency = s.currency as BillingCurrency;
      const price = priceWithAddOns(priceFor(serializePlan(plan), currency, interval), addOnLines(chosen, offers, currency, interval));
      await this.memberFit(tx, orgId, plan);
      await tx.subscription.update({ where: { orgId }, data: { requestedPlanId: plan.id, requestedInterval: interval, requestedAddOns: chosen, requestedAt: new Date(), requestedBy: actorId } });
      const downgrade = s.status === 'ACTIVE' && s.price ? isDowngrade(s.price.toFixed(2), price) : false;
      await this.event(tx, orgId, actorId, 'PLAN_REQUESTED', { plan: plan.code, interval, ...(chosen.length ? { addOns: chosen } : {}), currency, price: price.toFixed(2), downgrade });
      await this.audit.append(tx, { orgId, actorId, action: 'subscription.plan_requested', entityType: 'subscription', entityId: orgId, data: { plan: plan.code, interval } });
    });
    return this.forOrg(orgId);
  }

  async withdrawRequest(orgId: string, actorId: string) {
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.subscription.findUniqueOrThrow({ where: { orgId }, include: { requestedPlan: true } });
      if (!s.requestedPlan) throw new DomainError('NO_REQUEST', 'There is no plan request to withdraw', HttpStatus.CONFLICT);
      await tx.subscription.update({ where: { orgId }, data: { requestedPlanId: null, requestedInterval: null, requestedAt: null, requestedBy: null, requestedAddOns: [] } });
      await this.event(tx, orgId, actorId, 'REQUEST_WITHDRAWN', { plan: s.requestedPlan.code });
      await this.audit.append(tx, { orgId, actorId, action: 'subscription.request_withdrawn', entityType: 'subscription', entityId: orgId, data: { plan: s.requestedPlan.code } });
    });
    return this.forOrg(orgId);
  }

  /** A smaller plan is refused while the organisation has more members than it allows. */
  async memberFit(tx: Tx, orgId: string, plan: { name: string; limits: unknown }) {
    const max = (plan.limits as PlanLimits).members;
    if (max === null) return;
    const members = await tx.membership.count({ where: { orgId } });
    if (members > max) throw new DomainError('PLAN_LIMIT', `${plan.name} allows ${max} member${max === 1 ? '' : 's'} and the organisation has ${members}. Remove members first.`, HttpStatus.CONFLICT, { limit: 'members', max, members });
  }

  async event(tx: Tx, orgId: string, actorId: string | null, kind: string, data: Record<string, unknown>) {
    await tx.subscriptionEvent.create({ data: { id: randomUUID(), orgId, kind, actorId, data: data as object } });
  }
}
