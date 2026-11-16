import { Injectable } from '@nestjs/common';
import { percentile } from '@talk2tax/accounting-engine';

/** How far back request timings are kept, and the most kept (the oldest go first). */
export const METRICS_WINDOW_MINUTES = 15;
const MAX_SAMPLES = 50_000;

interface Sample {
  at: number;
  route: string;
  status: number;
  ms: number;
}

/**
 * Request timings for this API process, in memory: the last METRICS_WINDOW_MINUTES of requests,
 * by route pattern (ids replaced). Each server instance keeps its own; nothing is stored.
 */
@Injectable()
export class MetricsService {
  private samples: Sample[] = [];
  private readonly startedAt = Date.now();

  record(route: string, status: number, ms: number, at = Date.now()) {
    this.samples.push({ at, route, status, ms });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  private recent(now: number) {
    const since = now - METRICS_WINDOW_MINUTES * 60_000;
    // Drop what has aged out, so the list stays bounded between reads too.
    const first = this.samples.findIndex((s) => s.at >= since);
    if (first === -1) this.samples = [];
    else if (first > 0) this.samples.splice(0, first);
    return this.samples;
  }

  summary(now = Date.now()) {
    const rows = this.recent(now);
    const byRoute = new Map<string, Sample[]>();
    for (const s of rows) byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s]);
    const stat = (list: Sample[]) => ({
      requests: list.length,
      clientErrors: list.filter((s) => s.status >= 400 && s.status < 500).length,
      serverErrors: list.filter((s) => s.status >= 500).length,
      p50Ms: percentile(list.map((s) => s.ms), 50),
      p95Ms: percentile(list.map((s) => s.ms), 95),
    });
    const minutes = Array.from({ length: METRICS_WINDOW_MINUTES }, (_, i) => {
      const end = now - (METRICS_WINDOW_MINUTES - 1 - i) * 60_000;
      const list = rows.filter((s) => s.at > end - 60_000 && s.at <= end);
      return { at: new Date(end).toISOString(), requests: list.length, serverErrors: list.filter((s) => s.status >= 500).length, p95Ms: percentile(list.map((s) => s.ms), 95) };
    });
    return {
      windowMinutes: METRICS_WINDOW_MINUTES,
      since: new Date(Math.max(this.startedAt, now - METRICS_WINDOW_MINUTES * 60_000)).toISOString(),
      totals: stat(rows),
      minutes,
      routes: [...byRoute.entries()]
        .map(([route, list]) => ({ route, ...stat(list) }))
        .sort((a, b) => b.serverErrors - a.serverErrors || (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || b.requests - a.requests)
        .slice(0, 50),
    };
  }
}
