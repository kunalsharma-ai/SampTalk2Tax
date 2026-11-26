import { describe, expect, it } from 'vitest';
import { aiCallDay, aiPerformance, type AiCallFact } from '../src/ai-performance';

/** How the AI performs (PERF-020): calls, failures, times, tokens and cut-short answers, per agent and per day. */
const call = (over: Partial<AiCallFact>): AiCallFact => ({
  agent: 'COPILOT',
  outcome: 'ANSWERED',
  errorName: null,
  stopReason: 'end_turn',
  durationMs: 1000,
  inputTokens: 100,
  outputTokens: 10,
  startedAt: new Date('2026-11-20T06:00:00Z'),
  ...over,
});

describe('AI performance', () => {
  it('counts calls, failures, percentiles, tokens and answers cut short', () => {
    const calls = [
      ...Array.from({ length: 19 }, (_, i) => call({ durationMs: (i + 1) * 100 })),
      call({ durationMs: 9000, outcome: 'FAILED', errorName: 'RateLimitError', stopReason: null, inputTokens: 0, outputTokens: 0 }),
    ];
    calls[0] = call({ durationMs: 100, stopReason: 'max_tokens' });
    const p = aiPerformance(calls, { from: '2026-11-20', to: '2026-11-20' });
    expect(p.totals).toEqual({ calls: 20, failed: 1, failureRate: 5, medianMs: 1000, p95Ms: 1900, slowestMs: 9000, inputTokens: 1900, outputTokens: 190, cutShort: 1 });
    expect(p.failures).toEqual([{ agent: 'COPILOT', name: 'Copilot', error: 'RateLimitError', count: 1, lastAt: '2026-11-20T06:00:00.000Z' }]);
    expect(p.slowest[0]).toMatchObject({ durationMs: 9000, outcome: 'FAILED' });
    expect(p.slowest).toHaveLength(5);
  });

  it('splits by agent, most calls first, and by India day, with empty days', () => {
    const p = aiPerformance(
      [
        call({ agent: 'BANK_MATCHING', startedAt: new Date('2026-11-19T20:00:00Z') }), // 20 Nov 01:30 in India
        call({ agent: 'BANK_MATCHING', outcome: 'FAILED', errorName: 'APIError' }),
        call({ agent: 'CFO_SUMMARY', startedAt: new Date('2026-11-22T10:00:00Z') }),
        call({ agent: 'COPILOT', startedAt: new Date('2026-11-25T10:00:00Z') }), // outside the period
      ],
      { from: '2026-11-20', to: '2026-11-22' },
    );
    expect(p.agents.map((a) => [a.name, a.calls, a.failed, a.failureRate])).toEqual([
      ['Bank line assistant', 2, 1, 50],
      ['CFO report writer', 1, 0, 0],
    ]);
    expect(p.days).toEqual([
      { date: '2026-11-20', calls: 2, failed: 1, p95Ms: 1000 },
      { date: '2026-11-21', calls: 0, failed: 0, p95Ms: null },
      { date: '2026-11-22', calls: 1, failed: 0, p95Ms: 1000 },
    ]);
    expect(aiCallDay(new Date('2026-11-19T20:00:00Z'))).toBe('2026-11-20');
  });

  it('says nothing when there were no calls', () => {
    const p = aiPerformance([], { from: '2026-11-20', to: '2026-11-21' });
    expect(p.totals).toMatchObject({ calls: 0, failed: 0, failureRate: 0, medianMs: null, p95Ms: null, slowestMs: null });
    expect(p.agents).toEqual([]);
    expect(p.days).toHaveLength(2);
  });
});
