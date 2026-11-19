import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RETENTION_CATEGORIES, retentionCutoff, retentionProblems, statutoryRecords, type RetentionCategory } from '@talk2tax/accounting-engine';
import { hasPermission, RoleName } from '@talk2tax/security';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';

type Member = { orgId: string; role: RoleName };
type Actor = { id: string };
/** At most this many items of a kind are deleted per organisation and run; the next run goes on. */
const BATCH = 500;

/**
 * Data retention policies (SEC-020). Records the law requires are never deleted on a schedule.
 * Working data (copilot conversations, CRM webhook delivery logs) is kept until an owner or
 * admin sets a period; from then on the runner deletes what is older, and each run that deleted
 * anything, or was started by hand, is recorded and audited.
 */
@Injectable()
export class RetentionService {
  private readonly log = new Logger('Retention');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async overview(member: Member) {
    const [org, settings, runs] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: member.orgId }, select: { countryCode: true } }),
      this.prisma.retentionSetting.findMany({ where: { orgId: member.orgId } }),
      this.prisma.retentionRun.findMany({ where: { orgId: member.orgId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    const days = new Map(settings.map((s) => [s.category, s.days]));
    return {
      canManage: hasPermission(member.role, 'org.manage'),
      statutory: statutoryRecords(org?.countryCode ?? 'IN'),
      categories: RETENTION_CATEGORIES.map((c) => ({ ...c, days: days.get(c.key) ?? null })),
      runs: runs.map((r) => ({ id: r.id, trigger: r.trigger as 'SCHEDULE' | 'MANUAL', deleted: r.deleted as Record<string, number>, at: r.createdAt.toISOString() })),
    };
  }

  /** Sets (or, with null, removes) the period for a kind of working data. */
  async set(member: Member, actor: Actor, category: string, days: number | null) {
    const problems = retentionProblems(category, days);
    if (problems.length) throw new DomainError('RETENTION_INVALID', problems.join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { issues: problems });
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.retentionSetting.findUnique({ where: { orgId_category: { orgId: member.orgId, category } } });
      if (days === null) {
        if (before) await tx.retentionSetting.delete({ where: { orgId_category: { orgId: member.orgId, category } } });
      } else {
        await tx.retentionSetting.upsert({ where: { orgId_category: { orgId: member.orgId, category } }, create: { orgId: member.orgId, category, days, updatedById: actor.id }, update: { days, updatedById: actor.id } });
      }
      await this.audit.append(tx, { orgId: member.orgId, actorId: actor.id, action: 'retention.policy_changed', entityType: 'retention_setting', entityId: member.orgId, data: { category, from: before?.days ?? null, to: days } });
    });
    return this.overview(member);
  }

  /** Applies the organisation's periods now. */
  async runNow(member: Member, actor: Actor) {
    await this.apply(member.orgId, actor, new Date());
    return this.overview(member);
  }

  /** Every organisation with a period set (the runner). */
  async runAll(now = new Date()) {
    const orgIds = [...new Set((await runAsSystem(() => this.prisma.retentionSetting.findMany({ select: { orgId: true } }))).map((s) => s.orgId))];
    let deleted = 0;
    for (const orgId of orgIds) {
      try {
        const d = await runInOrg(orgId, () => this.apply(orgId, null, now));
        deleted += Object.values(d).reduce((a, b) => a + b, 0);
      } catch (e) {
        this.log.error(`Retention for ${orgId} failed`, e instanceof Error ? e.stack : String(e));
      }
    }
    return { organisations: orgIds.length, deleted };
  }

  private async apply(orgId: string, actor: Actor | null, now: Date): Promise<Record<string, number>> {
    const settings = await this.prisma.retentionSetting.findMany({ where: { orgId } });
    const deleted: Record<string, number> = {};
    // Copilot conversations are private to the member who started them, so the purge reads and
    // deletes as the system, with the organisation named in every filter.
    for (const s of settings) deleted[s.category] = await runAsSystem(() => this.purge(orgId, s.category as RetentionCategory, retentionCutoff(s.days, now)));
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (total || actor) {
      await this.prisma.$transaction(async (tx) => {
        const id = randomUUID();
        await tx.retentionRun.create({ data: { id, orgId, trigger: actor ? 'MANUAL' : 'SCHEDULE', deleted, actorId: actor?.id ?? null } });
        await this.audit.append(tx, { orgId, actorId: actor?.id ?? null, action: 'retention.purged', entityType: 'retention_run', entityId: id, data: { deleted, periods: Object.fromEntries(settings.map((x) => [x.category, x.days])) } });
      });
    }
    return deleted;
  }

  private async purge(orgId: string, category: RetentionCategory, cutoff: Date): Promise<number> {
    switch (category) {
      case 'COPILOT_CONVERSATIONS': {
        const old = await this.prisma.copilotConversation.findMany({ where: { orgId, updatedAt: { lt: cutoff } }, select: { id: true }, take: BATCH, orderBy: { updatedAt: 'asc' } });
        let n = 0;
        for (const c of old) {
          // A conversation with an answer still being written is left for the next run.
          if (await this.prisma.copilotMessage.count({ where: { orgId, conversationId: c.id, status: 'PENDING' } })) continue;
          await this.prisma.$transaction((tx) => tx.copilotConversation.deleteMany({ where: { id: c.id, orgId } }));
          n++;
        }
        return n;
      }
      case 'CRM_WEBHOOK_DELIVERIES': {
        const old = await this.prisma.crmWebhookDelivery.findMany({ where: { orgId, status: { in: ['SUCCEEDED', 'FAILED'] }, finishedAt: { lt: cutoff } }, select: { id: true }, take: BATCH });
        if (!old.length) return 0;
        const r = await this.prisma.crmWebhookDelivery.deleteMany({ where: { orgId, id: { in: old.map((d) => d.id) } } });
        return r.count;
      }
    }
  }
}
