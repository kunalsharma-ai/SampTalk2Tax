import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { type AiAgentId, type AiLane, type AiWork, type AiWorkLimits, aiLaneFor, nextAiWork, mayStartAiWork } from '@talk2tax/accounting-engine';
import { DomainError } from '../common/errors';
import { type AppConfig, CONFIG } from '../config';

export const AI_BUSY = 'AI_BUSY';

/** An AI call turned away because there was no room for it in time. Its decision record names this error. */
export class AiBusyError extends DomainError {
  readonly retryAfterSeconds: number;
  constructor(lane: AiLane, waitedSeconds: number) {
    super(
      AI_BUSY,
      lane === 'INTERACTIVE'
        ? 'The AI is busy with other requests right now. Please try again in a minute.'
        : `The AI was busy for ${waitedSeconds} seconds; this background work will be tried again later.`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.retryAfterSeconds = 30;
  }
}

interface Waiting extends AiWork {
  since: number;
  start: () => void;
  timer: NodeJS.Timeout;
}

interface LaneCounts {
  started: number;
  waited: number;
  turnedAway: number;
  longestWaitMs: number;
}

const WINDOW_MS = 15 * 60_000;

/**
 * AI workload isolation (PERF-005). Every AI call on this server goes through here: it starts
 * when there is room, or waits in line. People's calls (the copilot, drafting a policy) go before
 * background work (bank line runs, reminders, month-end reviews), background work never takes the
 * last places, and one organisation never runs more than its share. A call that waits too long is
 * turned away with AI_BUSY (503). In memory, per server: each server keeps its own limits.
 */
@Injectable()
export class AiWorkPoolService {
  private readonly running: AiWork[] = [];
  private readonly waiting: Waiting[] = [];
  private readonly counts: Record<AiLane, LaneCounts> = { INTERACTIVE: blank(), BACKGROUND: blank() };
  /** Times calls were turned away, for System health's last 15 minutes. */
  private readonly turnedAwayAt: number[] = [];

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  get limits(): AiWorkLimits {
    return { total: this.config.AI_MAX_CONCURRENT, background: this.config.AI_MAX_BACKGROUND, perOrg: this.config.AI_MAX_PER_ORG };
  }

  /** Runs one AI call for an organisation when there is room for it. */
  async run<T>(orgId: string, agent: AiAgentId, signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
    const work: AiWork = { orgId, lane: aiLaneFor(agent) };
    await this.admit(work, signal);
    try {
      return await call();
    } finally {
      const i = this.running.indexOf(work);
      if (i >= 0) this.running.splice(i, 1);
      this.startWaiting();
    }
  }

  private admit(work: AiWork, signal: AbortSignal | undefined): Promise<void> {
    const c = this.counts[work.lane];
    if (!this.waiting.length && mayStartAiWork(this.running, work, this.limits)) {
      this.running.push(work);
      c.started++;
      return Promise.resolve();
    }
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
    const waitSeconds = work.lane === 'INTERACTIVE' ? this.config.AI_WAIT_SECONDS : this.config.AI_BACKGROUND_WAIT_SECONDS;
    return new Promise<void>((resolve, reject) => {
      const since = Date.now();
      const leave = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        clearTimeout(entry.timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        leave();
        reject(signal?.reason ?? new Error('Aborted'));
      };
      const entry: Waiting = {
        ...work,
        since,
        start: () => {
          leave();
          this.running.push(work);
          c.started++;
          c.waited++;
          c.longestWaitMs = Math.max(c.longestWaitMs, Date.now() - since);
          resolve();
        },
        timer: setTimeout(() => {
          leave();
          c.turnedAway++;
          this.turnedAwayAt.push(Date.now());
          reject(new AiBusyError(work.lane, waitSeconds));
        }, waitSeconds * 1000),
      };
      entry.timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
      // Room may already be there for this call while others ahead of it wait on their organisation's share.
      this.startWaiting();
    });
  }

  private startWaiting() {
    for (;;) {
      const i = nextAiWork(this.waiting, this.running, this.limits);
      if (i < 0) return;
      this.waiting[i].start();
    }
  }

  /** What System health shows: the limits, what is running and waiting now, and counts since the server started. */
  status(now = Date.now()) {
    while (this.turnedAwayAt.length && this.turnedAwayAt[0] < now - WINDOW_MS) this.turnedAwayAt.shift();
    const lane = (l: AiLane) => ({
      running: this.running.filter((r) => r.lane === l).length,
      waiting: this.waiting.filter((w) => w.lane === l).length,
      oldestWaitMs: this.waiting.filter((w) => w.lane === l).reduce((m, w) => Math.max(m, now - w.since), 0),
      ...this.counts[l],
    });
    return {
      limits: this.limits,
      waitSeconds: { interactive: this.config.AI_WAIT_SECONDS, background: this.config.AI_BACKGROUND_WAIT_SECONDS },
      interactive: lane('INTERACTIVE'),
      background: lane('BACKGROUND'),
      organisationsRunning: new Set(this.running.map((r) => r.orgId)).size,
      turnedAwayLast15Minutes: this.turnedAwayAt.length,
    };
  }
}

function blank(): LaneCounts {
  return { started: 0, waited: 0, turnedAway: 0, longestWaitMs: 0 };
}
