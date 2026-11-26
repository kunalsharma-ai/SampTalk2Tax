import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInOrg } from '../src/common/tenant-context';
import { aiDecisionRecords } from '../src/db/collections/ai-decision-records';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * How the AI performs (PERF-020) against the real API and database: from the decision records
 * every AI call leaves, the calls, failures and why, time taken and tokens, per agent and per
 * day, over 7, 30 or 90 days; only figures, never what the AI was given or said; audit.read only;
 * organisations kept apart.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const DAY = 86_400_000;

async function record(orgId: string, over: Record<string, unknown>) {
  const startedAt = (over.startedAt as Date) ?? new Date(Date.now() - 60_000);
  const durationMs = (over.durationMs as number) ?? 1000;
  await runInOrg(orgId, () =>
    ctx.store.collection(aiDecisionRecords).insertOne({
      agent: 'COPILOT',
      actingForUserId: null,
      keySource: 'SERVER',
      modelRequested: 'claude-opus-5-5',
      servedModel: 'claude-opus-5-5',
      promptVersion: 'aaaaaaaaaaaa',
      toolsVersion: 'bbbbbbbbbbbb',
      toolNames: [],
      dataSources: [],
      subjectType: null,
      subjectId: null,
      explanation: 'Secret explanation text that must not be shown here',
      reasoningWithheld: false,
      stopReason: 'end_turn',
      outcome: 'ANSWERED',
      errorName: null,
      inputTokens: 500,
      outputTokens: 50,
      ...over,
      startedAt,
      completedAt: new Date(startedAt.getTime() + durationMs),
      durationMs,
    } as never),
  );
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Performance Owner');
  viewer = await registerUser(ctx, 'Performance Viewer');
  org = await createOrg(ctx, owner, { name: 'AI Performance Traders' });
  other = await createOrg(ctx, owner, { name: 'Other AI Performance Co' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (let i = 1; i <= 8; i++) await record(org.orgId, { agent: 'BANK_MATCHING', durationMs: i * 500 });
  await record(org.orgId, { agent: 'BANK_MATCHING', outcome: 'FAILED', errorName: 'RateLimitError', stopReason: null, servedModel: null, inputTokens: 0, outputTokens: 0, durationMs: 120 });
  await record(org.orgId, { agent: 'BANK_MATCHING', outcome: 'FAILED', errorName: 'RateLimitError', stopReason: null, servedModel: null, inputTokens: 0, outputTokens: 0, durationMs: 90 });
  await record(org.orgId, { agent: 'CFO_SUMMARY', stopReason: 'max_tokens', durationMs: 20_000, outputTokens: 4096 });
  await record(org.orgId, { agent: 'COPILOT', startedAt: new Date(Date.now() - 20 * DAY), durationMs: 3000 });
  await record(org.orgId, { agent: 'COPILOT', startedAt: new Date(Date.now() - 60 * DAY), durationMs: 3000 });
  await record(other.orgId, { agent: 'COLLECTIONS' });
}, 60_000);
afterAll(async () => {
  await ctx?.app.close();
});

describe('AI performance', () => {
  it('sums calls, failures, times and tokens per agent over the last 7 days', async () => {
    const p = (await ctx.http().get(`${org.base}/ai-decisions/performance?days=7`).set(owner.auth).expect(200)).body;
    expect(p.window).toBe(7);
    expect(p.days).toHaveLength(7);
    expect(p.totals).toMatchObject({ calls: 11, failed: 2, failureRate: 18.2, slowestMs: 20_000, cutShort: 1, inputTokens: 4500, outputTokens: 4496 });
    expect(p.agents.map((a: { name: string; calls: number; failed: number }) => [a.name, a.calls, a.failed])).toEqual([
      ['Bank line assistant', 10, 2],
      ['CFO report writer', 1, 0],
    ]);
    const bank = p.agents[0];
    expect(bank).toMatchObject({ medianMs: 1500, p95Ms: 4000, slowestMs: 4000, failureRate: 20 });
    expect(p.failures).toEqual([expect.objectContaining({ name: 'Bank line assistant', error: 'RateLimitError', count: 2 })]);
    expect(p.slowest[0]).toMatchObject({ name: 'CFO report writer', durationMs: 20_000, outcome: 'ANSWERED' });
    expect(p.days[6]).toMatchObject({ calls: 11, failed: 2 });
    // Only figures: what the AI was given or said is never part of it.
    expect(JSON.stringify(p)).not.toContain('Secret explanation');
  });

  it('looks back 30 or 90 days, and nothing else', async () => {
    const m = (await ctx.http().get(`${org.base}/ai-decisions/performance?days=30`).set(owner.auth).expect(200)).body;
    expect(m.totals.calls).toBe(12);
    expect(m.days).toHaveLength(30);
    expect(m.agents.find((a: { name: string }) => a.name === 'Copilot')).toMatchObject({ calls: 1, medianMs: 3000 });
    expect((await ctx.http().get(`${org.base}/ai-decisions/performance?days=90`).set(owner.auth).expect(200)).body.totals.calls).toBe(13);
    expect((await ctx.http().get(`${org.base}/ai-decisions/performance`).set(owner.auth).expect(200)).body.window).toBe(30);
    await ctx.http().get(`${org.base}/ai-decisions/performance?days=365`).set(owner.auth).expect(400);
  });

  it('needs audit.read and keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/ai-decisions/performance`).set(viewer.auth).expect(403);
    const o = (await ctx.http().get(`${other.base}/ai-decisions/performance?days=7`).set(owner.auth).expect(200)).body;
    expect(o.totals.calls).toBe(1);
    expect(o.agents.map((a: { name: string }) => a.name)).toEqual(['Collections assistant']);
  });
});
