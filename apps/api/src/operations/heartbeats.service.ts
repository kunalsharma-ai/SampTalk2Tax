import { Injectable, Logger } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

interface Beat {
  name: string;
  intervalSeconds: number;
  runs: number;
  failures: number;
  skipped: number;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastMs: number | null;
  lastError: string | null;
  running: boolean;
}

/**
 * The background runners (workflows, alerts, renewals) report each pass here, so that System
 * health shows when each last ran, how long it took and whether it failed. While maintenance is
 * in progress they skip their passes. In memory, per server instance.
 */
@Injectable()
export class HeartbeatsService {
  private readonly logger = new Logger('Heartbeats');
  private readonly beats = new Map<string, Beat>();

  constructor(private readonly maintenance: MaintenanceService) {}

  register(name: string, intervalSeconds: number) {
    if (!this.beats.has(name)) this.beats.set(name, { name, intervalSeconds, runs: 0, failures: 0, skipped: 0, lastStartedAt: null, lastFinishedAt: null, lastMs: null, lastError: null, running: false });
  }

  /** Runs one pass of a runner and records it; skipped while maintenance is in progress. */
  async track(name: string, pass: () => Promise<unknown>): Promise<void> {
    const b = this.beats.get(name);
    if (!b) throw new Error(`Runner ${name} is not registered`);
    if (await this.maintenance.paused().catch(() => false)) {
      b.skipped += 1;
      return;
    }
    const started = Date.now();
    b.running = true;
    b.lastStartedAt = new Date(started);
    try {
      await pass();
      b.lastError = null;
    } catch (e) {
      b.failures += 1;
      b.lastError = (e as Error).message.slice(0, 500);
      this.logger.error(`${name} failed: ${b.lastError}`);
    } finally {
      b.runs += 1;
      b.running = false;
      b.lastMs = Date.now() - started;
      b.lastFinishedAt = new Date();
    }
  }

  /** Each runner with its state: OFF (interval 0), WAITING (not run yet), OK, FAILING, or LATE (missed two passes). */
  list(now = new Date()) {
    return [...this.beats.values()].map((b) => {
      const late = b.intervalSeconds > 0 && b.lastFinishedAt !== null && now.getTime() - b.lastFinishedAt.getTime() > b.intervalSeconds * 2000 + 60_000;
      const state = b.intervalSeconds === 0 ? 'OFF' : b.lastError ? 'FAILING' : late ? 'LATE' : b.lastFinishedAt ? 'OK' : 'WAITING';
      return { ...b, state };
    });
  }
}
