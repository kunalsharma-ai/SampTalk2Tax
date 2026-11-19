import { HttpStatus, Injectable } from '@nestjs/common';
import { BillingInterval, contractInstant, contractLimits, contractProblems, ContractInput, periodEnd, PlanLimits } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { BillingService } from './billing.service';
import { contractInForce, serializeContract } from './contract-terms';


/**
 * Enterprise contracts (SUBS-023), recorded by platform administrators. A contract puts the
 * organisation on its plan at its price and limits: from now, with the contract reference as
 * the first period's payment, or from the next renewal. While it runs the organisation cannot
 * change plan itself; renewals are invoiced at the contract price until its term ends.
 */
@Injectable()
export class EnterpriseContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  async list() {
    const rows = await this.system((tx) => tx.enterpriseContract.findMany({ orderBy: { createdAt: 'desc' }, take: 300 }));
    const [plans, orgs] = await this.system(async (tx) => [await tx.plan.findMany({ select: { id: true, code: true, name: true } }), await tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.orgId))] } }, select: { id: true, name: true } })] as const);
    return rows.map((c) => {
      const p = plans.find((x) => x.id === c.planId)!;
      return { ...serializeContract(c, { code: p.code, name: p.name }), organisation: orgs.find((o) => o.id === c.orgId)?.name ?? '' };
    });
  }

  async create(actor: AuthUser, orgId: string, input: ContractInput & { plan: string; notes: string; activate: boolean }, now = new Date()) {
    const problems = contractProblems(input);
    if (problems.length) throw new DomainError('CONTRACT_INVALID', problems.join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { problems });
    const startsOn = contractInstant(input.startsOn);
    const endsOn = contractInstant(input.endsOn);
    if (endsOn <= now) throw new DomainError('CONTRACT_INVALID', 'The term has already ended', HttpStatus.UNPROCESSABLE_ENTITY);
    const id = randomUUID();
    await this.system(async (tx) => {
      const s = await tx.subscription.findUnique({ where: { orgId } });
      if (!s) throw new DomainError('NOT_FOUND', 'Organisation not found', HttpStatus.NOT_FOUND);
      if (await contractInForce(tx, s)) throw new DomainError('CONTRACT_IN_FORCE', 'The organisation already has a contract in force; end it first', HttpStatus.CONFLICT);
      if (await tx.enterpriseContract.findUnique({ where: { reference: input.reference } })) throw new DomainError('CONTRACT_INVALID', 'Another contract has this reference', HttpStatus.UNPROCESSABLE_ENTITY);
      const plan = await tx.plan.findUnique({ where: { code: input.plan } });
      if (!plan) throw new DomainError('PLAN_NOT_FOUND', 'That plan does not exist', HttpStatus.UNPROCESSABLE_ENTITY);
      if (!input.activate && s.status !== 'ACTIVE') throw new DomainError('CONTRACT_NEEDS_ACTIVATION', 'The organisation has no paid period to renew into the contract; start it now', HttpStatus.CONFLICT);
      if (input.activate && startsOn > now) throw new DomainError('CONTRACT_NOT_STARTED', 'A contract that starts later takes effect at the renewal; it cannot start now', HttpStatus.CONFLICT);
      await this.billing.memberFit(tx, orgId, { name: plan.name, limits: contractLimits(plan.limits as unknown as PlanLimits, input.limits) });
      const c = await tx.enterpriseContract.create({ data: { id, orgId, reference: input.reference, planId: plan.id, billingInterval: input.interval, currency: s.currency, price: input.price, startsOn, endsOn, limits: input.limits, notes: input.notes.trim(), createdBy: actor.id } });
      const clear = { requestedPlanId: null, requestedInterval: null, requestedAt: null, requestedBy: null, requestedAddOns: [] };
      if (input.activate) {
        // The contract's price covers everything: no add-ons are billed on top.
        const end = periodEnd(now, input.interval);
        await tx.subscription.update({ where: { orgId }, data: { contractId: c.id, planId: plan.id, status: 'ACTIVE', billingInterval: input.interval, price: input.price, addOns: [], currentPeriodStart: now, currentPeriodEnd: end, trialEndsAt: s.status === 'TRIALING' ? s.trialEndsAt : null, paymentReference: `Contract ${input.reference}`, ...clear } });
        await this.billing.event(tx, orgId, actor.id, 'ACTIVATED', { plan: plan.code, interval: input.interval, currency: s.currency, price: input.price, periodStart: now.toISOString(), periodEnd: end.toISOString(), paymentReference: `Contract ${input.reference}`, from: s.status });
      } else {
        await tx.subscription.update({ where: { orgId }, data: { contractId: c.id, ...clear } });
      }
      await this.billing.event(tx, orgId, actor.id, 'CONTRACT_STARTED', { contract: input.reference, plan: plan.code, interval: input.interval, price: input.price, currency: s.currency, startsOn: input.startsOn, endsOn: input.endsOn, from: input.activate ? 'now' : 'the renewal' });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'platform.contract_recorded', entityType: 'enterprise_contract', entityId: c.id, data: { reference: input.reference, plan: plan.code, interval: input.interval, price: input.price, currency: s.currency, startsOn: input.startsOn, endsOn: input.endsOn, limits: input.limits, activate: input.activate } });
    });
    return (await this.list()).find((c) => c.id === id)!;
  }

  /** Ends a contract before its term: the period paid for runs on; the next renewal is at the plan's list price. */
  async end(actor: AuthUser | null, id: string, reason: string, tx?: Tx, now = new Date()) {
    if (reason.trim().length < 3) throw new DomainError('REASON_REQUIRED', 'Say why the contract ends', HttpStatus.UNPROCESSABLE_ENTITY);
    const run = async (t: Tx) => {
      const c = await t.enterpriseContract.findUnique({ where: { id } });
      if (!c) throw new DomainError('NOT_FOUND', 'Contract not found', HttpStatus.NOT_FOUND);
      if (c.status !== 'ACTIVE') throw new DomainError('CONTRACT_ENDED', 'This contract has already ended', HttpStatus.CONFLICT);
      await t.enterpriseContract.update({ where: { id }, data: { status: 'ENDED', endedAt: now, endedBy: actor?.id ?? null, endReason: reason.trim() } });
      await t.subscription.updateMany({ where: { orgId: c.orgId, contractId: id }, data: { contractId: null } });
      await this.billing.event(t, c.orgId, actor?.id ?? null, 'CONTRACT_ENDED', { contract: c.reference, reason: reason.trim() });
      await this.audit.append(t, { orgId: c.orgId, actorId: actor?.id ?? null, action: 'platform.contract_ended', entityType: 'enterprise_contract', entityId: id, data: { reference: c.reference, reason: reason.trim() } });
    };
    if (tx) return run(tx);
    await this.system(run);
    return (await this.list()).find((c) => c.id === id)!;
  }
}
