/**
 * AI workload isolation (PERF-005): which AI calls may start now on one server, so that AI work
 * never takes the capacity people are waiting on, and one organisation's AI work never takes it
 * from the others. Pure: the API keeps the running and waiting calls in memory and asks here.
 */
import type { AiAgentId } from './ai-decision-records';

/** INTERACTIVE: someone is waiting on the screen for the answer. BACKGROUND: a run, a reminder or a review that finishes on its own. */
export type AiLane = 'INTERACTIVE' | 'BACKGROUND';

const BACKGROUND_AGENTS: ReadonlySet<AiAgentId> = new Set<AiAgentId>(['BANK_MATCHING', 'CLOSE_REVIEW', 'COLLECTIONS', 'CFO_SUMMARY']);

/** The lane an agent's calls run in. An agent Talk2Tax could not name counts as someone waiting. */
export function aiLaneFor(agent: AiAgentId): AiLane {
  return BACKGROUND_AGENTS.has(agent) ? 'BACKGROUND' : 'INTERACTIVE';
}

export interface AiWorkLimits {
  /** AI calls running at once on this server, both lanes together. */
  total: number;
  /** Of those, at most this many background calls, so that some room is always left for people. */
  background: number;
  /** AI calls running at once for one organisation. */
  perOrg: number;
}

export interface AiWork {
  orgId: string;
  lane: AiLane;
}

/** Whether limits make sense: at least one call, background below the total so people always have room. */
export function aiWorkLimitIssues(l: AiWorkLimits): string[] {
  const issues: string[] = [];
  if (!Number.isInteger(l.total) || l.total < 2) issues.push('At least 2 AI calls must be allowed at once');
  if (!Number.isInteger(l.background) || l.background < 1) issues.push('At least 1 background AI call must be allowed');
  else if (l.background >= l.total) issues.push('Background AI calls must leave room for people: allow fewer than the total');
  if (!Number.isInteger(l.perOrg) || l.perOrg < 1) issues.push('At least 1 AI call per organisation must be allowed');
  return issues;
}

/** Whether one more call may start next to the running ones. */
export function mayStartAiWork(running: readonly AiWork[], next: AiWork, limits: AiWorkLimits): boolean {
  if (running.length >= limits.total) return false;
  if (next.lane === 'BACKGROUND' && running.filter((r) => r.lane === 'BACKGROUND').length >= limits.background) return false;
  return running.filter((r) => r.orgId === next.orgId).length < limits.perOrg;
}

/**
 * The waiting call to start next, or -1: people's calls first, then background, each in the
 * order they arrived. A call that cannot start (its organisation is at its limit) does not hold
 * back the calls behind it.
 */
export function nextAiWork(waiting: readonly AiWork[], running: readonly AiWork[], limits: AiWorkLimits): number {
  for (const lane of ['INTERACTIVE', 'BACKGROUND'] as const) {
    for (let i = 0; i < waiting.length; i++) {
      const w = waiting[i];
      if (w.lane === lane && mayStartAiWork(running, w, limits)) return i;
    }
  }
  return -1;
}
