import { randomUUID } from 'node:crypto';
import { billingCurrencyFor, TRIAL_PLAN_CODE } from '@talk2tax/accounting-engine';
import type { Tx } from '../common/prisma.service';

/**
 * Every new organisation starts a trial of every module (TRIAL_PLAN_CODE) for PLAN_TRIAL_DAYS;
 * demo organisations are complimentary. Runs inside the organisation-creation transaction.
 */
export async function startSubscription(tx: Tx, org: { id: string; countryCode: string; isDemo: boolean }, actorId: string, trialDays: number, now = new Date()) {
  const plan = await tx.plan.findUnique({ where: { code: TRIAL_PLAN_CODE }, select: { id: true } });
  if (!plan) throw new Error(`Plan ${TRIAL_PLAN_CODE} is missing; run the migrations`);
  const trialEndsAt = org.isDemo ? null : new Date(now.getTime() + trialDays * 86_400_000);
  await tx.subscription.create({
    data: { orgId: org.id, planId: plan.id, status: org.isDemo ? 'COMPLIMENTARY' : 'TRIALING', currency: billingCurrencyFor(org.countryCode), trialEndsAt },
  });
  await tx.subscriptionEvent.create({
    data: { id: randomUUID(), orgId: org.id, kind: org.isDemo ? 'COMPLIMENTARY' : 'TRIAL_STARTED', actorId, data: { plan: TRIAL_PLAN_CODE, ...(trialEndsAt ? { trialEndsAt: trialEndsAt.toISOString(), days: trialDays } : { note: 'Demo organisation' }) } },
  });
}
