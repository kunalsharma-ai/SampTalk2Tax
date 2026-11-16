import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { AppConfig, CONFIG } from '../config';
import { HeartbeatsService } from '../operations/heartbeats.service';
import { AlertsService, STALE_AFTER_MINUTES } from './alerts.service';

/** How many organisations one pass checks at most; the rest wait for the next pass, oldest first. */
export const ALERTS_RUNNER_BATCH = 20;

/**
 * Runs the alert checks in the background, so that problems are found (and, by the
 * notification setting, turned into tasks) without anyone opening the alerts page. Every
 * ALERTS_RUNNER_INTERVAL_SECONDS it takes the organisations with posted entries whose last
 * check is older than STALE_AFTER_MINUTES, oldest first, and checks each as the system.
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

  private async pass(only: string[] | null, now: Date) {
    // A Prisma query runs when awaited, so it is awaited inside the context it needs.
    const due = await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.$queryRaw<{ org_id: string }[]>`
        SELECT o.id AS org_id
        FROM organizations o
        LEFT JOIN LATERAL (SELECT MAX(s.finished_at) AS last FROM alert_scans s WHERE s.org_id = o.id) s ON true
        WHERE EXISTS (SELECT 1 FROM journal_entries e WHERE e.org_id = o.id)
          AND (${only === null} OR o.id::text = ANY(${only ?? []}::text[]))
          AND (s.last IS NULL OR s.last < ${now}::timestamptz - make_interval(mins => ${STALE_AFTER_MINUTES}::int))
        ORDER BY s.last ASC NULLS FIRST
        LIMIT ${ALERTS_RUNNER_BATCH}`,
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
