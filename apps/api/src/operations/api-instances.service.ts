import { Inject, Injectable, Logger, BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { DocumentStoreService } from '../common/document-store.service';
import { runAsSystem } from '../common/tenant-context';
import { type AppConfig, CONFIG } from '../config';
import { apiInstances } from '../db/collections/api-instances';
import { RegionsService } from '../regions/regions.service';
import { VERSION } from './version';

/** A server not seen for three heartbeats is taken as stopped. */
const MISSED_BEATS = 3;

/**
 * Horizontal scaling (PERF-008): this API server's row in api_instances, refreshed every
 * API_INSTANCE_HEARTBEAT_SECONDS and removed when the server stops, so that System health can
 * list every running server and spot settings that only work on one.
 */
@Injectable()
export class ApiInstancesService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log = new Logger('ApiInstances');
  readonly id = randomUUID();
  private readonly startedAt = new Date();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: DocumentStoreService,
    private readonly regions: RegionsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap() {
    await this.beat();
    this.timer = setInterval(() => void this.beat(), this.config.API_INSTANCE_HEARTBEAT_SECONDS * 1000);
    this.timer.unref();
  }

  /** Before the database connection closes (it closes on application shutdown). */
  async beforeApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await runAsSystem(() => this.store.collection(apiInstances).deleteOne({ id: this.id })).catch(() => undefined);
  }

  /** Says this server is running. A failure is logged; the next beat tries again. */
  async beat(now = new Date()) {
    try {
      await runAsSystem(() =>
        this.store.collection(apiInstances).updateOne(
          { id: this.id },
          {
            $set: { lastSeenAt: now, version: VERSION, commit: process.env.GIT_SHA?.slice(0, 64) ?? null, region: this.regions.current, rateLimitStore: this.config.RATE_LIMIT_STORE },
            $setOnInsert: { host: hostname().slice(0, 255), pid: process.pid, startedAt: this.startedAt },
          },
          { upsert: true },
        ),
      );
    } catch (e) {
      this.log.warn(`Could not record this server as running: ${(e as Error).message}`);
    }
  }

  /** The servers seen running recently, this one first, then by when they started. */
  async running(now = new Date()) {
    const since = new Date(now.getTime() - MISSED_BEATS * this.config.API_INSTANCE_HEARTBEAT_SECONDS * 1000);
    const rows = await runAsSystem(() => this.store.collection(apiInstances).find({ lastSeenAt: { $gte: since } }, { sort: { startedAt: 1 } }));
    return rows
      .map((r) => ({
        host: r.host,
        pid: r.pid,
        version: r.version,
        commit: r.commit,
        region: r.region,
        rateLimitStore: r.rateLimitStore,
        startedAt: r.startedAt,
        lastSeenAt: r.lastSeenAt,
        current: r.id === this.id,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  }
}
