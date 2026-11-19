import type { BillingInterval, PlanLimits } from '@talk2tax/accounting-engine';
import type { Tx } from '../common/prisma.service';

/** Reading enterprise contracts (SUBS-023), kept apart from the services so that any of them can use it. */
type ContractRow = { id: string; orgId: string; reference: string; planId: string; billingInterval: string; currency: string; price: { toFixed(n: number): string }; startsOn: Date; endsOn: Date; limits: unknown; notes: string; status: string; createdAt: Date; endedAt: Date | null; endReason: string | null };

/** India-time date of an instant, YYYY-MM-DD. */
const day = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

export function serializeContract(c: ContractRow, plan?: { code: string; name: string }) {
  return {
    id: c.id,
    orgId: c.orgId,
    reference: c.reference,
    ...(plan ? { plan } : {}),
    interval: c.billingInterval as BillingInterval,
    currency: c.currency,
    price: c.price.toFixed(2),
    startsOn: day(c.startsOn),
    // The last day of the term (the stored end is the first day after it).
    lastDay: day(new Date(c.endsOn.getTime() - 86_400_000)),
    endsOn: day(c.endsOn),
    limits: (c.limits ?? {}) as Partial<PlanLimits>,
    notes: c.notes,
    status: c.status as 'ACTIVE' | 'ENDED',
    createdAt: c.createdAt.toISOString(),
    endedAt: c.endedAt?.toISOString() ?? null,
    endReason: c.endReason,
  };
}

/** The contract in force on a subscription, or null. */
export async function contractInForce(db: Pick<Tx, 'enterpriseContract'>, s: { contractId: string | null }) {
  if (!s.contractId) return null;
  const c = await db.enterpriseContract.findUnique({ where: { id: s.contractId } });
  return c && c.status === 'ACTIVE' ? c : null;
}

