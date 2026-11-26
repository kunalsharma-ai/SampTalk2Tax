import { AI_AGENTS, type AiAgentId } from './ai-decision-records';

/**
 * How the AI performs (PERF-020), from the decision record every call to a model leaves
 * (AUDIT-018): how many calls each agent made, how many failed and why, how long they took
 * (median, 95th percentile, slowest), the tokens they used, and how many answers were cut short
 * at the length limit, overall, per agent and per day (India time).
 */
export interface AiCallFact {
  agent: AiAgentId;
  outcome: 'ANSWERED' | 'FAILED';
  errorName: string | null;
  stopReason: string | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: Date;
}

export interface AiCallStats {
  calls: number;
  failed: number;
  /** Failed calls as a percentage of calls, to one decimal place. */
  failureRate: number;
  /** Nearest-rank percentiles of the time a call took; null with no calls. */
  medianMs: number | null;
  p95Ms: number | null;
  slowestMs: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Answers that stopped at the length limit (stop reason max_tokens). */
  cutShort: number;
}

export interface AiPerformance {
  from: string;
  to: string;
  totals: AiCallStats;
  agents: (AiCallStats & { agent: AiAgentId; name: string })[];
  failures: { agent: AiAgentId; name: string; error: string; count: number; lastAt: string }[];
  days: { date: string; calls: number; failed: number; p95Ms: number | null }[];
  slowest: { agent: AiAgentId; name: string; startedAt: string; durationMs: number; outcome: AiCallFact['outcome'] }[];
}

const IST_MS = 330 * 60_000; // not money
/** The India date of an instant. */
export const aiCallDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

/** The nearest-rank percentile of sorted values. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function stats(calls: AiCallFact[]): AiCallStats {
  const times = calls.map((c) => c.durationMs).sort((a, b) => a - b);
  const failed = calls.filter((c) => c.outcome === 'FAILED').length;
  return {
    calls: calls.length,
    failed,
    failureRate: calls.length ? Math.round((failed * 1000) / calls.length) / 10 : 0, // not money
    medianMs: percentile(times, 50),
    p95Ms: percentile(times, 95),
    slowestMs: times.length ? times[times.length - 1]! : null,
    inputTokens: calls.reduce((t, c) => t + c.inputTokens, 0),
    outputTokens: calls.reduce((t, c) => t + c.outputTokens, 0),
    cutShort: calls.filter((c) => c.stopReason === 'max_tokens').length,
  };
}

const nameOf = (a: AiAgentId) => AI_AGENTS[a]?.name ?? a;

/** Every India date from `from` to `to`, both included (at most 400). */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** The AI's performance over the India dates `from` to `to`, from the calls made then. */
export function aiPerformance(calls: readonly AiCallFact[], period: { from: string; to: string }): AiPerformance {
  const inPeriod = calls.filter((c) => {
    const d = aiCallDay(c.startedAt);
    return d >= period.from && d <= period.to;
  });
  const byAgent = new Map<AiAgentId, AiCallFact[]>();
  const byDay = new Map<string, AiCallFact[]>();
  const failures = new Map<string, { agent: AiAgentId; error: string; count: number; last: Date }>();
  for (const c of inPeriod) {
    byAgent.set(c.agent, [...(byAgent.get(c.agent) ?? []), c]);
    const day = aiCallDay(c.startedAt);
    byDay.set(day, [...(byDay.get(day) ?? []), c]);
    if (c.outcome === 'FAILED') {
      const error = c.errorName?.trim() || 'Error';
      const key = `${c.agent}|${error}`;
      const f = failures.get(key) ?? { agent: c.agent, error, count: 0, last: c.startedAt };
      f.count++;
      if (c.startedAt > f.last) f.last = c.startedAt;
      failures.set(key, f);
    }
  }
  return {
    from: period.from,
    to: period.to,
    totals: stats(inPeriod),
    agents: [...byAgent.entries()].map(([agent, list]) => ({ agent, name: nameOf(agent), ...stats(list) })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    failures: [...failures.values()]
      .sort((a, b) => b.count - a.count || b.last.getTime() - a.last.getTime())
      .map((f) => ({ agent: f.agent, name: nameOf(f.agent), error: f.error, count: f.count, lastAt: f.last.toISOString() })),
    days: datesBetween(period.from, period.to).map((date) => {
      const s = stats(byDay.get(date) ?? []);
      return { date, calls: s.calls, failed: s.failed, p95Ms: s.p95Ms };
    }),
    slowest: [...inPeriod]
      .sort((a, b) => b.durationMs - a.durationMs || a.startedAt.getTime() - b.startedAt.getTime())
      .slice(0, 5)
      .map((c) => ({ agent: c.agent, name: nameOf(c.agent), startedAt: c.startedAt.toISOString(), durationMs: c.durationMs, outcome: c.outcome })),
  };
}
