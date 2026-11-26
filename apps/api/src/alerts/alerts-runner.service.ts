import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { OrgRotationService } from '../operations/org-rotation.service';
import { AlertsService, STALE_AFTER_MINUTES } from './alerts.service';

/** How many organisations one pass checks at most; the rest wait for the next pass, oldest first. */
export const ALERTS_RUNNER_BATCH = 20;
/** How many organisations one pass looks at at most (most have nothing to check yet or were checked by someone). */
export const ALERTS_RUNNER_LOOK = 200;
const JOB = 'alerts';

/**
 * Runs the alert checks in the background, so that problems are found (and, by the
 * notification setting, turned into tasks) without anyone opening the alerts page. Every
 * ALERTS_RUNNER_INTERVAL_SECONDS it takes the organisations due in turn (PERF-001), checks those
 * with posted entries whose last check is older than STALE_AFTER_MINUTES, as the system, and
 * sets each one's next turn.
 */
@Injectable()
export class AlertsRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Alerts');
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<{ checked: number; failed: number }> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly heartbeats: HeartbeatsService,
    private readonly rotation: OrgRotationService,
  ) {}

  onApplicationBootstrap() {
    const every = this.config.ALERTS_RUNNER_INTERVAL_SECONDS;
    this.heartbeats.register('Alert checks', every);
    if (every > 0) {
      this.timer = setInterval(() => void this.heartbeats.track('Alert checks', () => this.tick()), every * 1000);
      this.timer.unref();
      this.logger.log(`Alert checks run in the background every ${every} s for organisations not checked in the last ${STALE_AFTER_MINUTES} minutes`);
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  /**
   * One pass. Overlapping calls share one pass. For tests: `orgIds` limits the pass to those
   * organisations, and `now` is the time staleness is judged against.
   */
  tick(opts: { orgIds?: string[]; now?: Date } = {}): Promise<{ checked: number; failed: number }> {
    if (!this.inFlight) this.inFlight = this.pass(opts.orgIds ?? null, opts.now ?? new Date()).finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  /** For the given organisations (tests): those with books whose last alert scan is stale (or never ran), the oldest first. */
  private async dueOrgs(only: string[], now: Date) {
    const orgs = await this.prisma.organization.findMany({ where: { id: { in: only } }, select: { id: true } });
    const scans = await this.prisma.alertScan.groupBy({ by: ['orgId'], where: { orgId: { in: only } }, _max: { finishedAt: true } });
    const last = new Map(scans.map((s) => [s.orgId, s._max.finishedAt]));
    const stale = now.getTime() - STALE_AFTER_MINUTES * 60_000;
    const candidates = orgs
      .map((o) => ({ org_id: o.id, last: last.get(o.id) ?? null }))
      .filter((o) => o.last === null || o.last.getTime() < stale)
      .sort((a, b) => (a.last === null ? (b.last === null ? 0 : -1) : b.last === null ? 1 : a.last.getTime() - b.last.getTime()));
    const out: { org_id: string }[] = [];
    for (const o of candidates) {
      if (out.length >= ALERTS_RUNNER_BATCH) break;
      const books = await tenantStorage.run({ orgId: o.org_id }, async () => await this.prisma.journalEntry.findFirst({ where: { orgId: o.org_id }, select: { id: true } }));
      if (books) out.push({ org_id: o.org_id });
    }
    return out;
  }

  /**
   * Every organisation, in turn (PERF-001): the organisations due in the rotation, by index, at
   * most ALERTS_RUNNER_LOOK, so that a pass costs the same with ten or ten thousand organisations.
   * One checked recently (someone ran the checks) is due again an hour after that check; one
   * without posted entries is looked at again in an hour.
   */
  private async rotationPass(now: Date) {
    const stale = STALE_AFTER_MINUTES * 60_000;
    const later = (from: Date) => new Date(from.getTime() + stale);
    let checked = 0;
    let failed = 0;
    for (const { orgId } of await this.rotation.claimDue(JOB, now, ALERTS_RUNNER_LOOK)) {
      if (checked + failed >= ALERTS_RUNNER_BATCH) {
        // Not this pass: it stays first in line for the next one.
        await this.rotation.dueAgain(JOB, orgId, now);
        continue;
      }
      const { last, books } = await tenantStorage.run({ orgId }, async () => ({
        last: await this.prisma.alertScan.findFirst({ where: { orgId }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
        books: await this.prisma.journalEntry.findFirst({ where: { orgId }, select: { id: true } }),
      }));
      if (last?.finishedAt && now.getTime() - last.finishedAt.getTime() < stale) {
        await this.rotation.dueAgain(JOB, orgId, later(last.finishedAt));
        continue;
      }
      if (!books) {
        await this.rotation.dueAgain(JOB, orgId, later(now));
        continue;
      }
      try {
        await tenantStorage.run({ orgId }, async () => await this.alerts.scan(orgId, null));
        checked++;
      } catch (e) {
        failed++;
        this.logger.error(`Alert checks failed for an organisation ${orgId}: ${(e as Error).message}`);
      }
      await this.rotation.dueAgain(JOB, orgId, later(now), now);
    }
    return { checked, failed };
  }

  private async pass(only: string[] | null, now: Date) {
    if (only === null) return this.rotationPass(now);
    // A Prisma query runs when awaited, so it is awaited inside the context it needs.
    const due = await tenantStorage.run({ bypass: true }, async () =>
      await this.dueOrgs(only, now),
    );
    let checked = 0;
    let failed = 0;
    for (const { org_id: orgId } of due) {
      try {
        await tenantStorage.run({ orgId }, async () => await this.alerts.scan(orgId, null));
        checked++;
      } catch (e) {
        failed++;
        this.logger.error(`Alert checks failed for an organisation ${orgId}: ${(e as Error).message}`);
      }
    }
    return { checked, failed };
  }
}
