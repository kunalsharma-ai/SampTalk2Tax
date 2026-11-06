import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import type { CopilotModel, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotService } from '../src/copilot/copilot.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Usage metering (M9 slice 5) against the real API and database. The AI model is a local
 * stand-in that always answers; nothing leaves the machine.
 */
class AnsweringModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  calls = 0;
  async send(): Promise<CopilotResponse> {
    this.calls += 1;
    return { id: `msg_${this.calls}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Cash is 0.00.', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 100 } } as unknown as CopilotResponse;
  }
}

const PDF = (n: number) => Buffer.from(`%PDF-1.4\n% receipt ${n}\n%%EOF\n`);
const model = new AnsweringModel();
let ctx: Ctx;
let owner: TestUser;
let admin: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let planId: string;
let journalId: string;

const ask = async (q: string) => {
  const r = await ctx.http().post(`${org.base}/copilot/conversations`).set(owner.auth).send({ question: q });
  await Promise.all([...ctx.app.get(CopilotService).inflight.values()]);
  return r;
};
const upload = (n: number) =>
  ctx.http().post(`${org.base}/attachments?entityType=JOURNAL_ENTRY&entityId=${journalId}&fileName=r${n}.pdf`).set(owner.auth).set('Content-Type', 'application/pdf').send(PDF(n));

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  owner = await registerUser(ctx, 'Metered Owner');
  admin = await registerUser(ctx, 'Usage Admin');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPPORT');
  org = await createOrg(ctx, owner, { name: 'Metered Traders Pvt Ltd' });
  // A small plan, so the limits are reached in a few steps.
  planId = randomUUID();
  await ctx.prisma.plan.create({ data: { id: planId, code: `TINY_${planId.slice(0, 6).toUpperCase()}`, name: 'Tiny', prices: { INR: { monthly: '1', annual: '10' }, USD: { monthly: '1', annual: '10' } }, limits: { members: null, aiCreditsPerMonth: 2, documentUploadsPerMonth: 5 }, features: ['AI', 'PAYROLL', 'MULTI_CURRENCY', 'CONSOLIDATION'], isActive: false } });
  await ctx.prisma.subscription.update({ where: { orgId: org.orgId }, data: { planId } });
  await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
  const j = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10), memo: 'Receipts', lines: [{ accountId: org.acc['1120'], debit: '10' }, { accountId: org.acc['4100'], credit: '10' }] });
  if (!j.body.id) throw new Error(JSON.stringify(j.body));
  journalId = j.body.id;
});
afterAll(async () => {
  // Leave the plan list as other suites expect it: back to a standard plan, the test plan removed.
  const growth = await ctx.prisma.plan.findUnique({ where: { code: 'GROWTH' } });
  if (growth && planId) {
    await ctx.prisma.subscription.updateMany({ where: { planId }, data: { planId: growth.id } });
    await ctx.prisma.plan.delete({ where: { id: planId } });
  }
  await ctx.app.close();
});

describe('AI requests', () => {
  it('are counted per answered model call, with tokens, and refused past the plan', async () => {
    expect((await ctx.http().get(`${org.base}/usage`).set(owner.auth).expect(200)).body.ai).toMatchObject({ used: 0, limit: 2, state: 'OK' });
    await ask('What is our cash?');
    await ask('And now?');
    const u = (await ctx.http().get(`${org.base}/usage`).set(owner.auth).expect(200)).body;
    expect(u).toMatchObject({ plan: 'Tiny', ai: { used: 2, limit: 2, remaining: 0, state: 'REACHED', inputTokens: 2000, outputTokens: 200, talk2taxKey: 2, ownKey: 0 } });
    expect(u.history[0]).toMatchObject({ month: u.month, ai: 2, tokens: 2200 });
    expect(u.days.reduce((s: number, d: { ai: number }) => s + d.ai, 0)).toBe(2);
    expect(u.days.length).toBeGreaterThanOrEqual(28);

    const before = model.calls;
    const r = await ask('Third question?');
    expect([201, 429]).toContain(r.status);
    expect(model.calls).toBe(before);
    const c = r.status === 201 ? (await ctx.http().get(`${org.base}/copilot/conversations/${r.body.id}`).set(owner.auth).expect(200)).body : null;
    if (c) expect(c.messages.at(-1)).toMatchObject({ status: 'FAILED', errorCode: 'AI_CREDITS_USED_UP' });
    else expect(r.body.error).toBe('AI_CREDITS_USED_UP');
  });
});

describe('uploads', () => {
  it('are counted and refused past the plan, without storing the file', async () => {
    for (const n of [1, 2, 3, 4]) await upload(n).expect(201);
    expect((await ctx.http().get(`${org.base}/usage`).set(owner.auth).expect(200)).body.uploads).toMatchObject({ used: 4, limit: 5, state: 'NEAR', percent: 80 });
    await upload(5).expect(201);
    const refused = await upload(6).expect(429);
    expect(refused.body).toMatchObject({ error: 'UPLOAD_LIMIT_REACHED' });
    expect(await ctx.prisma.attachment.count({ where: { orgId: org.orgId } })).toBe(5);
    // A refused or duplicate upload is not counted.
    await upload(1).expect(409);
    const u = (await ctx.http().get(`${org.base}/usage`).set(owner.auth).expect(200)).body.uploads;
    expect(u).toMatchObject({ used: 5, state: 'REACHED' });
    expect(u.bytes).toBe([1, 2, 3, 4, 5].reduce((s, n) => s + PDF(n).length, 0));
  });

  it('start again with a larger plan', async () => {
    await ctx.prisma.plan.update({ where: { id: planId }, data: { limits: { members: null, aiCreditsPerMonth: null, documentUploadsPerMonth: null } } });
    await upload(6).expect(201);
    expect((await ctx.http().get(`${org.base}/usage`).set(owner.auth).expect(200)).body.uploads).toMatchObject({ used: 6, limit: null, state: 'UNLIMITED' });
  });
});

describe('platform administration', () => {
  it('lists organisations by how full they are, for people who run Talk2Tax only', async () => {
    await ctx.http().get('/v1/admin/usage').set(owner.auth).expect(403);
    await ctx.http().get('/v1/admin/usage?month=2026-13').set(admin.auth).expect(400);
    const p = (await ctx.http().get('/v1/admin/usage').set(admin.auth).expect(200)).body;
    const row = p.organisations.find((r: { org: { id: string } }) => r.org.id === org.orgId);
    expect(row).toMatchObject({ plan: { name: 'Tiny' }, ai: { used: 2, tokens: 2200 }, uploads: { used: 6 } });
    expect(p.totals.aiCalls).toBeGreaterThanOrEqual(2);
    expect(p.months).toHaveLength(12);
  });

  it('keeps the record append-only', async () => {
    await expect(ctx.prisma.usageEvent.deleteMany({ where: { orgId: org.orgId } })).rejects.toThrow();
  });
});
