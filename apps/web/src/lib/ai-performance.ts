/** Types and formatting for AI performance (PERF-020). */
export interface AiCallStats {
  calls: number;
  failed: number;
  failureRate: number;
  medianMs: number | null;
  p95Ms: number | null;
  slowestMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cutShort: number;
}
export interface AiPerformance {
  window: 7 | 30 | 90;
  from: string;
  to: string;
  totals: AiCallStats;
  agents: (AiCallStats & { agent: string; name: string })[];
  failures: { agent: string; name: string; error: string; count: number; lastAt: string }[];
  days: { date: string; calls: number; failed: number; p95Ms: number | null }[];
  slowest: { agent: string; name: string; startedAt: string; durationMs: number; outcome: 'ANSWERED' | 'FAILED' }[];
}

/** A time taken, in milliseconds or seconds: "850 ms", "4.2 s". */
export function duration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const count = (n: number) => n.toLocaleString('en-IN');
