import { HttpStatus, Injectable } from '@nestjs/common';
import type { Coupon } from '@talk2tax/database';
import { BillingCurrency, BillingInterval, CouponKind, CouponTerms, couponProblem, dec, describeCoupon, PlanError, validateCoupon } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/decorators';
import { DomainError } from '../../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../../common/prisma.service';

export interface CouponInput {
  code: string;
  description: string;
  kind: CouponKind;
  percentOff: string | null;
  amountOff: string | null;
  currency: BillingCurrency | null;
  planCodes: string[];
  intervals: BillingInterval[];
  cycles: number | null;
  maxRedemptions: number | null;
  redeemBy: string | null;
}

export function termsOf(c: Coupon): CouponTerms {
  return {
    code: c.code,
    kind: c.kind as CouponKind,
    percentOff: c.percentOff?.toFixed(2) ?? null,
    amountOff: c.amountOff?.toFixed(2) ?? null,
    currency: (c.currency as BillingCurrency | null) ?? null,
    planCodes: c.planCodes,
    intervals: c.intervals as BillingInterval[],
    cycles: c.cycles,
    maxRedemptions: c.maxRedemptions,
    redeemBy: c.redeemBy,
    isActive: c.isActive,
  };
}

/** A coupon as an organisation sees it at checkout. */
export function couponSummary(c: Coupon) {
  return { code: c.code, description: c.description, terms: describeCoupon(termsOf(c)) };
}

/** The coupon a checkout or renewal uses, with what it takes off, or why a code entered does not apply. */
export interface AppliedCoupon {
  coupon: Coupon;
  /** True when the organisation is already using it (it is on the subscription). */
  continuing: boolean;
}

/**
 * Coupons on Talk2Tax subscriptions (SUBS-024). Platform administrators create them and switch
 * them off; their terms are fixed once created, so what an organisation was offered never
 * changes under it. Which coupon a checkout or renewal uses is decided here; the discount is
 * worked out by the engine (couponDiscount) and recorded on the invoice.
 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  /**
   * The coupon for a charge. A code entered is checked as a new coupon for the organisation
   * (or as the one it is already using); with no code, the coupon on the subscription applies
   * while it still fits. A code that does not apply is refused with the reason; a coupon on the
   * subscription that no longer fits is left off quietly, and `lapsed` says why.
   */
  async resolve(
    tx: Tx,
    s: { orgId: string; couponId: string | null; couponUses: number },
    code: string | null,
    fit: { planCode: string; interval: BillingInterval; currency: BillingCurrency; now: Date },
  ): Promise<{ applied: AppliedCoupon | null; lapsed: string | null }> {
    if (code) {
      const c = await tx.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
      if (!c) throw new DomainError('COUPON_NOT_FOUND', 'No coupon has this code', HttpStatus.UNPROCESSABLE_ENTITY);
      const continuing = s.couponId === c.id;
      const problem = await this.problem(tx, c, s, continuing, fit);
      if (problem) throw new DomainError('COUPON_NOT_VALID', problem, HttpStatus.UNPROCESSABLE_ENTITY);
      return { applied: { coupon: c, continuing }, lapsed: null };
    }
    if (!s.couponId) return { applied: null, lapsed: null };
    const c = await tx.coupon.findUniqueOrThrow({ where: { id: s.couponId } });
    const problem = await this.problem(tx, c, s, true, fit);
    return problem ? { applied: null, lapsed: problem } : { applied: { coupon: c, continuing: true }, lapsed: null };
  }

  private async problem(tx: Tx, c: Coupon, s: { orgId: string; couponUses: number }, continuing: boolean, fit: { planCode: string; interval: BillingInterval; currency: BillingCurrency; now: Date }) {
    const usedBefore = continuing || !!(await tx.couponRedemption.findUnique({ where: { couponId_orgId: { couponId: c.id, orgId: s.orgId } }, select: { id: true } }));
    if (usedBefore && !continuing) return 'This organisation has used this coupon already';
    const redemptions = continuing ? 0 : await tx.couponRedemption.count({ where: { couponId: c.id } });
    return couponProblem(termsOf(c), { ...fit, redemptions, usedByOrg: continuing, usesByOrg: continuing ? s.couponUses : 0 });
  }

  /** After a discounted invoice is paid: the organisation starts (or goes on) using the coupon. */
  async recordUse(tx: Tx, inv: { id: string; orgId: string; couponId: string | null }) {
    if (!inv.couponId) return;
    const s = await tx.subscription.findUniqueOrThrow({ where: { orgId: inv.orgId }, select: { couponId: true, couponUses: true } });
    const existing = await tx.couponRedemption.findUnique({ where: { couponId_orgId: { couponId: inv.couponId, orgId: inv.orgId } } });
    if (!existing) await tx.couponRedemption.create({ data: { id: randomUUID(), couponId: inv.couponId, orgId: inv.orgId, invoiceId: inv.id } });
    await tx.subscription.update({ where: { orgId: inv.orgId }, data: { couponId: inv.couponId, couponUses: (s.couponId === inv.couponId ? s.couponUses : 0) + 1 } });
  }

  // ------------------------------------------------------------------------------ administration

  async list() {
    return this.system(async (tx) => {
      const coupons = await tx.coupon.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
      const ids = coupons.map((c) => c.id);
      const [redemptions, invoices, subs] = await Promise.all([
        tx.couponRedemption.findMany({ where: { couponId: { in: ids } }, include: { org: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
        tx.subscriptionInvoice.findMany({ where: { couponId: { in: ids }, status: 'PAID' }, select: { couponId: true, orgId: true, discount: true, currency: true } }),
        tx.subscription.findMany({ where: { couponId: { in: ids } }, select: { orgId: true, couponId: true, couponUses: true } }),
      ]);
      return coupons.map((c) => {
        const paid = invoices.filter((i) => i.couponId === c.id);
        const given: Record<string, string> = {};
        for (const i of paid) given[i.currency] = sum(given[i.currency], i.discount.toFixed(2));
        return {
          ...this.serialize(c),
          organisations: redemptions.filter((r) => r.couponId === c.id).map((r) => {
            const mine = paid.filter((i) => i.orgId === r.orgId);
            const sub = subs.find((x) => x.orgId === r.orgId && x.couponId === c.id);
            return { orgId: r.orgId, name: r.org.name, since: r.createdAt.toISOString(), payments: mine.length, discount: mine.reduce((t, i) => sum(t, i.discount.toFixed(2)), '0.00'), currency: mine[0]?.currency ?? c.currency, stillUsing: !!sub, paymentsLeft: sub && c.cycles !== null ? Math.max(c.cycles - sub.couponUses, 0) : null };
          }),
          discountGiven: Object.entries(given).map(([currency, amount]) => ({ currency, amount })),
        };
      });
    });
  }

  serialize(c: Coupon) {
    const t = termsOf(c);
    return {
      id: c.id,
      code: c.code,
      description: c.description,
      kind: t.kind,
      percentOff: t.percentOff,
      amountOff: t.amountOff,
      currency: t.currency,
      planCodes: t.planCodes,
      intervals: t.intervals,
      cycles: t.cycles,
      maxRedemptions: t.maxRedemptions,
      redeemBy: t.redeemBy?.toISOString() ?? null,
      isActive: c.isActive,
      terms: describeCoupon(t),
      createdAt: c.createdAt.toISOString(),
    };
  }

  async create(actor: AuthUser, input: CouponInput) {
    let t;
    try {
      const redeemBy = input.redeemBy ? endOfDay(input.redeemBy) : null;
      t = validateCoupon({ ...input, redeemBy });
    } catch (e) {
      if (e instanceof PlanError) throw new DomainError('COUPON_INVALID', e.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
    const terms = t;
    return this.system(async (tx) => {
      if (await tx.coupon.findUnique({ where: { code: terms.code }, select: { id: true } })) throw new DomainError('COUPON_EXISTS', `A coupon with the code ${terms.code} exists already`, HttpStatus.CONFLICT);
      if (terms.planCodes.length) {
        const plans = await tx.plan.findMany({ where: { code: { in: terms.planCodes } }, select: { code: true } });
        const unknown = terms.planCodes.filter((p) => !plans.some((x) => x.code === p));
        if (unknown.length) throw new DomainError('PLAN_NOT_FOUND', `No plan has the code ${unknown.join(', ')}`, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const c = await tx.coupon.create({
        data: { id: randomUUID(), code: terms.code, description: input.description.trim(), kind: terms.kind, percentOff: terms.percentOff, amountOff: terms.amountOff, currency: terms.currency, planCodes: terms.planCodes, intervals: terms.intervals, cycles: terms.cycles, maxRedemptions: terms.maxRedemptions, redeemBy: terms.redeemBy, createdBy: actor.id },
      });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.coupon_created', entityType: 'coupon', entityId: c.id, data: { code: c.code, terms: describeCoupon(terms), planCodes: terms.planCodes, intervals: terms.intervals, maxRedemptions: terms.maxRedemptions, redeemBy: terms.redeemBy?.toISOString() ?? null } });
      return this.serialize(c);
    });
  }

  /** Switching a coupon off stops new organisations using it; ones already using it keep it. */
  async setActive(actor: AuthUser, id: string, active: boolean) {
    return this.system(async (tx) => {
      const c = await tx.coupon.findUnique({ where: { id } });
      if (!c) throw new DomainError('NOT_FOUND', 'Coupon not found', HttpStatus.NOT_FOUND);
      if (c.isActive === active) return this.serialize(c);
      const u = await tx.coupon.update({ where: { id }, data: { isActive: active } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: active ? 'platform.coupon_switched_on' : 'platform.coupon_switched_off', entityType: 'coupon', entityId: id, data: { code: c.code } });
      return this.serialize(u);
    });
  }
}

function sum(a: string | undefined, b: string) {
  return dec(a ?? '0').plus(b).toFixed(2);
}

/** A redeem-by date (YYYY-MM-DD) runs to the end of that day in India. */
function endOfDay(d: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new PlanError('The redeem-by date is YYYY-MM-DD');
  const t = new Date(`${d}T23:59:59.999+05:30`);
  if (Number.isNaN(t.getTime())) throw new PlanError('The redeem-by date is not a date');
  return t;
}
