import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { userMfa, users } from '../db/collections/identity';
import { orgSecuritySettings } from '../db/collections/security';
import { memberships } from '../db/collections/tenancy';

/**
 * An organisation's sign-in rule (SEC-005): when it requires two-step sign-in, members without
 * it on are refused (403 MFA_REQUIRED) on every route of the organisation until they turn it
 * on; the web app shows them the set-up card instead of the books.
 */
@Injectable()
export class OrgSecurityService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Of these organisations, the ones that require two-step sign-in (system read: no organisation in context yet). */
  async requiring(orgIds: string[]): Promise<Set<string>> {
    if (!orgIds.length) return new Set();
    const rows = await runAsSystem(() => this.store.collection(orgSecuritySettings).find({ orgId: { $in: orgIds }, requireTwoStep: true }));
    return new Set(rows.map((r) => r.orgId));
  }

  async userHasTwoStep(userId: string): Promise<boolean> {
    return this.store.collection(userMfa).exists({ id: userId, status: 'ACTIVE' });
  }

  /** Refuses a member who lacks two-step sign-in in an organisation that requires it. */
  async assertAllowed(orgId: string, userId: string): Promise<void> {
    if (!(await this.requiring([orgId])).has(orgId)) return;
    if (await this.userHasTwoStep(userId)) return;
    throw new ForbiddenException({ error: 'MFA_REQUIRED', message: 'This organisation requires two-step sign-in. Turn it on under Account, then open the organisation again.' });
  }

  async get(orgId: string, userId: string) {
    const s = await runInOrg(orgId, () => this.store.collection(orgSecuritySettings).findOne({}));
    const ms = await runInOrg(orgId, () => this.store.collection(memberships).find({}));
    const on = new Set((await this.store.collection(userMfa).find({ id: { $in: ms.map((m) => m.userId) }, status: 'ACTIVE' })).map((m) => m.id));
    const by = s ? await this.store.collection(users).findById(s.updatedById) : null;
    return {
      requireTwoStep: s?.requireTwoStep ?? false,
      updatedAt: s?.updatedAt.toISOString() ?? null,
      updatedBy: by?.name ?? null,
      membersWithoutTwoStep: ms.filter((m) => !on.has(m.userId)).length,
      youHaveTwoStep: on.has(userId),
    };
  }

  /** Turning the rule on needs two-step sign-in on the person who does it, so they do not lock themselves out. */
  async set(orgId: string, actorId: string, requireTwoStep: boolean) {
    if (requireTwoStep && !(await this.userHasTwoStep(actorId))) {
      throw new DomainError('MFA_NEEDED_FIRST', 'Turn two-step sign-in on for yourself under Account before requiring it for everyone.', HttpStatus.CONFLICT);
    }
    const coll = this.store.collection(orgSecuritySettings);
    const before = await runInOrg(orgId, () => coll.findOne({}));
    if ((before?.requireTwoStep ?? false) === requireTwoStep) return this.get(orgId, actorId);
    const now = new Date();
    await runInOrg(orgId, async () => {
      if (before) await coll.updateOne({ id: before.id }, { $set: { requireTwoStep, updatedById: actorId, updatedAt: now } });
      else await coll.insertOne({ orgId, requireTwoStep, updatedById: actorId, createdAt: now, updatedAt: now });
    });
    const out = await this.get(orgId, actorId);
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId, actorId, action: requireTwoStep ? 'org.two_step_required' : 'org.two_step_not_required', entityType: 'organization', entityId: orgId, data: { membersWithoutTwoStep: out.membersWithoutTwoStep } }),
    );
    return out;
  }

  /** Who in the organisation has two-step sign-in on. */
  async withTwoStep(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    return new Set((await this.store.collection(userMfa).find({ id: { $in: userIds }, status: 'ACTIVE' })).map((m) => m.id));
  }
}
