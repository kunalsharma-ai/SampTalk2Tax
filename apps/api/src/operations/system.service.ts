import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentStoreService } from '../common/document-store.service';
import { databaseStatus } from '../db/database-status';
import { AppConfig, CONFIG, LoadedConfig, mongoUsesTls, SECRET_SETTINGS } from '../config';
import { serverMail } from '../integrations/integrations.service';
import { RegionsService } from '../regions/regions.service';
import { BackupsService } from '../backups/backups.service';
import { ErrorsService } from './errors.service';
import { HeartbeatsService } from './heartbeats.service';
import { MaintenanceService } from './maintenance.service';
import { MetricsService } from './metrics.service';
import { AiWorkPoolService } from '../ai-work/ai-work-pool.service';

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
    private readonly backups: BackupsService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly aiWork: AiWorkPoolService,
  ) {}

  private database() {
    return databaseStatus(this.documents);
  }

  /**
   * Encryption in transit (SEC-010): how each connection Talk2Tax makes or takes is protected,
   * from this server's settings. requestSecure is whether the request asking arrived over HTTPS.
   */
  transport(requestSecure: boolean) {
    const c = this.config;
    const mail = serverMail(c);
    const url = mail?.options.url ?? null;
    const email = !mail
      ? 'NOT_SET_UP'
      : url
        ? url.startsWith('smtps://')
          ? 'TLS'
          : /[?&]requireTLS=true/i.test(url)
            ? 'STARTTLS_REQUIRED'
            : /[?&]ignoreTLS=true/i.test(url)
              ? 'PLAIN'
              : 'STARTTLS_WHEN_OFFERED'
        : c.SMTP_SECURE
          ? 'TLS'
          : 'STARTTLS_WHEN_OFFERED';
    const https = (u: string | undefined) => !u || u.startsWith('https://');
    return {
      httpsOnly: c.HTTPS_ONLY,
      strictTransportSecurity: true,
      requestSecure,
      trustProxyHops: c.TRUST_PROXY_HOPS,
      database: { encrypted: mongoUsesTls(c.MONGODB_URL), required: c.MONGODB_REQUIRE_TLS },
      email,
      ai: https(c.ANTHROPIC_BASE_URL) ? 'HTTPS' : 'PLAIN',
      payments: https(c.PAYMENTS_STRIPE_API_URL) && https(c.PAYMENTS_RAZORPAY_API_URL) ? 'HTTPS' : 'PLAIN',
      webhooks: c.WEBHOOK_ALLOW_PRIVATE_NETWORKS ? 'PLAIN_ALLOWED' : 'HTTPS_ONLY',
    };
  }

  /**
   * Secrets management (SEC-012): for each secret the API reads, whether it is set and where it
   * came from (the environment, a <NAME>_FILE such as a mounted secret, or derived). Never a value.
   */
  secrets() {
    const c = this.config as AppConfig & Partial<Pick<LoadedConfig, 'SECRET_SOURCES'>>;
    const sources = c.SECRET_SOURCES ?? {};
    const value = (name: string) => (c as unknown as Record<string, unknown>)[name];
    const items = SECRET_SETTINGS.filter((n) => n !== 'BACKUP_ENCRYPTION_KEY').map((name) => {
      const v = value(name);
      const set = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
      const source = sources[name] ?? (set ? 'ENVIRONMENT' : name === 'INTEGRATIONS_ENCRYPTION_KEY' ? 'DERIVED' : null);
      return { name, set: set || source === 'DERIVED', source };
    });
    const fromFiles = items.filter((i) => i.source === 'FILE').length;
    return { items, fromFiles, encryptionKeyDerived: !c.INTEGRATIONS_ENCRYPTION_KEY };
  }

  async health(requestSecure = false) {
    const mem = process.memoryUsage();
    const [database, maintenance, errors, backups] = await Promise.all([
      this.database(),
      this.maintenance.current(),
      this.errors.counts().catch(() => ({ open: null, lastHour: null })),
      // Backups are expected of a production server only (SEC-021).
      this.config.NODE_ENV === 'production' ? this.backups.status().catch(() => null) : Promise.resolve(null),
    ]);
    const runners = this.heartbeats.list();
    const requests = this.metrics.summary();
    const ai = this.aiWork.status();
    const problems = [
      database.status === 'DOWN' ? 'The database is not answering' : null,
      database.status === 'SLOW' ? 'The database is slow to answer' : null,
      database.unfinishedMigrations ? `${database.unfinishedMigrations} database migration${database.unfinishedMigrations === 1 ? ' has' : 's have'} not finished` : null,
      ...runners.filter((r) => r.state === 'FAILING' || r.state === 'LATE').map((r) => `${r.name} is ${r.state === 'FAILING' ? 'failing' : 'late'}`),
      this.config.NODE_ENV === 'production' && !this.config.HTTPS_ONLY ? 'Requests are accepted without HTTPS (set HTTPS_ONLY=true)' : null,
      this.config.NODE_ENV === 'production' && !mongoUsesTls(this.config.MONGODB_URL) ? 'The database connection is not encrypted' : null,
      this.config.NODE_ENV === 'production' && !this.config.INTEGRATIONS_ENCRYPTION_KEY ? 'Stored secrets and files are encrypted with a key derived from JWT_SECRET (set INTEGRATIONS_ENCRYPTION_KEY)' : null,
      ...(backups?.problems ?? []),
      ai.turnedAwayLast15Minutes > 0 ? `${ai.turnedAwayLast15Minutes} AI call${ai.turnedAwayLast15Minutes === 1 ? ' was' : 's were'} turned away in the last 15 minutes because the AI was busy (raise AI_MAX_CONCURRENT or add servers)` : null,
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
      ai,
      errors,
      maintenance,
      transport: this.transport(requestSecure),
      secrets: this.secrets(),
    };
  }
}
