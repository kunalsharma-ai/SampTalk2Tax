import { HttpStatus, Injectable } from '@nestjs/common';
import { BillingCurrency, BillingInterval, periodEnd, PlanDefinition, planProblems, priceFor } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { BillingService, serializePlan } from './billing.service';
import { accessOf } from './limits';

/**
 * Plans and subscriptions as the platform sees them. Plans are edited here; a requested plan is
 * activated when payment is received (an invoice paid by bank transfer, an enterprise contract)
 * with its payment reference. Online checkout comes in the next slice and uses the same activation.
 */
@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  async plans() {
    const rows = await this.prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    const counts = await this.system((tx) => tx.subscription.groupBy({ by: ['planId'], _count: { _all: true } }));
    const n = new Map(counts.map((c) => [c.planId, c._count._all]));
    return rows.map((p) => ({ ...serializePlan(p), subscriptions: n.get(p.id) ?? 0 }));
  }

  async savePlan(actor: AuthUser, input: PlanDefinition & { isActive: boolean; sortOrder: number }) {
    const problems = planProblems(input);
    if (problems.length) throw new DomainError('PLAN_INVALID', 'The plan is not valid', HttpStatus.UNPROCESSABLE_ENTITY, { issues: problems });
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { code: input.code } });
      const data = { name: input.name.trim(), description: input.description.trim(), prices: input.prices as object, limits: input.limits as object, features: input.features, isActive: input.isActive, sortOrder: input.sortOrder };
      const p = before ? await tx.plan.update({ where: { code: input.code }, data }) : await tx.plan.create({ data: { id: randomUUID(), code: input.code, ...data } });
      await this.audit.append(tx, {
        orgId: null,
        actorId: actor.id,
        action: before ? 'platform.plan_changed' : 'platform.plan_created',
        entityType: 'plan',
        entityId: p.id,
        data: { code: p.code, before: before ? serializePlan(before) : null, after: serializePlan(p) },
      });
      return serializePlan(p);
    });
  }

  async subscriptions(filter: 'all' | 'requested' | 'trial' | 'active' | 'read_only', now = new Date(), orgId?: string) {
    const rows = await this.system((tx) =>
      tx.subscription.findMany({
        where: orgId ? { orgId } : filter === 'requested' ? { requestedPlanId: { not: null } } : filter === 'trial' ? { status: 'TRIALING' } : filter === 'active' ? { status: 'ACTIVE' } : {},
        include: { org: { select: { name: true, countryCode: true, isDemo: true } }, plan: { select: { code: true, name: true } }, requestedPlan: { select: { code: true, name: true } } },
        orderBy: [{ requestedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
        take: 300,
      }),
    );
    return rows
      .map((s) => ({
        orgId: s.orgId,
        organisation: s.org.name,
        countryCode: s.org.countryCode,
        isDemo: s.org.isDemo,
        plan: s.plan,
        status: s.status,
        access: accessOf(s, now),
        billingInterval: s.billingInterval,
        currency: s.currency,
        price: s.price?.toFixed(2) ?? null,
        trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        paymentReference: s.paymentReference,
        request: s.requestedPlan ? { plan: s.requestedPlan, interval: s.requestedInterval, at: s.requestedAt!.toISOString() } : null,
      }))
      .filter((s) => filter !== 'read_only' || s.access.level === 'READ_ONLY');
  }

  /**
   * Starts a paid period on a plan once payment is received. Without a plan, the organisation's
   * request is activated. The price is the plan's list price in the organisation's currency.
   */
  async activate(actor: AuthUser, orgId: string, input: { plan?: string; interval?: BillingInterval; paymentReference: string }, now = new Date()) {
    const ref = input.paymentReference.trim();
    if (ref.length < 3) throw new DomainError('PAYMENT_REFERENCE_REQUIRED', 'Enter the payment reference (bank transfer, invoice or contract number)', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.system(async (tx) => {
      const s = await tx.subscription.findUnique({ where: { orgId }, include: { requestedPlan: true } });
      if (!s) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
      const plan = input.plan ? await tx.plan.findUnique({ where: { code: input.plan } }) : s.requestedPlan;
      const interval = (input.interval ?? s.requestedInterval) as BillingInterval | null;
      if (!plan) throw new DomainError('PLAN_NOT_FOUND', input.plan ? 'That plan does not exist' : 'Choose a plan: the organisation has not requested one', HttpStatus.UNPROCESSABLE_ENTITY);
      if (!interval) throw new DomainError('INTERVAL_REQUIRED', 'Choose monthly or annual billing', HttpStatus.UNPROCESSABLE_ENTITY);
      await this.billing.memberFit(tx, orgId, plan);
      const currency = s.currency as BillingCurrency;
      const price = priceFor(serializePlan(plan), currency, interval);
      const end = periodEnd(now, interval);
      await tx.subscription.update({
        where: { orgId },
        data: { planId: plan.id, status: 'ACTIVE', billingInterval: interval, price: price.toFixed(2), currentPeriodStart: now, currentPeriodEnd: end, trialEndsAt: s.status === 'TRIALING' ? s.trialEndsAt : null, paymentReference: ref, requestedPlanId: null, requestedInterval: null, requestedAt: null, requestedBy: null },
      });
      await this.billing.event(tx, orgId, actor.id, 'ACTIVATED', { plan: plan.code, interval, currency, price: price.toFixed(2), periodStart: now.toISOString(), periodEnd: end.toISOString(), paymentReference: ref, from: s.status });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'platform.subscription_activated', entityType: 'subscription', entityId: orgId, data: { plan: plan.code, interval, price: price.toFixed(2), currency, paymentReference: ref } });
    });
    return this.one(orgId);
  }

  async extendTrial(actor: AuthUser, orgId: string, days: number, now = new Date()) {
    await this.system(async (tx) => {
      const s = await tx.subscription.findUnique({ where: { orgId } });
      if (!s) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
      if (s.status !== 'TRIALING') throw new DomainError('NOT_TRIALING', 'Only a trial can be extended', HttpStatus.CONFLICT);
      const from = s.trialEndsAt && s.trialEndsAt > now ? s.trialEndsAt : now;
      const until = new Date(from.getTime() + days * 86_400_000);
      await tx.subscription.update({ where: { orgId }, data: { trialEndsAt: until } });
      await this.billing.event(tx, orgId, actor.id, 'TRIAL_EXTENDED', { days, trialEndsAt: until.toISOString() });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'platform.trial_extended', entityType: 'subscription', entityId: orgId, data: { days, trialEndsAt: until.toISOString() } });
    });
    return this.one(orgId);
  }

  /** Cancels a paid plan: it runs to the end of the period already paid for, then the books become read-only. */
  async cancel(actor: AuthUser, orgId: string, reason: string) {
    if (reason.trim().length < 3) throw new DomainError('REASON_REQUIRED', 'Say why the subscription is cancelled', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.system(async (tx) => {
      const s = await tx.subscription.findUnique({ where: { orgId } });
      if (!s) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
      if (s.status !== 'ACTIVE') throw new DomainError('NOT_ACTIVE', 'Only an active paid subscription can be cancelled', HttpStatus.CONFLICT);
      await tx.subscription.update({ where: { orgId }, data: { status: 'CANCELLED' } });
      await this.billing.event(tx, orgId, actor.id, 'CANCELLED', { reason: reason.trim(), runsUntil: s.currentPeriodEnd?.toISOString() ?? null });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'platform.subscription_cancelled', entityType: 'subscription', entityId: orgId, data: { reason: reason.trim() } });
    });
    return this.one(orgId);
  }

  /** No charge, no end: for the platform's own, partner or demo organisations. */
  async complimentary(actor: AuthUser, orgId: string, reason: string) {
    if (reason.trim().length < 3) throw new DomainError('REASON_REQUIRED', 'Say why the organisation is complimentary', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.system(async (tx) => {
      const s = await tx.subscription.findUnique({ where: { orgId } });
      if (!s) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
      if (s.status === 'COMPLIMENTARY') throw new DomainError('ALREADY_COMPLIMENTARY', 'Already complimentary', HttpStatus.CONFLICT);
      await tx.subscription.update({ where: { orgId }, data: { status: 'COMPLIMENTARY', billingInterval: null, price: null, currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null } });
      await this.billing.event(tx, orgId, actor.id, 'COMPLIMENTARY', { reason: reason.trim(), from: s.status });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'platform.subscription_complimentary', entityType: 'subscription', entityId: orgId, data: { reason: reason.trim() } });
    });
    return this.one(orgId);
  }

  private async one(orgId: string) {
    const [one] = await this.subscriptions('all', new Date(), orgId);
    return one!;
  }
}
