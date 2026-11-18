import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentStoreService } from '../common/document-store.service';
import { databaseStatus } from '../db/database-status';
import { AppConfig, CONFIG } from '../config';
import { RegionsService } from '../regions/regions.service';
import { ErrorsService } from './errors.service';
import { HeartbeatsService } from './heartbeats.service';
import { MaintenanceService } from './maintenance.service';
import { MetricsService } from './metrics.service';

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

/**
 * System health (ADMIN-010, ADMIN-011): this API process, the database, the background runners,
 * request timings and errors, measured when asked. Numbers for this server instance.
 */
@Injectable()
export class SystemService {
  private readonly startedAt = new Date();

  constructor(
    private readonly documents: DocumentStoreService,
    private readonly metrics: MetricsService,
    private readonly heartbeats: HeartbeatsService,
    private readonly maintenance: MaintenanceService,
    private readonly regions: RegionsService,
    private readonly errors: ErrorsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private database() {
    return databaseStatus(this.documents);
  }

  async health() {
    const mem = process.memoryUsage();
    const [database, maintenance, errors] = await Promise.all([
      this.database(),
      this.maintenance.current(),
      this.errors.counts().catch(() => ({ open: null, lastHour: null })),
    ]);
    const runners = this.heartbeats.list();
    const requests = this.metrics.summary();
    const problems = [
      database.status === 'DOWN' ? 'The database is not answering' : null,
      database.status === 'SLOW' ? 'The database is slow to answer' : null,
      database.unfinishedMigrations ? `${database.unfinishedMigrations} database migration${database.unfinishedMigrations === 1 ? ' has' : 's have'} not finished` : null,
      ...runners.filter((r) => r.state === 'FAILING' || r.state === 'LATE').map((r) => `${r.name} is ${r.state === 'FAILING' ? 'failing' : 'late'}`),
      requests.totals.serverErrors > 0 ? `${requests.totals.serverErrors} server error${requests.totals.serverErrors === 1 ? '' : 's'} in the last ${requests.windowMinutes} minutes` : null,
    ].filter((p): p is string => p !== null);
    return {
      status: database.status === 'DOWN' ? 'DOWN' : problems.length ? 'DEGRADED' : 'OK',
      problems,
      checkedAt: new Date(),
      server: {
        version: VERSION,
        commit: process.env.GIT_SHA ?? null,
        environment: this.config.NODE_ENV,
        node: process.version,
        region: this.regions.current,
        startedAt: this.startedAt,
        uptimeSeconds: Math.round(process.uptime()),
        memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal },
        loadAverage: (await import('node:os')).loadavg().map((n) => Math.round(n * 100) / 100),
      },
      database,
      runners,
      requests,
      errors,
      maintenance,
    };
  }
}
