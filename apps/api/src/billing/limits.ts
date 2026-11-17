import type { DocumentStoreService } from '../common/document-store.service';
import { runInOrg } from '../common/tenant-context';
import { invitations, memberships } from '../db/collections/tenancy';
import { HttpStatus } from '@nestjs/common';
import { PlanLimits, subscriptionAccess, SubscriptionStatus } from '@talk2tax/accounting-engine';
import { DomainError } from '../common/errors';
import type { Tx } from '../common/prisma.service';

/** The organisation's plan limits, or null when it has no subscription row. */
export async function planLimits(tx: Tx, orgId: string): Promise<{ plan: string; limits: PlanLimits } | null> {
  const s = await tx.subscription.findUnique({ where: { orgId }, select: { plan: { select: { name: true, limits: true } } } });
  return s ? { plan: s.plan.name, limits: s.plan.limits as unknown as PlanLimits } : null;
}

/**
 * Refuses another member (or an invitation that would become one) beyond the plan's limit.
 * Open invitations count, so a plan cannot be exceeded by inviting first and accepting later.
 */
export async function assertMemberRoom(tx: Tx, store: DocumentStoreService, orgId: string, opts: { countOpenInvitations: boolean }) {
  const p = await planLimits(tx, orgId);
  const max = p?.limits.members ?? null;
  if (max === null) return;
  // One after the other: inside a transaction, MongoDB runs one operation at a time per session.
  const members = await runInOrg(orgId, () => store.collection(memberships).count({}));
  const invites = opts.countOpenInvitations ? await runInOrg(orgId, () => store.collection(invitations).count({ openFor: { $exists: true }, expiresAt: { $gt: new Date() } })) : 0;
  if (members + invites >= max) {
    throw new DomainError(
      'PLAN_LIMIT',
      `The ${p!.plan} plan allows ${max} member${max === 1 ? '' : 's'}${invites ? ` (open invitations count)` : ''}. Choose a larger plan under Settings → Subscription, or remove someone first.`,
      HttpStatus.CONFLICT,
      { limit: 'members', max, members, openInvitations: invites },
    );
  }
}

export function accessOf(s: { status: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null }, now = new Date()) {
  return subscriptionAccess({ status: s.status as SubscriptionStatus, trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd }, now);
}
