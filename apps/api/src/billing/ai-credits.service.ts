import { HttpStatus, Injectable } from '@nestjs/common';
import { BillingCurrency, creditBalance, dec, CreditGrant, creditPackProblems, creditsLeft, pickCreditGrant, pricePerRequest } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';

type Db = Pick<Tx, 'aiCreditGrant' | 'usageEvent'>;
type PackRow = { id: string; name: string; requests: number; prices: unknown; isActive: boolean; createdAt: Date };

const money = (v: string) => dec(v).toFixed(2);

function serializePack(p: PackRow) {
  const prices = p.prices as Record<BillingCurrency, string>;
  return { id: p.id, name: p.name, requests: p.requests, prices: { INR: money(prices.INR), USD: money(prices.USD) }, isActive: p.isActive, createdAt: p.createdAt.toISOString() };
}

/**
 * Extra AI requests (SUBS-018). Platform administrators offer packs of requests; an organisation
 * buys one through a CREDITS subscription invoice (SubscriptionPaymentsService.buyCredits), and
 * when it is paid a grant is recorded, valid for a year. Each AI request past the plan's monthly
 * ones is recorded with the grant it came from, so what is left of each pack is a count.
 */
@Injectable()
export class AiCreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  // -------------------------------------------------------------------------- the organisation's

  /** Every pack the organisation bought, with what it used of each. */
  async grants(db: Db, orgId: string): Promise<(CreditGrant & { name: string; invoiceId: string })[]> {
    const rows = await db.aiCreditGrant.findMany({ where: { orgId }, orderBy: { grantedAt: 'desc' } });
    const out = [];
    // One after the other: inside a transaction, MongoDB runs one operation at a time per session.
    for (const g of rows) out.push({ id: g.id, name: g.name, invoiceId: g.invoiceId, requests: g.requests, grantedAt: g.grantedAt, expiresAt: g.expiresAt, used: await db.usageEvent.count({ where: { orgId, creditGrantId: g.id } }) });
    return out;
  }

  /** The bought requests still usable. */
  async balance(db: Db, orgId: string, now = new Date()) {
    return creditBalance(await this.grants(db, orgId), now);
  }

  /** The pack the next AI request past the plan comes from, or null when none has requests left. */
  async next(db: Db, orgId: string, now = new Date()) {
    return pickCreditGrant(await this.grants(db, orgId), now)?.id ?? null;
  }

  /** For the Usage page: the balance, the packs bought, and the packs on offer in the organisation's currency. */
  async forOrg(orgId: string, currency: BillingCurrency, now = new Date()) {
    const grants = await this.grants(this.prisma, orgId);
    const packs = await this.prisma.aiCreditPack.findMany({ where: { isActive: true }, orderBy: { requests: 'asc' } });
    return {
      balance: creditBalance(grants, now),
      bought: grants.map((g) => ({ id: g.id, name: g.name, invoiceId: g.invoiceId, requests: g.requests, used: g.used, left: creditsLeft(g, now), grantedAt: g.grantedAt.toISOString(), expiresAt: g.expiresAt.toISOString(), expired: g.expiresAt <= now })),
      packs: packs.map((p) => {
        const price = money((p.prices as Record<BillingCurrency, string>)[currency]);
        return { id: p.id, name: p.name, requests: p.requests, price, currency, perRequest: pricePerRequest(price, p.requests) };
      }),
    };
  }

  /** Records the requests a paid CREDITS invoice bought (once per invoice). */
  async grant(tx: Tx, inv: { id: string; orgId: string; creditPack: unknown }, now: Date, expiresAt: Date) {
    const pack = inv.creditPack as { id: string; name: string; requests: number } | null;
    if (!pack) throw new Error(`Invoice ${inv.id} bought no AI requests`);
    if (await tx.aiCreditGrant.findUnique({ where: { invoiceId: inv.id } })) return null;
    return tx.aiCreditGrant.create({ data: { id: randomUUID(), orgId: inv.orgId, invoiceId: inv.id, packId: pack.id, name: pack.name, requests: pack.requests, grantedAt: now, expiresAt } });
  }

  // --------------------------------------------------------------------- platform administration

  async list() {
    const [packs, sold] = await this.system(async (tx) => [await tx.aiCreditPack.findMany({ orderBy: [{ isActive: 'desc' }, { requests: 'asc' }] }), await tx.aiCreditGrant.findMany({ select: { packId: true } })] as const);
    return packs.map((p) => ({ ...serializePack(p), sold: sold.filter((g) => g.packId === p.id).length }));
  }

  async create(actor: AuthUser, input: { name: string; requests: number; prices: Record<string, string> }) {
    const problems = creditPackProblems({ name: input.name, requests: input.requests, prices: input.prices as Record<BillingCurrency, string> });
    if (problems.length) throw new DomainError('CREDIT_PACK_INVALID', problems.join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { problems });
    const prices = { INR: money(input.prices.INR!), USD: money(input.prices.USD!) };
    const id = randomUUID();
    await this.system(async (tx) => {
      await tx.aiCreditPack.create({ data: { id, name: input.name.trim(), requests: input.requests, prices, isActive: true, createdBy: actor.id } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.ai_credit_pack_created', entityType: 'ai_credit_pack', entityId: id, data: { name: input.name.trim(), requests: input.requests, prices } });
    });
    return this.list();
  }

  async setActive(actor: AuthUser, id: string, active: boolean) {
    await this.system(async (tx) => {
      const p = await tx.aiCreditPack.findUnique({ where: { id } });
      if (!p) throw new DomainError('NOT_FOUND', 'Pack not found', HttpStatus.NOT_FOUND);
      if (p.isActive === active) return;
      await tx.aiCreditPack.update({ where: { id }, data: { isActive: active } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: active ? 'platform.ai_credit_pack_offered' : 'platform.ai_credit_pack_withdrawn', entityType: 'ai_credit_pack', entityId: id, data: { name: p.name } });
    });
    return this.list();
  }
}
